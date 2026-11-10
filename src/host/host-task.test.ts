import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync, linkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DesktopHostRunner } from "./host-runner.ts";
import { DesktopHostTasks } from "./host-tasks.ts";
import { PolicyGate, DEFAULT_LIMITS } from "./policy.ts";
import { RuleStore } from "./rules.ts";
import { staleApprovals } from "./approval-wait.ts";
import { buildTools, dispatchTool, type ToolContext } from "./tools.ts";
import { CONSOLE_OPERATOR } from "./host-task-tools.ts";
import { actingFor, noteApprovalWake, noteAskedFor, notePersonTurn, noteTurnOpened } from "./person-turns.ts";
import { AgentRegistry, MAIN_CONVERSATION } from "../agents/registry.ts";
import { AgentBus, type InboundMessage } from "../agents/bus.ts";
import { type HostTaskJob, type HostTaskAnswer, type HostTaskCapabilities, HOST_TASK_CANCELLATION, HOST_TASK_TTL_MS } from "./host-task-protocol.ts";
import { snapshotProject, clipOutput, loadTaskPolicy, createLocalTask, CodexCommand, CODEX_TASK_VERSION } from "../../electron/host-task-runtime.ts";

const caps: HostTaskCapabilities = { protocol: 1, deviceId: "device-fixture", policyVersion: "policy-fixture", roots: ["/fixture/project"], runtime: "qualified", cancellation: HOST_TASK_CANCELLATION, toolchainReadPaths: [] };
const owner = { principalId: "person", agentId: "agent", conversation: "main" };
const proposal = { action: "start", root: caps.roots[0], purpose: "Review and test this project", access: "write" };
function connection(tasks: DesktopHostTasks, automatic = true) {
  const frames: HostTaskJob[] = [];
  const answer = (job: HostTaskJob, state = job.action === "start" ? "active" : "completed") => ({ id: job.id, sessionId: job.sessionId,
    deviceId: caps.deviceId, grantId: job.grant.grantId, event: "result", result: { state, stdout: "fixture", exitCode: 0, workspace: "/fixture/copy" } }) as HostTaskAnswer;
  const id = tasks.attach(caps, frame => {
    const message = JSON.parse(frame.slice(6)); if (message.type !== "job") return;
    const job = message.job as HostTaskJob; frames.push(job);
    if (automatic) queueMicrotask(() => tasks.settle(answer(job)));
  });
  return { id, frames, answer };
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "host-task-test-"));
  const rulesPath = join(dir, "rules"); mkdirSync(rulesPath);
  const rules = new RuleStore(rulesPath);
  const path = join(dir, "policy.jsonl");
  const policy = new PolicyGate({ path, rules, limits: { ...DEFAULT_LIMITS, approvalRequiredTools: [], approvalRequiredCommands: [], tierGate: "enforce" } });
  const runner = new DesktopHostRunner(); const seat = connection(runner.tasks);
  const context = { agent: { id: owner.agentId, profile: { name: "Ada" } }, caller: { userId: owner.principalId }, conversation: "main", turnId: "first",
    policy, hostRunner: runner, registry: {}, bus: {} } as unknown as ToolContext;
  return { dir, rules, rulesPath, path, policy, runner, seat, context, cleanup: () => { runner.tasks.disconnect(); rmSync(dir, { recursive: true, force: true }); } };
}
async function authorize(f: ReturnType<typeof fixture>) {
  const question = await dispatchTool("HostTask", proposal, f.context);
  assert.ok(question.approval, question.text);
  assert.equal(f.policy.pending()[0]?.onceOnly, true);
  f.policy.grant(question.approval.id, "person", "always"); // deliberately trying to widen it still grants once
  const start = await dispatchTool("HostTask", proposal, f.context);
  assert.ok(!start.isError, start.text);
  return JSON.parse(start.text).taskId as string;
}

test("one task approval covers 30 different commands across turns; finish invalidates the grant", async () => {
  const f = fixture();
  try {
    const taskId = await authorize(f);
    assert.equal(f.seat.frames[0]?.grant.principalId, "person");
    for (let i = 0; i < 30; i++) {
      const result = await dispatchTool("HostTask", { action: "run", taskId, command: `cat file-${i}` }, { ...f.context, turnId: `turn-${i}` });
      assert.ok(!result.isError, result.text); assert.equal(f.policy.pending().length, 0);
    }
    assert.equal(f.seat.frames.length, 31);
    assert.equal(readFileSync(f.path, "utf8").split('"kind":"approval-requested"').length - 1, 1);
    await dispatchTool("HostTask", { action: "finish", taskId }, f.context);
    const rejected = await dispatchTool("HostTask", { action: "run", taskId, command: "cat x" }, f.context);
    assert.ok(rejected.isError); assert.equal(f.seat.frames.length, 32);
    assert.ok((await dispatchTool("HostTask", proposal, f.context)).approval, "same purpose must require a fresh task approval");
  } finally { f.cleanup(); }
});

