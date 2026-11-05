/** Mac-only executor. No model calls, no RPC passthrough, no access to the UI token. */
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { homedir } from "node:os";
import { HOST_TASK_CANCELLATION, HOST_TASK_COMMAND_MS, HOST_TASK_OUTPUT_BYTES, HOST_TASK_TTL_MS, hostTaskId, type HostTaskCapabilities, type HostTaskGrant, type HostTaskResult, type HostTaskCleanup } from "../src/host/host-task-protocol.ts";

export const CODEX_TASK_VERSION = "0.166.0-alpha.5.1";
export interface TaskPolicy { capabilities: HostTaskCapabilities; runtimePath: string; storage: string; toolchainBinPaths: string[]; toolchainLibraryPaths: string[]; nodeBinary?: string }
export function loadTaskPolicy(configPath: string): TaskPolicy {
  const raw = JSON.parse(readFileSync(configPath, "utf8"));
  if (raw.enabled !== true || !hostTaskId(raw.deviceId) || !Array.isArray(raw.roots) || raw.roots.length < 1 || raw.roots.length > 8) throw new Error("Mac tasks are disabled or unconfigured");
  if (raw.cancellation !== HOST_TASK_CANCELLATION) throw new Error("Mac task policy must acknowledge managed-process cancellation; detached processes may remain");
  if (raw.runtimeVersion !== CODEX_TASK_VERSION || typeof raw.runtimePath !== "string" || !/^[a-f0-9]{64}$/.test(raw.runtimeSha256 ?? "")) throw new Error("Unqualified Codex task runtime");
  const runtimePath = realpathSync(raw.runtimePath);
  if (createHash("sha256").update(readFileSync(runtimePath)).digest("hex") !== raw.runtimeSha256) throw new Error("Codex runtime changed; requalify before enabling tasks");
  const canonicalPath = (p: unknown) => {
    if (typeof p !== "string" || !p.startsWith("/") || p.length > 500 || /[\x00-\x1f]/.test(p)) throw new Error("Task paths must be absolute local paths");
    return realpathSync(p);
  };
  const roots = raw.roots.map((p: unknown) => {
    const root = canonicalPath(p);
    if (!statSync(root).isDirectory() || root === "/" || root === homedir() || isWithin(root, configPath) || isWithin(root, runtimePath)) throw new Error("Choose a project, excluding the broker and runtime");
    return root;
  });
  const controlRoot = realpathSync(dirname(configPath));
  const storage = join(controlRoot, "host-task-data");
  if (!Array.isArray(raw.toolchainReadPaths ?? []) || (raw.toolchainReadPaths?.length ?? 0) > 64 || !Array.isArray(raw.toolchainBinPaths ?? []) || (raw.toolchainBinPaths?.length ?? 0) > 16) throw new Error("Invalid local toolchain ceiling");
  const toolchainReadPaths: string[] = [...new Set<string>((raw.toolchainReadPaths ?? []).map(canonicalPath))];
  for (const path of toolchainReadPaths) {
    const resolved = canonicalPath(path);
    if (resolved === "/" || resolved === homedir() || isWithin(resolved, controlRoot) || isWithin(controlRoot, resolved) || isWithin(resolved, runtimePath) ||
        roots.some((root: string) => isWithin(resolved, root) || isWithin(root, resolved))) throw new Error("Toolchain reads must not include projects, the home directory, executor or its control data");
  }
  const toolchainBinPaths: string[] = [...new Set<string>((raw.toolchainBinPaths ?? []).map(canonicalPath))];
  if (!Array.isArray(raw.toolchainLibraryPaths ?? []) || (raw.toolchainLibraryPaths?.length ?? 0) > 32) throw new Error("Invalid toolchain library paths");
  const toolchainLibraryPaths: string[] = [...new Set<string>((raw.toolchainLibraryPaths ?? []).map(canonicalPath))];
  for (const path of [...toolchainBinPaths, ...toolchainLibraryPaths]) if (path.includes(":") || !statSync(path).isDirectory() || !toolchainReadPaths.some(root => isWithin(root, path))) throw new Error("Toolchain PATH must be inside a locally allowed read-only toolchain");
  const nodeBinary = raw.nodeBinary === undefined ? undefined : canonicalPath(raw.nodeBinary);
  if (nodeBinary && (!statSync(nodeBinary).isFile() || !toolchainReadPaths.some(root => isWithin(root, nodeBinary)))) throw new Error("Node binary exceeds the local toolchain ceiling");
  mkdirSync(storage, { recursive: true, mode: 0o700 });
  const policyVersion = createHash("sha256").update(JSON.stringify({ ...raw, roots, runtimePath, toolchainReadPaths, toolchainBinPaths, toolchainLibraryPaths, nodeBinary })).digest("hex");
  return { capabilities: { protocol: 1, deviceId: raw.deviceId, policyVersion, roots, runtime: CODEX_TASK_VERSION,
    cancellation: HOST_TASK_CANCELLATION, toolchainReadPaths }, runtimePath, storage, toolchainBinPaths, toolchainLibraryPaths, nodeBinary };
}
export function isWithin(root: string, path: string): boolean { const r = relative(root, path); return r === "" || (r !== ".." && !r.startsWith(`..${sep}`) && !r.startsWith(sep)); }

