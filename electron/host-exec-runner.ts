/**
 * One RunOnHost command on this Mac, in two phases (LUMENBOX-FORK).
 *
 * Started by electron/main.cjs as a child (ELECTRON_RUN_AS_NODE=1 --experimental-transform-types),
 * one process per phase, so the shell's main process never imports the ESM TypeScript source.
 * It reads one JSON job on stdin and writes one JSON object on stdout:
 *
 *   {phase: "decide", command, mode, allow}   → src/host/mac-approval.ts's answer, verbatim:
 *                                               {kind: "auto"|"ask"|"refuse", ...}.
 *   {phase: "run", command, cwd?, timeoutMs?, maxOutputBytes?}
 *                                             → {result: {stdout, stderr, code, timedOut,
 *                                               truncatedBytes}}, or {refused: "..."} when it
 *                                               could not be started.
 *
 * Two phases rather than one because the decision is TypeScript shared with the server's tests
 * while the dialog is Electron's: main.cjs asks what to do, shows what the answer asks for, and
 * only then asks for the run.
 *
 * There is no sandbox and no working-directory rule here, on purpose. The command runs through
 * the person's own login shell, as them, from their home directory, so `command -v codex` finds
 * what their terminal finds. What stops a command is the dialog before it, and nothing else.
 */
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { MacAllowEntry, MacApprovalMode } from "../src/host/mac-approval.ts";

interface DecideJob {
  phase: "decide";
  command: string;
  mode: MacApprovalMode;
  allow?: MacAllowEntry[];
}

interface RunJob {
  phase: "run";
  command: string;
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
  truncatedBytes: number;
}

function expandHome(path: string): string {
  return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** Output kept up to the cap, and how much was dropped after it, counted in bytes. */
function capped(cap: number) {
  const kept: Buffer[] = [];
  let size = 0;
  let dropped = 0;
  return {
    push(chunk: Buffer): void {
      const room = cap - size;
      if (room <= 0) {
        dropped += chunk.length;
        return;
      }
      kept.push(chunk.length <= room ? chunk : chunk.subarray(0, room));
      size += Math.min(chunk.length, room);
      dropped += Math.max(0, chunk.length - room);
    },
    text(): string {
      return Buffer.concat(kept).toString("utf8");
    },
    dropped(): number {
      return dropped;
    },
  };
}

/** The login shell, because that is where the person's `codex`, `node` and `PATH` are. */
function runCommand(job: RunJob): Promise<RunResult> {
  const timeoutMs = Math.min(Math.max(Number(job.timeoutMs) || 300_000, 1_000), 1_800_000);
  const cap = Math.min(Math.max(Number(job.maxOutputBytes) || 200_000, 1_000), 5_000_000);
  const shell = process.env.SHELL || "/bin/zsh";
  const cwd = typeof job.cwd === "string" && job.cwd.trim() !== "" ? expandHome(job.cwd.trim()) : homedir();
  return new Promise(resolve => {
    const child = spawn(shell, ["-lc", job.command], { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const stdout = capped(cap);
    const stderr = capped(cap);
    let timedOut = false;
    let done = false;
    const finish = (code: number | null): void => {
      if (done) return;
      done = true;
      clearTimeout(killer);
      clearTimeout(reaper);
      resolve({ stdout: stdout.text(), stderr: stderr.text(), code, timedOut, truncatedBytes: stdout.dropped() + stderr.dropped() });
    };
    // The whole group, so a pipeline's children die with the shell instead of holding the pipes.
    const kill = (): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {}
      }
    };
    const killer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    // A grandchild that survived can keep `close` from ever arriving; this is the reaping.
    const reaper = setTimeout(() => {
      if (done) return;
      kill();
      finish(null);
    }, timeoutMs + 5_000);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", error => {
      if (done) return;
      done = true;
      clearTimeout(killer);
      clearTimeout(reaper);
      resolve({ stdout: stdout.text(), stderr: `${stderr.text()}could not start ${shell}: ${error.message}`, code: 127, timedOut, truncatedBytes: stdout.dropped() + stderr.dropped() });
    });
    child.on("close", code => finish(code));
  });
}

async function main(): Promise<void> {
  // Started as node by the shell; a command that launches an Electron app must not inherit that.
  delete process.env.ELECTRON_RUN_AS_NODE;
  const appRoot = process.env.LUMENBOX_APP_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const job = JSON.parse(await readStdin()) as DecideJob | RunJob;
  if (typeof job.command !== "string" || job.command.trim() === "") throw new Error("job.command is required");

  if (job.phase === "decide") {
    const module = await import(pathToFileURL(join(appRoot, "src", "host", "mac-approval.ts")).href);
    // A hand-edited allow list is the person's own file: a broken entry is ignored, not fatal.
    const allow = (Array.isArray(job.allow) ? job.allow : []).filter(
      (one: unknown): one is MacAllowEntry =>
        typeof one === "object" && one !== null && Array.isArray((one as MacAllowEntry).prefix) && (one as MacAllowEntry).prefix.every(word => typeof word === "string")
    );
    const decision = module.decideApproval(job.command, { mode: job.mode, allow });
    process.stdout.write(JSON.stringify(decision));
    return;
  }
  if (job.phase === "run") {
    process.stdout.write(JSON.stringify({ result: await runCommand(job) }));
    return;
  }
  throw new Error("job.phase must be decide or run");
}

main().catch((error: unknown) => {
  // For a decide job this is read as "refuse": a decision that cannot be computed must never run.
  process.stdout.write(JSON.stringify({ refused: `the Mac runner failed: ${error instanceof Error ? error.message : String(error)}` }));
  process.exitCode = 1;
});