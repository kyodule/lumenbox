/** Task grants belong to a principal, agent, conversation and one live device connection. */
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { capabilitiesOf, HOST_TASK_CANCELLATION, HOST_TASK_STOP_NOTICE, unconfirmedCleanup, HOST_TASK_PROTOCOL, HOST_TASK_COMMAND_MS, HOST_TASK_START_MS, HOST_TASK_TTL_MS, HOST_TASK_WIRE_BYTES,
  type HostTaskCapabilities, type HostTaskOwner, type HostTaskGrant, type HostTaskJob, type HostTaskAnswer, type HostTaskResult } from "./host-task-protocol.ts";

export interface HostTaskRecord {
  grant: HostTaskGrant;
  state: "proposed" | "starting" | "active" | "completed" | "cancelled" | "unknown";
  proposedAt: number;
  sessionId: string;
  workspace?: string;
  busy: boolean;
  jobs: { id: string; action: string; state: string; result?: HostTaskResult }[];
}
const ownerKey = (owner: HostTaskOwner) => JSON.stringify([owner.principalId, owner.agentId, owner.conversation]);
export class DesktopHostTasks {
  private seat?: { id: string; caps: HostTaskCapabilities; write: (frame: string) => void; close: () => void };
  private readonly tasks = new Map<string, HostTaskRecord>();
  private readonly pending = new Map<string, { job: HostTaskJob; record: HostTaskRecord; timer: ReturnType<typeof setTimeout>;
    resolve: (result: HostTaskResult) => void; reject: (error: Error) => void }>();
  private readonly answers = new Map<string, HostTaskAnswer>();
  constructor(private readonly now: () => number = Date.now) {}
  get capabilities(): HostTaskCapabilities | undefined { return this.seat?.caps; }
  get available(): boolean { return !!this.seat || this.tasks.size > 0; }
  attach(caps: HostTaskCapabilities, write: (frame: string) => void, close: () => void = () => {}): string {
    if (!capabilitiesOf(caps)) throw new Error("Unsupported Mac task capabilities");
    this.disconnect();
    const id = randomUUID();
    this.seat = { id, caps, write, close };
    write(`data: ${JSON.stringify({ type: "hello", protocol: HOST_TASK_PROTOCOL, sessionId: id })}\n\n`);
    return id;
  }
  disconnect(sessionId = this.seat?.id): void {
    if (sessionId !== this.seat?.id || !this.seat) return;
    const seat = this.seat;
    this.seat = undefined;
    try { seat.close(); } catch { /* the socket may already be gone */ }
    for (const task of this.tasks.values()) if (task.sessionId === sessionId && !["completed", "cancelled"].includes(task.state)) task.state = "unknown";
    for (const [id, item] of this.pending) {
      if (item.job.sessionId !== sessionId) continue;
      clearTimeout(item.timer); this.pending.delete(id);
      item.reject(new Error(`Mac disconnected; job ${id} result is unknown. Use HostTask status; never replay the command automatically.`));
    }
  }
  propose(owner: HostTaskOwner, input: Record<string, unknown>): HostTaskRecord {
    const seat = this.seat;
    if (!seat) throw new Error("Mac task execution is not connected or configured");
    const { root, purpose, access } = input;
    if (typeof root !== "string" || !seat.caps.roots.includes(root)) throw new Error(`Choose an exact locally allowed project: ${seat.caps.roots.join(", ")}`);
    if (typeof purpose !== "string" || purpose.trim().length < 3 || purpose.length > 300) throw new Error("purpose must describe this task in 3–300 characters");
    if (access !== "read" && access !== "write") throw new Error("access must be read or write");
    for (const task of this.tasks.values()) {
      if (task.sessionId === seat.id && ownerKey(task.grant) === ownerKey(owner) && task.grant.root === root && task.grant.access === access &&
          task.grant.purpose === purpose && task.proposedAt + 10 * 60_000 > this.now() && task.state === "proposed") return task;
    }
    if (this.tasks.size >= 256) {
      for (const [id, task] of this.tasks) if (["completed", "cancelled", "unknown"].includes(task.state)) this.tasks.delete(id);
      if (this.tasks.size >= 256) throw new Error("Too many task proposals; finish existing tasks first");
    }
    const grant: HostTaskGrant = { ...owner, taskId: randomUUID(), grantId: randomUUID(), deviceId: seat.caps.deviceId, policyVersion: seat.caps.policyVersion,
      root, purpose, access, expiresAt: this.now() + HOST_TASK_TTL_MS, network: false, cancellation: HOST_TASK_CANCELLATION };
    const task: HostTaskRecord = { grant, state: "proposed", proposedAt: this.now(), sessionId: seat.id, busy: false, jobs: [] };
    this.tasks.set(grant.taskId, task);
    return task;
  }
  get(owner: HostTaskOwner, taskId: unknown): HostTaskRecord {
    const task = typeof taskId === "string" ? this.tasks.get(taskId) : undefined;
    if (!task || ownerKey(task.grant) !== ownerKey(owner)) throw new Error("No task for this person, agent and conversation");
    return task;
  }
  private live(task: HostTaskRecord): void {
    if (task.sessionId !== this.seat?.id || task.grant.expiresAt <= this.now()) {
      if (["proposed", "starting", "active"].includes(task.state)) task.state = "unknown";
      throw new Error("Task expired or its Mac connection changed; authorize a new task");
    }
    if (task.grant.policyVersion !== this.seat.caps.policyVersion) throw new Error("Mac policy changed; authorize a new task");
  }
  async start(task: HostTaskRecord): Promise<HostTaskResult> {
    this.live(task);
    if (task.state !== "proposed") throw new Error("This task authorization has already been used");
    task.state = "starting";
    try {
      const result = await this.send(task, "start");
      if (task.state !== "starting") return { state: "cancelled", authorization: "revoked", notice: HOST_TASK_STOP_NOTICE, error: "Task revoked while the Mac was starting" };
      task.state = result.state === "active" ? "active" : "cancelled";
      task.workspace = result.workspace;
      return result;
    } catch (error) { if (task.state === "starting") task.state = "unknown"; throw error; }
  }
  async run(task: HostTaskRecord, command: unknown): Promise<HostTaskResult> {
    this.live(task);
    if (task.state !== "active" || task.busy) throw new Error("Task is not active or another command is still running");
    if (typeof command !== "string" || !command.trim() || Buffer.byteLength(command) > 16_000) throw new Error("command must be nonempty and at most 16000 bytes");
    task.busy = true;
    try { return await this.send(task, "run", command); }
    finally { task.busy = false; }
  }
  async end(task: HostTaskRecord, action: "cancel" | "finish"): Promise<HostTaskResult> {
    task.state = action === "cancel" ? "cancelled" : "completed"; // revoke before waiting for the Mac
    const revoked: HostTaskResult = { state: task.state, authorization: "revoked", workspace: task.workspace, notice: HOST_TASK_STOP_NOTICE };
    if (task.sessionId !== this.seat?.id) return { ...revoked, cleanup: unconfirmedCleanup(), error: "Mac is disconnected; process cleanup could not be confirmed" };
    try { const result = await this.send(task, action); return { ...result, ...revoked, cleanup: result.cleanup ?? unconfirmedCleanup() }; }
    catch (error) { return { ...revoked, cleanup: unconfirmedCleanup(), error: error instanceof Error ? error.message : String(error) }; }
  }
  status(task: HostTaskRecord): Record<string, unknown> {
    const active = task.state === "active" && task.sessionId === this.seat?.id && task.grant.expiresAt > this.now();
    const lastCleanup = [...task.jobs].reverse().find(job => (job.action === "cancel" || job.action === "finish") && job.result?.cleanup)?.result?.cleanup;
    return { grant: task.grant, state: !active && task.state === "active" ? "unknown" : task.state, authorization: active ? "active" : "revoked",
      workspace: task.workspace, jobs: task.jobs, ...(!active ? { cleanup: lastCleanup ?? unconfirmedCleanup(), notice: HOST_TASK_STOP_NOTICE } : {}) };
  }
  stopAgent(agentId: string): void {
    for (const task of this.tasks.values()) if (task.grant.agentId === agentId && ["proposed", "starting", "active"].includes(task.state)) {
      task.state = "cancelled";
      if (task.sessionId === this.seat?.id) void this.send(task, "cancel").catch(() => {});
    }
  }
  private async send(task: HostTaskRecord, action: HostTaskJob["action"], command?: string): Promise<HostTaskResult> {
    const seat = this.seat;
    if (!seat || task.sessionId !== seat.id) throw new Error("Mac task connection unavailable");
    const job: HostTaskJob = { protocol: HOST_TASK_PROTOCOL, id: randomUUID(), sessionId: seat.id, action, grant: task.grant,
      startBefore: Math.min(this.now() + HOST_TASK_START_MS, task.grant.expiresAt), ...(command === undefined ? {} : { command, timeoutMs: HOST_TASK_COMMAND_MS }) };
    if (task.jobs.length >= 256 && action !== "cancel" && action !== "finish") throw new Error("Task command limit reached; finish this task");
    task.jobs.push({ id: job.id, action, state: "queued" });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(job.id);
        const entry = task.jobs.find(j => j.id === job.id); if (entry) entry.state = "unknown";
        if (!["completed", "cancelled"].includes(task.state)) task.state = "unknown";
        if (action !== "cancel") void this.send(task, "cancel").catch(() => {});
        reject(new Error(`Job ${job.id} timed out; result unknown. Task revoked; query status before deciding what to do.`));
      }, (action === "run" ? HOST_TASK_COMMAND_MS : HOST_TASK_START_MS) + HOST_TASK_START_MS);
      timer.unref();
      this.pending.set(job.id, { job, record: task, timer, resolve, reject });
      try { seat.write(`data: ${JSON.stringify({ type: "job", job })}\n\n`); }
      catch {
        this.pending.delete(job.id); clearTimeout(timer);
        this.disconnect(seat.id); // Close the stream so the Mac also revokes this connection.
        reject(new Error("Mac stream write failed; result unknown"));
      }
    });
  }
  settle(raw: unknown): boolean {
    if (!raw || typeof raw !== "object" || Buffer.byteLength(JSON.stringify(raw)) > HOST_TASK_WIRE_BYTES) return false;
    const answer = raw as HostTaskAnswer;
    const waiting = this.pending.get(answer.id);
    const task = waiting?.record ?? [...this.tasks.values()].find(t => t.jobs.some(j => j.id === answer.id));
    if (!task || task.sessionId !== answer.sessionId || task.grant.deviceId !== answer.deviceId || task.grant.grantId !== answer.grantId) return false;
    if (this.answers.has(answer.id)) return true;
    const entry = task.jobs.find(j => j.id === answer.id)!;
    if (answer.event === "started") { if (entry.state === "queued") entry.state = "running"; return true; }
    if (answer.event !== "result" || !answer.result || !["active", "completed", "cancelled", "failed", "unknown"].includes(answer.result.state)) return false;
    entry.state = answer.result.state; entry.result = answer.result;
    if (entry.action === "start" && answer.result.workspace) task.workspace = answer.result.workspace;
    // Keep full text only for recent jobs; the Mac retains its receipt journal.
    for (const old of task.jobs.slice(0, -8)) if (old.result) old.result = { state: old.result.state, exitCode: old.result.exitCode, authorization: old.result.authorization, cleanup: old.result.cleanup };
    this.answers.set(answer.id, answer);
    if (this.answers.size > 512) this.answers.delete(this.answers.keys().next().value!);
    if (waiting) { clearTimeout(waiting.timer); this.pending.delete(answer.id); waiting.resolve(answer.result); }
    return true;
  }
  async serve(route: string, req: IncomingMessage, res: ServerResponse, send: (res: ServerResponse, status: number, body: unknown) => void,
    refusedRole: (need: "admin") => boolean, readJson: (req: IncomingMessage) => Promise<unknown>): Promise<boolean> {
    if (route !== "GET /api/host-task/stream" && route !== "POST /api/host-task/result") return false;
    if (refusedRole("admin")) return true;
    if (route.endsWith("/result")) { const ok = this.settle(await readJson(req)); send(res, ok ? 200 : 404, { ok }); return true; }
    let caps: HostTaskCapabilities | undefined;
    try { caps = capabilitiesOf(JSON.parse(Buffer.from(String(req.headers["x-lumenbox-host-task"] ?? ""), "base64").toString("utf8"))); } catch { /* invalid handshake */ }
    if (!caps) { send(res, 400, { error: "Unsupported host task capability handshake" }); return true; }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    const id = this.attach(caps, frame => res.write(frame), () => res.end());
    const timer = setInterval(() => res.write(": ping\n\n"), 10_000);
    timer.unref(); req.on("close", () => { clearInterval(timer); this.disconnect(id); });
    return true;
  }
}