test("owner, root, device, connection and task limits cannot be widened by model input", async () => {
  const f = fixture();
  try {
    const taskId = await authorize(f);
    for (const extra of [{ caller: { userId: "other" } }, { conversation: "other" }, { conversation: "fork/child" }, { caller: undefined }]) {
      assert.ok((await dispatchTool("HostTask", { action: "run", taskId, command: "pwd" }, { ...f.context, ...extra } as ToolContext)).isError);
    }
    assert.ok((await dispatchTool("HostTask", { ...proposal, root: "/" }, f.context)).isError);
    assert.equal(f.seat.frames.length, 1);
    f.runner.tasks.disconnect(); connection(f.runner.tasks);
    assert.ok((await dispatchTool("HostTask", { action: "run", taskId, command: "pwd" }, f.context)).isError);
    assert.ok(!buildTools(true).some(t => t.name === "HostTask"));
    assert.ok(buildTools(true, true, undefined, true, true, false, false, false, [], true).some(t => t.name === "HostTask"));
    assert.ok(!buildTools(true, true, undefined, true, true, false, false, true, [], true).some(t => t.name === "HostTask"));
    // An agent with an explicit tool list holds it only by name, and the profile routes accept only ALL_TOOLS names.
    assert.ok(buildTools(true, true, ["bash", "HostTask"], true, true, false, false, false, [], true).some(t => t.name === "HostTask"));
    assert.ok(!buildTools(true, true, ["bash", "RunOnHost"], true, true, false, false, false, [], true).some(t => t.name === "HostTask"));
    assert.ok((await import("./orchestrator.ts")).ALL_TOOLS.includes("HostTask"));
  } finally { f.cleanup(); }
});