// Copies do not carry hooks, credentials, symlinks, hard links or socket endpoints. These are
// deliberately not Git worktrees: .git/worktrees would give a command authority over the source.
const OMIT = /^(?:\.git|\.ssh|\.aws|\.azure|\.config|\.codex|\.agentbox.*|\.env(?:\..*)?|\.npmrc|\.netrc|\.pypirc|auth\.json|credentials(?:\.json)?|id_rsa.*|id_ed25519.*|.*\.(?:pem|key|p12|pfx))$/i;
export function snapshotProject(root: string, target: string): { files: number; bytes: number; skipped: number } {
  const totals = { files: 0, bytes: 0, skipped: 0 };
  const copy = (source: string, dest: string, depth: number) => {
    if (depth > 40) throw new Error("Project exceeds snapshot depth limit");
    const st = lstatSync(source);
    if (st.isSymbolicLink() || (!st.isDirectory() && (!st.isFile() || st.nlink !== 1))) { totals.skipped++; return; }
    if (st.isDirectory()) {
      mkdirSync(dest, { recursive: true, mode: 0o700 });
      for (const name of readdirSync(source)) {
        if (OMIT.test(name)) { totals.skipped++; continue; }
        copy(join(source, name), join(dest, name), depth + 1);
      }
    } else {
      totals.files++; totals.bytes += st.size;
      if (totals.files > 30_000 || totals.bytes > 300_000_000) throw new Error("Project exceeds 30000 files / 300 MB snapshot ceiling; choose a smaller project");
      // O_NOFOLLOW plus a second inode check closes a source replacement during snapshotting.
      const fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const data = readFileSync(fd);
        const after = lstatSync(source);
        if (after.ino !== st.ino || after.dev !== st.dev || after.nlink !== 1 || data.length !== st.size) throw new Error("Project changed during snapshot; retry authorization");
        writeFileSync(dest, data, { mode: st.mode & 0o100 ? 0o700 : 0o600, flag: "wx" });
      } finally { closeSync(fd); }
    }
  };
  if (isWithin(root, target)) throw new Error("Snapshot cannot be inside its source project");
  copy(root, target, 0);
  return totals;
}

