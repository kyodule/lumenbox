/**
 * Runs one RunOnHost command on this Mac for the LumenBox shell's remote mode.
 *
 * Started by electron/main.cjs as a child (ELECTRON_RUN_AS_NODE=1 --experimental-transform-types),
 * one process per command, so the shell's main process never imports the ESM TypeScript source.
 * Reads one JSON job on stdin, writes one JSON result on stdout.
 *
 * Reuses upstream's HostRunner and HostSandbox unchanged. The one deviation: when the person
 * allowed network in ~/.agentbox/host-exec.json, the Seatbelt profile loses its
 * "(deny network-outbound)" line and keeps every write rule. Upstream has no "sandbox on,
 * network open" setting, and sandbox "off" would drop the write rules too.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

interface Job {
  command: string;
  cwd: string;
  network: boolean;
  timeoutMs?: number;
  maxOutputBytes?: number;
  allowWrite?: string[];
}

const NETWORK_DENY = "(deny network-outbound)";

function expandHome(path: string): string {
  return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  // Started as node by the shell; a command that launches an Electron app must not inherit that.
  delete process.env.ELECTRON_RUN_AS_NODE;
  const appRoot = process.env.LUMENBOX_APP_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const runnerModule = join(appRoot, "src", "host", "host-runner.ts");
  const sandboxModule = join(appRoot, "src", "host", "host-sandbox.ts");
  if (!existsSync(runnerModule) || !existsSync(sandboxModule)) throw new Error(`LumenBox host modules not found under ${appRoot}`);
  const { HostRunner, hostRunnerConfig } = await import(pathToFileURL(runnerModule).href);
  const { HostSandbox } = await import(pathToFileURL(sandboxModule).href);

  const job = JSON.parse(await readStdin()) as Job;
  if (typeof job.command !== "string" || job.command.trim() === "") throw new Error("job.command is required");
  if (typeof job.cwd !== "string" || job.cwd.trim() === "") throw new Error("job.cwd is required");

  const sandbox = new HostSandbox();
  if (job.network === true) {
    const wrap = sandbox.wrap.bind(sandbox);
    sandbox.wrap = (command: string, args: readonly string[], rules: unknown) => {
      const wrapped = wrap(command, args, rules);
      if (wrapped.mechanism !== "sandbox-exec") throw new Error(`network mode only knows sandbox-exec, got ${wrapped.mechanism}`);
      const profile = wrapped.args[1];
      // Fail closed: if upstream changed the profile, refuse rather than guess what is still denied.
      if (wrapped.args[0] !== "-p" || typeof profile !== "string" || profile.split(NETWORK_DENY).length !== 2) {
        throw new Error("the upstream Seatbelt profile changed shape; refusing to open the network");
      }
      return {
        ...wrapped,
        args: ["-p", profile.replace(NETWORK_DENY, ""), ...wrapped.args.slice(2)],
        rules: wrapped.rules.map((rule: string) => (rule.startsWith("no network") || rule.startsWith("network only") ? "network open (the person allowed it on this Mac)" : rule)),
      };
    };
  }

  const runner = new HostRunner(
    hostRunnerConfig({
      enabled: true,
      cwd: expandHome(job.cwd),
      sandbox: "on",
      ...(job.timeoutMs !== undefined ? { timeoutMs: job.timeoutMs } : {}),
      ...(job.maxOutputBytes !== undefined ? { maxOutputBytes: job.maxOutputBytes } : {}),
      allowWrite: (job.allowWrite ?? []).map(expandHome),
    }),
    { sandbox }
  );
  const reason = runner.unavailableReason();
  if (reason !== undefined) {
    process.stdout.write(JSON.stringify({ refused: reason }));
    return;
  }
  const result = await runner.run(job.command);
  process.stdout.write(JSON.stringify({ result }));
}

main().catch((error: unknown) => {
  process.stdout.write(JSON.stringify({ refused: `the Mac runner failed: ${error instanceof Error ? error.message : String(error)}` }));
  process.exitCode = 1;
});