test("a console with no signed-in identity: the person's turn asks, the wake of their approval starts and runs, a teammate's wake is refused", async () => {
  const f = fixture();
  try {
    const consoleTurn = { ...f.context, caller: undefined, turnId: "console-turn" } as ToolContext;
    const approvalWake = { ...f.context, caller: undefined, turnId: "approval-wake" } as ToolContext;
    const teammateWake = { ...f.context, caller: undefined, turnId: "teammate-wake" } as ToolContext;
    assert.match((await dispatchTool("HostTask", { action: "list" }, teammateWake)).text, /turn a person opened/);
    notePersonTurn("console-turn");
    const question = await dispatchTool("HostTask", proposal, consoleTurn);
    assert.ok(question.approval, question.text); assert.match(question.text, /call start with \{"action":"start","taskId":"[0-9a-f-]{36}"\}/);
    f.policy.grant(question.approval.id, "person", "once");
    assert.ok((await dispatchTool("HostTask", proposal, approvalWake)).isError, "a wake that names no approval acts for nobody");
    noteApprovalWake("approval-wake", "an-approval-nobody-asked-for");
    assert.ok((await dispatchTool("HostTask", proposal, approvalWake)).isError);
    noteApprovalWake("approval-wake", question.approval.id);
    const start = await dispatchTool("HostTask", proposal, approvalWake);
    assert.ok(!start.isError, start.text);
    assert.equal(f.seat.frames[0]?.grant.principalId, CONSOLE_OPERATOR);
    const taskId = JSON.parse(start.text).taskId as string;
    assert.ok(!(await dispatchTool("HostTask", { action: "run", taskId, command: "pwd" }, approvalWake)).isError);
    for (const other of [teammateWake, { ...consoleTurn, conversation: "fork/child" } as ToolContext, { ...consoleTurn, caller: { userId: "person" } } as ToolContext]) {
      assert.ok((await dispatchTool("HostTask", { action: "run", taskId, command: "pwd" }, other)).isError);
    }
    // A signed-in person's approval wake carries no caller either; it acts for the person who asked.
    const asked = await dispatchTool("HostTask", { ...proposal, purpose: "Signed-in review" }, { ...f.context, turnId: "signed-in-turn" } as ToolContext);
    assert.ok(asked.approval, asked.text);
    f.policy.grant(asked.approval.id, "person", "once");
    noteApprovalWake("signed-in-wake", asked.approval.id);
    const started = await dispatchTool("HostTask", { ...proposal, purpose: "Signed-in review" }, { ...f.context, caller: undefined, turnId: "signed-in-wake" } as ToolContext);
    assert.ok(!started.isError, started.text);
    assert.equal(f.seat.frames.at(-1)?.grant.principalId, "person");
  } finally { f.cleanup(); }
});
test("the approval's wake carries its id through the bus, and only that wake acts for the person who asked", async () => {
  const root = mkdtempSync(join(tmpdir(), "approval-wake-"));
  try {
    const registry = new AgentRegistry(root); const ada = registry.create({ name: "Ada" });
    const seen: InboundMessage[] = [];
    const bus = new AgentBus(registry, (async (_agent: unknown, inbound: readonly InboundMessage[]) => { seen.push(...inbound); }) as never);
    bus.deliverSystem(ada.id, "[The person allowed it once: HostTask start. Go ahead now.]", MAIN_CONVERSATION, "approval-1");
    bus.deliverSystem(ada.id, "a late fork report");
    for (let i = 0; i < 100 && seen.length < 2; i++) { await bus.wake(ada.id); await new Promise(resolve => setImmediate(resolve)); }
    assert.deepEqual(seen.map(message => message.answeredApproval), ["approval-1", undefined]);
    noteAskedFor("approval-1", CONSOLE_OPERATOR);
    noteTurnOpened("wake-turn", false, seen.slice(0, 1)); assert.equal(actingFor("wake-turn"), CONSOLE_OPERATOR);
    noteTurnOpened("report-turn", false, seen.slice(1)); assert.equal(actingFor("report-turn"), undefined);
    noteTurnOpened("person-turn", true, []); assert.equal(actingFor("person-turn"), CONSOLE_OPERATOR);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("the 升级验收2 timeline: the card outlives the asking turn, a wake that does nothing loses nothing, and start by taskId 14 minutes later begins the task", async () => {
  let now = Date.now();
  const dir = mkdtempSync(join(tmpdir(), "host-task-timeline-"));
  const rulesPath = join(dir, "rules"); mkdirSync(rulesPath);
  const policy = new PolicyGate({ path: join(dir, "policy.jsonl"), rules: new RuleStore(rulesPath), now: () => new Date(now), limits: { ...DEFAULT_LIMITS, approvalRequiredTools: [], approvalRequiredCommands: [], tierGate: "enforce" } });
  const runner = new DesktopHostRunner(); Object.defineProperty(runner, "tasks", { value: new DesktopHostTasks(() => now) }); const seat = connection(runner.tasks);
  const base = { agent: { id: owner.agentId, profile: { name: "Ada" } }, caller: undefined, conversation: "main", policy, hostRunner: runner, registry: {}, bus: {} };
  try {
    notePersonTurn("asked"); // 07:22: the person's turn asks, and ends
    const asked = await dispatchTool("HostTask", proposal, { ...base, turnId: "asked" } as unknown as ToolContext);
    assert.ok(asked.approval, asked.text);
    const taskId = /taskId ([0-9a-f-]{36})/.exec(asked.text)?.[1]; assert.ok(taskId, asked.text);
    const ended = { turns: { interrupted: () => [] }, steps: { stepsOf: () => ({ open: [] }) } };
    assert.deepEqual(staleApprovals(ended, policy.pending(), now.valueOf()), [], "the asking turn has ended; the task card still waits");
    now += 3 * 60_000; policy.grant(asked.approval.id, "user", "once"); // 07:25: allowed; the wake makes no HostTask call
    now += 11 * 60_000; notePersonTurn("next"); // 07:37: the person's next turn, past the 10-minute proposal window
    const next = { ...base, turnId: "next" } as unknown as ToolContext;
    assert.equal(JSON.parse((await dispatchTool("HostTask", { action: "status", taskId }, next)).text).authorization, "not-started");
    const start = await dispatchTool("HostTask", { action: "start", taskId }, next);
    assert.ok(!start.isError, start.text); assert.equal(JSON.parse(start.text).taskId, taskId);
    assert.equal(policy.pending().length, 0, "no second card");
    assert.ok(!(await dispatchTool("HostTask", { action: "run", taskId, command: "pwd" }, next)).isError);
    const again = await dispatchTool("HostTask", { action: "start", taskId }, next);
    assert.ok(again.isError && !again.approval, "a used authorization is not asked for again");
    assert.equal(seat.frames.filter(frame => frame.action === "start").length, 1);
  } finally { runner.tasks.disconnect(); rmSync(dir, { recursive: true, force: true }); }
});
test("operator deny and ask still precede the task grant, while old RunOnHost always asks", async () => {
  const f = fixture();
  try {
    const taskId = await authorize(f);
    writeFileSync(join(f.rulesPath, "block.md"), "---\neffect: deny\ntool: HostTask\ncommand: denied\n---\nBlocked test operation.\n");
    writeFileSync(join(f.rulesPath, "ask.md"), "---\neffect: ask\ntool: HostTask\ncommand: inspect\n---\nInspect explicitly.\n");
    f.rules.reload();
    const denied = await dispatchTool("HostTask", { action: "run", taskId, command: "denied target" }, f.context);
    assert.match(denied.text, /Refused by rule/); assert.equal(f.seat.frames.length, 1);
    const asked = await dispatchTool("HostTask", { action: "run", taskId, command: "inspect target" }, f.context);
    assert.ok(asked.approval); assert.equal(f.seat.frames.length, 1);
    assert.ok((await dispatchTool("RunOnHost", { command: "pwd" }, f.context)).approval);
  } finally { f.cleanup(); }
});

test("local data provenance survives turns, finish and server restart; connectors and opaque VM commands ask", async () => {
  const f = fixture();
  try {
    const taskId = await authorize(f);
    await dispatchTool("HostTask", { action: "run", taskId, command: "cat file" }, f.context);
    await dispatchTool("HostTask", { action: "finish", taskId }, f.context);
    const restored = new PolicyGate({ path: f.path, limits: { ...DEFAULT_LIMITS, approvalRequiredTools: [], approvalRequiredCommands: [] } });
    for (const tool of ["connector_request", "bash", "Delegate", "SendToAgent"]) {
      const decision = restored.check({ kind: "tool", agentId: owner.agentId, agentName: "Ada", tool, input: { command: "python opaque.py" }, turnId: "next" });
      assert.equal(decision.allow, false); if (!decision.allow) assert.match(decision.reason, /local data/);
    }
    const share = { kind: "tool" as const, agentId: owner.agentId, agentName: "Ada", tool: "Tasks", input: { action: "create", assigneeId: "other", title: "local findings" } };
    const asks = restored.check(share); assert.ok(!asks.allow && asks.approval);
    if (!asks.allow && asks.approval) restored.grant(asks.approval.id);
    assert.equal(restored.check(share).allow, true);
    assert.equal(restored.check({ ...share, agentId: "other", tool: "connector_request" }).allow, false, "approved sharing propagates the source label");
  } finally { f.cleanup(); }
});

test("once-only approval survives restart and cannot turn into a standing external-data grant", () => {
  const f = fixture();
  try {
    f.policy.markHostRead(owner.agentId);
    const call = { kind: "tool" as const, agentId: owner.agentId, agentName: "Ada", tool: "connector_request", input: { method: "POST", connector: "fixture" } };
    const question = f.policy.check(call); assert.ok(!question.allow && question.approval);
    const restarted = new PolicyGate({ path: f.path });
    assert.equal(restarted.pending()[0]?.onceOnly, true);
    if (!question.allow && question.approval) restarted.grant(question.approval.id, "person", "always");
    assert.equal(restarted.standingGrants().length, 0);
    assert.equal(restarted.check(call).allow, true); assert.equal(restarted.check(call).allow, false);
  } finally { f.cleanup(); }
});

test("cancellation bypasses work quotas and a late start receipt cannot resurrect a revoked grant", async () => {
  const tasks = new DesktopHostTasks(), s = connection(tasks, false);
  const task = tasks.propose(owner, proposal), starting = tasks.start(task);
  const start = s.frames[0]!;
  task.jobs.push(...Array.from({ length: 256 }, (_, i) => ({ id: `quota-${i}`, action: "run", state: "completed" })));
  tasks.stopAgent(owner.agentId);
  assert.equal(s.frames.at(-1)?.action, "cancel");
  tasks.settle(s.answer(s.frames.at(-1)!, "cancelled")); tasks.settle(s.answer(start)); await starting;
  assert.equal(task.state, "cancelled"); await assert.rejects(tasks.run(task, "pwd"), /not active/); tasks.disconnect();
});

test("revocation is immediate while cleanup is pending, and expiry or disconnect cannot block cancel", async () => {
  let now = Date.now();
  const tasks = new DesktopHostTasks(() => now), s = connection(tasks, false);
  const task = tasks.propose(owner, proposal), starting = tasks.start(task);
  tasks.settle(s.answer(s.frames[0]!)); await starting;
  const running = tasks.run(task, "sleep 30"); const runJob = s.frames.at(-1)!;
  now += HOST_TASK_TTL_MS + 1;
  const cancelling = tasks.end(task, "cancel"); const cancelJob = s.frames.at(-1)!;
  assert.equal(cancelJob.action, "cancel"); assert.equal(task.state, "cancelled");
  assert.equal(tasks.status(task).authorization, "revoked");
  await assert.rejects(tasks.run(task, "touch should-not-run"));
  const cancelled = s.answer(cancelJob, "cancelled"); cancelled.result!.cleanup = { managedProcesses: "unconfirmed", detachedProcesses: "may-remain" };
  tasks.settle(cancelled); tasks.settle(s.answer(runJob));
  const receipt = await cancelling; await running;
  assert.equal(receipt.authorization, "revoked"); assert.equal(receipt.cleanup?.managedProcesses, "unconfirmed");
  assert.equal(task.state, "cancelled", "late success records progress without restoring authorization");
  tasks.disconnect();
  const offline = await tasks.end(task, "cancel");
  assert.equal(offline.authorization, "revoked"); assert.equal(offline.cleanup?.managedProcesses, "unconfirmed");
  assert.match(offline.notice!, /not rolled back/);
  assert.equal(tasks.available, true, "receipts remain available after disconnect");
});

test("local policy requires the accepted cancellation contract and keeps toolchain reads separate from private data", () => {
  const dir = mkdtempSync(join(tmpdir(), "host-policy-test-"));
  try {
    const source = join(dir, "source"), control = join(dir, "control"), toolchain = join(dir, "toolchain"), bin = join(toolchain, "bin");
    for (const path of [source, control, bin]) mkdirSync(path, { recursive: true });
    const runtime = join(dir, "runtime"); writeFileSync(runtime, "non-executable test fixture");
    const config = join(control, "policy.json");
    const raw = { enabled: true, cancellation: HOST_TASK_CANCELLATION, deviceId: "fixture-device", roots: [source],
      runtimeVersion: CODEX_TASK_VERSION, runtimePath: runtime, runtimeSha256: createHash("sha256").update(readFileSync(runtime)).digest("hex"),
      toolchainReadPaths: [toolchain], toolchainBinPaths: [bin] };
    const save = (extra: Record<string, unknown>) => writeFileSync(config, JSON.stringify({ ...raw, ...extra }));
    save({}); const policy = loadTaskPolicy(config); assert.equal(policy.capabilities.cancellation, HOST_TASK_CANCELLATION);
    save({ cancellation: "all-descendants" }); assert.throws(() => loadTaskPolicy(config), /managed-process/);
    for (const path of [source, control, dir, "/"]) {
      save({ toolchainReadPaths: [path], toolchainBinPaths: [] }); assert.throws(() => loadTaskPolicy(config), /Toolchain reads/);
    }
    save({ toolchainBinPaths: [source] }); assert.throws(() => loadTaskPolicy(config), /Toolchain PATH/);
    save({}); writeFileSync(runtime, "changed runtime"); assert.throws(() => loadTaskPolicy(config), /runtime changed/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("executor startup respects expiry, and exit alone cannot confirm cleanup when terminate RPC fails", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "host-stop-receipt-")), executor = new CodexCommand();
  try {
    const source = join(dir, "source"), control = join(dir, "broker"); mkdirSync(source); mkdirSync(control);
    const runtime = join(dir, "fake-runtime"), config = join(control, "policy.json");
    writeFileSync(runtime, `#!${process.execPath}\n` +
      `if(process.argv.includes('--version')){console.log('codex-cli ${CODEX_TASK_VERSION}');process.exit(0)}\n` +
      "require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);" +
      "if(m.method==='initialize'){require('node:fs').writeFileSync('initialized','yes');setTimeout(()=>console.log(JSON.stringify({id:m.id,result:{}})),require('node:fs').existsSync('slow-start')?800:0);}" +
      "if(m.method==='command/exec')require('node:fs').writeFileSync(require('node:path').join(m.params.cwd,'started'),'yes');" +
      "if(m.method==='command/exec/terminate')console.log(JSON.stringify({id:m.id,error:{message:'fixture: termination unconfirmed'}}));});\n", { mode: 0o700 });
    writeFileSync(config, JSON.stringify({ enabled: true, cancellation: HOST_TASK_CANCELLATION, deviceId: "fixture-device", roots: [source],
      runtimeVersion: CODEX_TASK_VERSION, runtimePath: runtime, runtimeSha256: createHash("sha256").update(readFileSync(runtime)).digest("hex") }));
    const policy = loadTaskPolicy(config);
    const task = createLocalTask(policy, { ...owner, taskId: "task-fixture", grantId: "grant-fixture", deviceId: policy.capabilities.deviceId,
      policyVersion: policy.capabilities.policyVersion, root: policy.capabilities.roots[0]!, purpose: "Cancellation receipt failure fixture", access: "read", network: false,
      cancellation: HOST_TASK_CANCELLATION, expiresAt: Date.now() + 60000 });
    const executing = executor.run(policy, task, "fixture command", 5000).catch(error => error);
    for (let i = 0; !existsSync(join(task.workspace, "started")) && i < 200; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(existsSync(join(task.workspace, "started")), "fake command reached the cancellation point");
    const receipt = await executor.stop(); await executing;
    assert.equal(receipt.managedProcesses, "unconfirmed"); assert.equal(receipt.detachedProcesses, "may-remain");
    writeFileSync(join(source, "slow-start"), "fixture");
    const expiring = createLocalTask(policy, { ...task.grant, taskId: "expiring-task", grantId: "expiring-grant", expiresAt: Date.now() + 200 });
    await assert.rejects(new CodexCommand().run(policy, expiring, "must not dispatch after initialization", 5000), /expired during executor startup/);
    assert.ok(existsSync(join(expiring.workspace, "initialized")));
    assert.equal(existsSync(join(expiring.workspace, "started")), false, "expiry during initialization prevents command dispatch");
  } finally { await executor.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("stop dispatches cancellation immediately, disconnect does not replay, receipts are device-bound and idempotent", async () => {
  const f = fixture();
  try {
    const taskId = await authorize(f);
    f.policy.stop(owner.agentId);
    assert.equal(f.seat.frames.at(-1)?.action, "cancel");
    f.policy.resume(owner.agentId);
    assert.ok((await dispatchTool("HostTask", { action: "run", taskId, command: "pwd" }, f.context)).isError);
    const tasks = new DesktopHostTasks(); const s = connection(tasks, false);
    const task = tasks.propose(owner, proposal); const pending = tasks.start(task); const job = s.frames[0]!;
    assert.equal(tasks.settle({ ...s.answer(job), deviceId: "wrong-device" }), false);
    const rejected = assert.rejects(pending, /unknown/); tasks.disconnect(s.id); await rejected;
    connection(tasks, false); assert.equal(s.frames.length, 1);
    assert.equal(tasks.settle(s.answer(job)), true, "late receipt repairs the job status without resuming the task");
    assert.equal(tasks.settle(s.answer(job)), true, "retry of an acknowledged result is acknowledged again");
    assert.equal(task.state, "unknown"); assert.equal(task.jobs[0]?.state, "active"); tasks.disconnect();
  } finally { f.cleanup(); }
});

test("expiry refuses before sending, snapshot excludes links and credentials, JSON results have a byte ceiling", async () => {
  let now = Date.now(); const tasks = new DesktopHostTasks(() => now); const s = connection(tasks);
  const task = tasks.propose(owner, proposal); await tasks.start(task); now += HOST_TASK_TTL_MS + 1;
  await assert.rejects(tasks.run(task, "pwd"), /expired/); assert.equal(s.frames.length, 1); tasks.disconnect();
  const dir = mkdtempSync(join(tmpdir(), "host-snapshot-test-"));
  try {
    const source = join(dir, "source"), copy = join(dir, "copy"); mkdirSync(source);
    writeFileSync(join(source, "good"), "good"); writeFileSync(join(source, ".env"), "fixture-token");
    writeFileSync(join(dir, "outside"), "outside"); symlinkSync(join(dir, "outside"), join(source, "symlink")); linkSync(join(dir, "outside"), join(source, "hardlink"));
    snapshotProject(source, copy);
    assert.equal(readFileSync(join(copy, "good"), "utf8"), "good");
    for (const p of [".env", "symlink", "hardlink"]) assert.equal(existsSync(join(copy, p)), false);
    const clipped = clipOutput("汉\u0000".repeat(100000), "字\u0001".repeat(100000));
    assert.ok(clipped.truncated); assert.ok(Buffer.byteLength(JSON.stringify(clipped)) < 800000);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