export interface LocalTask { grant: HostTaskGrant; workspace: string; temp: string; control: string; tools: string; closed: boolean; executor?: CodexCommand; cleanup?: HostTaskCleanup }
export function createLocalTask(policy: TaskPolicy, grant: HostTaskGrant, now = Date.now()): LocalTask {
  if (!hostTaskId(grant.taskId) || !hostTaskId(grant.grantId) || typeof grant.agentId !== "string" || !grant.agentId ||
      !grant.principalId || !grant.conversation || grant.deviceId !== policy.capabilities.deviceId || grant.policyVersion !== policy.capabilities.policyVersion ||
      grant.network !== false || grant.cancellation !== HOST_TASK_CANCELLATION || !["read", "write"].includes(grant.access) || !policy.capabilities.roots.includes(grant.root) ||
      !Number.isFinite(grant.expiresAt) || grant.expiresAt <= now || grant.expiresAt > now + HOST_TASK_TTL_MS + 1000) throw new Error("Task grant exceeds this Mac's policy");
  if (realpathSync(grant.root) !== grant.root) throw new Error("Project root changed");
  const base = join(policy.storage, grant.taskId);
  if (existsSync(base)) throw new Error("Task already exists; an old grant cannot reopen it");
  mkdirSync(base, { mode: 0o700 });
  const workspace = join(base, "project"), temp = join(base, "tmp"), control = join(base, "control"), tools = join(base, "tools");
  mkdirSync(temp, { mode: 0o700 }); mkdirSync(control, { mode: 0o700 }); mkdirSync(tools, { mode: 0o700 });
  if (policy.nodeBinary) {
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    // SIP clears DYLD_* when /bin/sh or /usr/bin/env starts. Set it inside a read-only
    // Node launcher, after that boundary, to use the pinned library directories directly.
    // Never grant the package manager's whole opt/etc tree to satisfy dyld or OpenSSL.
    writeFileSync(join(tools, "node"), `#!/bin/sh\nexport DYLD_LIBRARY_PATH=${quote(policy.toolchainLibraryPaths.join(":"))}\nexport OPENSSL_CONF=/dev/null\nexec ${quote(policy.nodeBinary)} "$@"\n`, { mode: 0o700 });
  }
  const snapshot = snapshotProject(grant.root, workspace);
  writeFileSync(join(control, "task.json"), JSON.stringify({ grant, snapshot, workspace }), { mode: 0o600 });
  return { grant, workspace, temp, control, tools, closed: false };
}

