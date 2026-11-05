/** One broker per App connection. Stdin carries only our jobs, never generic Codex RPC. */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { hostTaskId, HOST_TASK_PROTOCOL, HOST_TASK_WIRE_BYTES, HOST_TASK_STOP_NOTICE, type HostTaskAnswer, type HostTaskJob, type HostTaskResult } from "../src/host/host-task-protocol.ts";
import { CodexCommand, createLocalTask, loadTaskPolicy, type LocalTask, type TaskPolicy } from "./host-task-runtime.ts";

export class HostTaskWorker {
  readonly policy: TaskPolicy;
  private readonly tasks = new Map<string, LocalTask>();
  private readonly jobs = new Set<string>();
  private readonly running = new Set<string>();
  private sessionId = "";
  private stopped = false;
  private stopping?: Promise<void>;
  constructor(private readonly configPath: string, private readonly emit: (message: unknown) => void) {
    this.policy = loadTaskPolicy(configPath);
    mkdirSync(join(this.policy.storage, "results"), { recursive: true, mode: 0o700 });
  }
  hello(sessionId: unknown): void {
    if (this.sessionId || !hostTaskId(sessionId)) throw new Error("Invalid task session");
    this.sessionId = sessionId;
    this.drain();
  }
  /** Only receipts cross a reconnect. A new connection never resumes an old task. */
  drain(): void {
    for (const file of readdirSync(join(this.policy.storage, "results"))) {
      if (!file.endsWith(".json")) continue;
      const path = join(this.policy.storage, "results", file);
      if (existsSync(`${path}.ack`)) continue;
      const receipt = JSON.parse(readFileSync(path, "utf8"));
      if (receipt.deviceId === this.policy.capabilities.deviceId) this.emit(receipt);
    }
  }
  acknowledge(id: unknown): void {
    if (!hostTaskId(id)) return;
    const path = this.resultPath(id);
    if (existsSync(path)) writeFileSync(`${path}.ack`, "acknowledged", { mode: 0o600 });
  }
  private answer(job: HostTaskJob, result?: HostTaskResult): HostTaskAnswer {
    return { id: job.id, sessionId: job.sessionId, deviceId: this.policy.capabilities.deviceId, grantId: job.grant.grantId,
      event: result ? "result" : "started", ...(result ? { result } : {}) };
  }
  private resultPath(id: string): string { return join(this.policy.storage, "results", `${id}.json`); }
  private store(job: HostTaskJob, result: HostTaskResult, send = true): void {
    const answer = this.answer(job, result);
    const payload = JSON.stringify(answer);
    if (Buffer.byteLength(payload) > HOST_TASK_WIRE_BYTES) throw new Error("Result exceeds wire budget");
    const file = `${this.resultPath(job.id)}${send ? "" : ".pending"}`;
    writeFileSync(`${file}.tmp`, payload, { mode: 0o600 }); renameSync(`${file}.tmp`, file);
    if (send) this.emit(answer);
  }
  async handle(raw: unknown): Promise<void> {
    const job = raw as HostTaskJob;
    if (this.stopped || !job || job.protocol !== HOST_TASK_PROTOCOL || !hostTaskId(job.id) || !job.grant || !hostTaskId(job.grant.grantId) ||
        !hostTaskId(job.grant.taskId) || job.sessionId !== this.sessionId) return;
    if (this.running.has(job.id)) { this.emit(this.answer(job)); return; }
    // Never rerun an uncertain command, including after a worker restart. Only resend its receipt.
    if (existsSync(this.resultPath(job.id))) {
      const old = JSON.parse(readFileSync(this.resultPath(job.id), "utf8"));
      if (old.sessionId === job.sessionId && old.grantId === job.grant.grantId) this.emit(old);
      return;
    }
    if (existsSync(`${this.resultPath(job.id)}.pending`)) { this.emit(JSON.parse(readFileSync(`${this.resultPath(job.id)}.pending`, "utf8"))); return; }
    if (this.jobs.has(job.id)) { this.emit(this.answer(job)); return; }
    if (this.jobs.size >= 512 && job.action !== "cancel" && job.action !== "finish") { this.emit(this.answer(job, { state: "failed", error: "Connection command limit reached" })); return; }
    this.jobs.add(job.id);
    this.running.add(job.id);
    this.store(job, { state: "unknown", error: "Job accepted; final result not yet recorded. Never replay automatically." }, false);
    // The durable unknown receipt above is local only; the server receives started then the final result.
    let result: HostTaskResult;
    try {
      if (job.grant.deviceId !== this.policy.capabilities.deviceId || job.grant.policyVersion !== this.policy.capabilities.policyVersion) throw new Error("Grant is for another device or policy");
      let task = this.tasks.get(job.grant.taskId);
      if (task && JSON.stringify(task.grant) !== JSON.stringify(job.grant)) throw new Error("Task grant changed");
      if (job.action === "cancel" || job.action === "finish") {
        // Revocation does not depend on reloading a policy file or re-hashing an updated runtime.
        if (task) await this.closeTask(task);
        else {
          const tombstone = join(this.policy.storage, job.grant.taskId);
          mkdirSync(tombstone, { recursive: true, mode: 0o700 });
        }
        result = { state: job.action === "cancel" ? "cancelled" : "completed", authorization: "revoked", workspace: task?.workspace,
          cleanup: task?.cleanup ?? { managedProcesses: "stopped", detachedProcesses: "may-remain" }, notice: HOST_TASK_STOP_NOTICE };
      } else {
        let current: TaskPolicy;
        try { current = loadTaskPolicy(this.configPath); }
        catch (error) { await this.stop(); throw error; }
        if (current.capabilities.policyVersion !== this.policy.capabilities.policyVersion) { await this.stop(); throw new Error("Local task policy changed"); }
        if (!Number.isFinite(job.startBefore) || job.startBefore < Date.now() || job.startBefore > Date.now() + 31_000 || job.grant.expiresAt <= Date.now()) throw new Error("Job start deadline or task authorization expired");
        if (job.action === "start") {
          if ([...this.tasks.values()].some(t => !t.closed)) throw new Error("Another Mac task is active; finish or cancel it first");
          task = createLocalTask(this.policy, job.grant); this.tasks.set(job.grant.taskId, task);
          result = { state: "active", authorization: "active", workspace: task.workspace };
        } else if (job.action === "run") {
          if (!task || task.closed || task.executor) throw new Error("Task unavailable or busy");
          if (typeof job.command !== "string" || !job.command.trim() || Buffer.byteLength(job.command) > 16_000) throw new Error("Invalid task command");
          this.emit(this.answer(job));
          const executor = task.executor = new CodexCommand();
          try { result = await executor.run(this.policy, task, job.command, job.timeoutMs); }
          finally {
            const cleanup = await executor.stop();
            task.cleanup = task.cleanup?.managedProcesses === "unconfirmed" ? task.cleanup : cleanup;
            task.executor = undefined;
          }
          result.authorization = task.closed ? "revoked" : "active";
        } else if (job.action === "status") {
          result = { state: task && !task.closed ? "active" : "cancelled", authorization: task && !task.closed ? "active" : "revoked", workspace: task?.workspace, cleanup: task?.cleanup };
        } else throw new Error("Unsupported task action");
      }
    } catch (error) {
      const task = this.tasks.get(job.grant.taskId);
      result = { state: task?.closed ? "cancelled" : "failed", authorization: task && !task.closed ? "active" : "revoked", cleanup: task?.cleanup,
        ...(task?.closed ? { notice: HOST_TASK_STOP_NOTICE } : {}), error: error instanceof Error ? error.message : String(error) };
    }
    this.store(job, result); this.running.delete(job.id);
  }
  async expire(): Promise<void> {
    await Promise.all([...this.tasks.values()].filter(task => !task.closed && task.grant.expiresAt <= Date.now()).map(task => this.closeTask(task)));
  }
  private async closeTask(task: LocalTask): Promise<void> {
    task.closed = true; // Synchronous, before waiting for process cleanup.
    const cleanup = await task.executor?.stop();
    task.cleanup = task.cleanup?.managedProcesses === "unconfirmed" ? task.cleanup : cleanup ?? task.cleanup ?? { managedProcesses: "stopped", detachedProcesses: "may-remain" };
    writeFileSync(join(task.control, "stopped.json"), JSON.stringify({ taskId: task.grant.taskId, authorization: "revoked", cleanup: task.cleanup, workspace: task.workspace,
      stoppedAt: Date.now(), notice: HOST_TASK_STOP_NOTICE }), { mode: 0o600 });
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopped = true;
    this.stopping = Promise.all([...this.tasks.values()].map(task => this.closeTask(task))).then(() => {});
    return this.stopping;
  }
}