/** Exact positive environment; personal shell startup, proxies and tokens are never inherited. */
export function taskEnvironment(task: LocalTask, policy: TaskPolicy): Record<string, string> {
  return { PATH: [task.tools, ...policy.toolchainBinPaths, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"), LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8",
    HOME: task.temp, TMPDIR: task.temp, CODEX_HOME: task.control, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
}
export function profileFor(task: LocalTask, policy: TaskPolicy): Record<string, string> {
  return { ":root": "deny", ":minimal": "read", ":tmpdir": "deny", ":slash_tmp": "deny",
    ...Object.fromEntries(policy.capabilities.toolchainReadPaths.map(path => [path, "read"])),
    [task.workspace]: task.grant.access === "write" ? "write" : "read", [task.temp]: "write", [task.tools]: "read", [task.control]: "deny" };
}
export function clipOutput(stdout: string, stderr: string): Pick<HostTaskResult, "stdout" | "stderr" | "truncated"> {
  const out = Buffer.from(stdout), err = Buffer.from(stderr), half = HOST_TASK_OUTPUT_BYTES / 2;
  const take = (b: Buffer) => b.length <= half ? b.toString("utf8") : b.subarray(0, half - 4).toString("utf8");
  return { stdout: take(out), stderr: take(err), truncated: out.length + err.length > HOST_TASK_OUTPUT_BYTES || out.length > half || err.length > half };
}

export class CodexCommand {
  private child?: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private pending = new Map<number, { resolve: (result: any) => void; reject: (error: Error) => void }>();
  private stopped = false;
  private stopping?: Promise<HostTaskCleanup>;
  private processId = "";
  private commandFinished = false;
  private stderr = "";
  private rpc(method: "initialize" | "command/exec" | "command/exec/terminate", params: unknown): Promise<any> {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child!.stdin.write(`${JSON.stringify({ id, method, params })}\n`, error => { if (error) { this.pending.delete(id); reject(error); } });
    });
  }
  async run(policy: TaskPolicy, task: LocalTask, command: string, timeoutMs = HOST_TASK_COMMAND_MS): Promise<HostTaskResult> {
    if (task.closed || task.grant.expiresAt <= Date.now() || this.stopped) throw new Error("Task has expired or been revoked");
    const env = taskEnvironment(task, policy);
    const actualVersion = execFileSync(policy.runtimePath, ["--version"], { encoding: "utf8", timeout: 5000, env }).trim();
    if (actualVersion !== `codex-cli ${CODEX_TASK_VERSION}`) throw new Error("Codex runtime version is not qualified");
    const inline = `{${Object.entries(profileFor(task, policy)).map(([key, value]) => `${JSON.stringify(key)}=${JSON.stringify(value)}`).join(",")}}`;
    // Codex installs the single Seatbelt profile. macOS rejects nested sandbox_apply; do not
    // silently disable its filesystem sandbox to add a second fence. Qualification tests IPC.
    this.child = spawn(policy.runtimePath, ["-c", "analytics.enabled=false", "-c", "check_for_update_on_startup=false",
      "-c", 'default_permissions="lumen_task"', "-c", `permissions.lumen_task.filesystem=${inline}`, "-c", "permissions.lumen_task.network.enabled=false", "app-server", "--stdio"],
    { env, cwd: task.workspace, stdio: ["pipe", "pipe", "pipe"], detached: true });
    let buffer = "";
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 2_000_000) { void this.stop(); return; }
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        try {
          const message = JSON.parse(line);
          const request = this.pending.get(message.id);
          if (!request) continue;
          this.pending.delete(message.id);
          if (message.error) request.reject(new Error(`Codex command refused: ${JSON.stringify(message.error).slice(0, 1000)}`));
          else request.resolve(message.result);
        } catch { void this.stop(); }
      }
    });
    this.child.stderr.on("data", chunk => { this.stderr = (this.stderr + chunk.toString("utf8")).slice(-2000); });
    const failed = (error: Error) => { for (const entry of this.pending.values()) entry.reject(error); this.pending.clear(); };
    this.child.stdin.on("error", failed);
    this.child.on("error", failed);
    this.child.on("exit", () => failed(new Error(`Codex executor closed${this.stderr ? `: ${this.stderr}` : ""}`)));
    const deadline = Math.min(Math.max(100, timeoutMs), HOST_TASK_COMMAND_MS, task.grant.expiresAt - Date.now());
    const watchdog = setTimeout(() => { void this.stop(); }, deadline + 5000);
    try {
      await this.rpc("initialize", { clientInfo: { name: "lumenbox_host_task", version: "1" }, capabilities: { experimentalApi: true } });
      this.child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
      if (this.stopped) throw new Error("Task cancelled during executor startup");
      this.processId = `lumen-${task.grant.taskId}`;
      const result = await this.rpc("command/exec", { command: ["/bin/sh", "-c", command], cwd: task.workspace, permissionProfile: "lumen_task",
        processId: this.processId, timeoutMs: deadline, outputBytesCap: HOST_TASK_OUTPUT_BYTES, env });
      this.commandFinished = true;
      const cancelled = this.stopped;
      return { state: cancelled ? "cancelled" : "completed", exitCode: result.exitCode, ...clipOutput(String(result.stdout ?? ""), String(result.stderr ?? "")), cleanup: await this.stop() };
    } finally { clearTimeout(watchdog); await this.stop(); }
  }
  stop(): Promise<HostTaskCleanup> {
    if (this.stopping) return this.stopping;
    this.stopped = true;
    this.stopping = this.terminate(); return this.stopping;
  }
  private async terminate(): Promise<HostTaskCleanup> {
    const child = this.child;
    const cleanup: HostTaskCleanup = { managedProcesses: "stopped", detachedProcesses: "may-remain" };
    if (!child?.pid) return cleanup;
    const pgid = child.pid;
    const kill = () => { try { process.kill(-pgid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") cleanup.managedProcesses = "unconfirmed"; } };
    const killTimer = setTimeout(kill, 1000);
    let sessionStopped = !this.processId || this.commandFinished;
    try {
      if (!sessionStopped && child.exitCode === null) sessionStopped = await Promise.race([
        this.rpc("command/exec/terminate", { processId: this.processId }).then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 500))]);
    } catch (error) { cleanup.detail = error instanceof Error ? error.message.slice(0, 500) : "Termination request failed"; }
    finally {
      kill(); clearTimeout(killTimer);
      // Observe only our managed group; a process that called setsid is outside this guarantee.
      // Bound this wait so a failed signal cannot block revocation or the stop receipt forever.
      let groupGone = false;
      for (let i = 0; i < 20; i++) {
        try { process.kill(-pgid, 0); }
        catch (error) { groupGone = (error as NodeJS.ErrnoException).code === "ESRCH"; break; }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      if (!groupGone || (!sessionStopped && !this.commandFinished)) {
        cleanup.managedProcesses = "unconfirmed";
        cleanup.detail ??= !groupGone ? "Managed executor process group exit was not confirmed" : "Command completion or termination request was not acknowledged";
      } else delete cleanup.detail;
      for (const request of this.pending.values()) request.reject(new Error("Managed command stopped; detached processes may remain"));
      this.pending.clear();
    }
    return cleanup;
  }
}