async function main(): Promise<void> {
  const configPath = process.argv[2];
  if (!configPath) throw new Error("Host task configuration required");
  const emit = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const worker = new HostTaskWorker(configPath, emit);
  emit({ type: "ready", capabilities: worker.policy.capabilities });
  let heartbeat = Date.now();
  let shuttingDown: Promise<void> | undefined;
  const shutdown = () => shuttingDown ??= (async () => { await worker.stop(); process.exit(0); })();
  const interval = setInterval(() => { if (Date.now() - heartbeat > 35_000) void shutdown(); else void worker.expire(); }, 1000);
  interval.unref();
  const lines = createInterface({ input: process.stdin });
  lines.on("line", line => {
    if (Buffer.byteLength(line) > 32_000) { void shutdown(); return; }
    try {
      const message = JSON.parse(line);
      if (message.type === "hello") worker.hello(message.sessionId);
      else if (message.type === "heartbeat") heartbeat = Date.now();
      else if (message.type === "ack") worker.acknowledge(message.id);
      else if (message.type === "drain") worker.drain();
      else if (message.type === "job") void worker.handle(message.job).catch(() => { void shutdown(); });
      else if (message.type === "stop") void shutdown();
    } catch { void shutdown(); }
  });
  lines.on("close", () => { void shutdown(); });
  process.on("SIGTERM", () => { void shutdown(); });
  process.on("SIGINT", () => { void shutdown(); });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main().catch(error => {
  process.stdout.write(`${JSON.stringify({ type: "unavailable", error: error.message })}\n`); process.exitCode = 1;
});
