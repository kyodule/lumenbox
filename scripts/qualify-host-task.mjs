/** Explicit Mac qualification (not part of the hermetic suite). Uses only generated canaries.
 * node --experimental-transform-types scripts/qualify-host-task.mjs /path/to/codex [report.json]
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexCommand, createLocalTask, loadTaskPolicy, CODEX_TASK_VERSION } from "../electron/host-task-runtime.ts";
import { HostTaskWorker } from "../electron/host-task-worker.ts";
import { taskConfig } from "./host-task-config.mjs";
import { HOST_TASK_CANCELLATION } from "../src/host/host-task-protocol.ts";

const runtimePath = process.argv[2];
if (!runtimePath || process.platform !== "darwin") throw new Error("Supply the qualified Codex binary on macOS");
const base = mkdtempSync(join(tmpdir(), "lht-"));
const source = join(base, "source"); mkdirSync(source);
writeFileSync(join(source, "input.txt"), "PROJECT_CANARY");
writeFileSync(join(source, ".env"), "CREDENTIAL_CANARY");
const outside = join(base, "outside.txt"); writeFileSync(outside, "OUTSIDE_CANARY");
const broker = join(base, "broker"); mkdirSync(broker);
const toolchainFixture = join(base, "toolchain-fixture"); mkdirSync(toolchainFixture);
writeFileSync(join(toolchainFixture, "library.txt"), "TOOLCHAIN_CANARY");
const config = join(broker, "host-tasks.json");
const configuration = taskConfig(runtimePath, [source], process.execPath);
configuration.toolchainReadPaths.push(toolchainFixture);
writeFileSync(config, JSON.stringify(configuration));
const policy = loadTaskPolicy(config);
const grant = access => ({ principalId: "qualification", agentId: "fixture-agent", conversation: "main", taskId: randomUUID(), grantId: randomUUID(),
  root: policy.capabilities.roots[0], purpose: "Generated canary qualification", access, network: false, cancellation: HOST_TASK_CANCELLATION, deviceId: policy.capabilities.deviceId,
  policyVersion: policy.capabilities.policyVersion, expiresAt: Date.now() + 120000 });
const task = createLocalTask(policy, grant("write"));
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const report = { runtime: CODEX_TASK_VERSION, cancellation: HOST_TASK_CANCELLATION, base, checks: [], observations: [] };
const check = async (name, command, success = false, target = task) => {
  const result = await new CodexCommand().run(policy, target, command, 4000);
  assert.equal(result.exitCode === 0, success, `${name}: ${JSON.stringify(result)}`);
  report.checks.push({ name, exitCode: result.exitCode, passed: true });
  console.log(`PASS ${name}`); return result;
};
let tcpHits = 0, unixHits = 0;
const tcp = createServer((_q, res) => { tcpHits++; res.end("NETWORK_CANARY"); });
await new Promise(resolve => tcp.listen(0, "127.0.0.1", resolve));
const originalCwd = process.cwd(); process.chdir(task.temp);
const unix = createServer((_q, res) => { unixHits++; res.end("UNIX_CANARY"); });
await new Promise((resolve, reject) => { unix.on("error", reject); unix.listen("s", resolve); });
process.chdir(originalCwd);
try {
  await check("project-read-and-write", "cat input.txt; printf modified > output.txt", true);
  assert.equal(readFileSync(join(task.workspace, "output.txt"), "utf8"), "modified");
  assert.equal(existsSync(join(source, "output.txt")), false);
  await check("original-project-read-denied", `cat ${quote(join(source, "input.txt"))}`);
  await check("outside-read-denied", `cat ${quote(outside)}`);
  await check("outside-write-denied", `printf bad > ${quote(join(base, "bad"))}`);
  symlinkSync(outside, join(task.workspace, "escape"));
  await check("symlink-escape-denied", "cat escape");
  await check("hardlink-escape-denied", `ln ${quote(outside)} escape-hardlink`);
  writeFileSync(join(task.control, "auth.json"), "CONTROL_CANARY");
  await check("executor-control-read-denied", `cat ${quote(join(task.control, "auth.json"))}`);
  await check("credentials-omitted", "test ! -e .env", true);
  await check("configured-toolchain-read", `cat ${quote(join(toolchainFixture, "library.txt"))}`, true);
  await check("configured-toolchain-write-denied", `printf changed > ${quote(join(toolchainFixture, "library.txt"))}`);
  await check("node-launcher-write-denied", `printf changed > ${quote(join(task.tools, "node"))}`);
  await check("tcp-loopback-denied", `curl -fsS --max-time 2 http://127.0.0.1:${tcp.address().port}/`);
  await check("unix-socket-denied-even-in-writable-temp", "curl -fsS --max-time 2 --unix-socket ../tmp/s http://localhost/");
  assert.equal(tcpHits, 0); assert.equal(unixHits, 0);
  const plist = join(base, "preferences.plist");
  writeFileSync(plist, '<?xml version="1.0"?><plist version="1.0"><dict><key>canary</key><string>PREFERENCE_CANARY</string></dict></plist>');
  await check("preferences-ipc-read-denied", `defaults read ${quote(plist)} canary`);
  process.env.LUMEN_TASK_CANARY = "synthetic-secret";
  await check("environment-not-inherited", 'test "${LUMEN_TASK_CANARY-unset}" = unset', true);
  delete process.env.LUMEN_TASK_CANARY;
  const ro = createLocalTask(policy, grant("read"));
  await check("read-only-read", "cat input.txt", true, ro);
  await check("read-only-write-denied", "printf bad > input.txt", false, ro);
  const huge = await check("bounded-unicode-and-control-output", "awk 'BEGIN { for(i=0;i<300000;i++) printf \"汉\\001\" }'", true);
  assert.ok(Buffer.byteLength(JSON.stringify(huge)) < 800000);
  const executor = new CodexCommand();
  const executing = executor.run(policy, task, "sleep 40 & child=$!; printf %s \"$child\" > child.pid; wait", 50000).catch(error => ({ error: error.message }));
  for (let i = 0; !existsSync(join(task.workspace, "child.pid")) && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 50));
  const pid = Number(readFileSync(join(task.workspace, "child.pid"), "utf8"));
  const cleanup = await executor.stop(); await executing;
  await new Promise(resolve => setTimeout(resolve, 200));
  let state = ""; try { state = execFileSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim(); } catch { /* gone */ }
  assert.ok(state === "" || state.startsWith("Z"), `child process ${pid} survived cancellation (${state})`);
  assert.equal(cleanup.managedProcesses, "stopped"); assert.equal(cleanup.detachedProcesses, "may-remain");
  report.checks.push({ name: "cancel-managed-process-group", passed: true }); console.log("PASS cancel-managed-process-group");
  const messages = [];
  const worker = new HostTaskWorker(config, message => messages.push(message));
  const sessionId = randomUUID(); worker.hello(sessionId);
  const workerGrant = grant("write");
  const job = (action, extra = {}) => ({ protocol: 1, id: randomUUID(), sessionId, action, grant: workerGrant, startBefore: Date.now() + 30000, ...extra });
  await worker.handle(job("start"));
  const start = messages.at(-1); assert.equal(start.result?.state, "active");
  const append = job("run", { command: "printf once >> counter", timeoutMs: 4000 });
  await worker.handle(append); await worker.handle(append);
  assert.equal(readFileSync(join(start.result.workspace, "counter"), "utf8"), "once");
  await worker.handle(job("run", { startBefore: Date.now() - 1, command: "printf late > stale" }));
  assert.equal(existsSync(join(start.result.workspace, "stale")), false);
  const inFlight = job("run", { command: 'printf completed > checkpoint; sleep 40 & child=$!; printf %s "$child" > running.pid; wait', timeoutMs: 50000 });
  const inFlightPromise = worker.handle(inFlight);
  for (let i = 0; !existsSync(join(start.result.workspace, "running.pid")) && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 50));
  const runningPid = Number(readFileSync(join(start.result.workspace, "running.pid"), "utf8"));
  // Even a broken policy file must not block revocation of an already running task.
  writeFileSync(config, "invalid JSON");
  const cancellation = job("cancel"), cancelling = worker.handle(cancellation);
  await worker.handle(job("run", { command: "printf revoked > revoked" }));
  await Promise.all([cancelling, inFlightPromise]);
  writeFileSync(config, JSON.stringify(configuration));
  assert.equal(existsSync(join(start.result.workspace, "revoked")), false);
  assert.equal(readFileSync(join(start.result.workspace, "checkpoint"), "utf8"), "completed", "stopping does not undo completed work");
  const stopped = messages.find(m => m.id === cancellation.id && m.event === "result").result;
  assert.equal(stopped.authorization, "revoked"); assert.equal(stopped.cleanup.managedProcesses, "stopped");
  assert.equal(stopped.cleanup.detachedProcesses, "may-remain"); assert.match(stopped.notice, /Never resume/);
  let runningState = ""; try { runningState = execFileSync("/bin/ps", ["-o", "stat=", "-p", String(runningPid)], { encoding: "utf8" }).trim(); } catch { /* gone */ }
  assert.ok(!runningState || runningState.startsWith("Z"), "managed command survived concurrent cancellation");
  await worker.stop();
  report.checks.push({ name: "worker-dedup-deadline-revocation", passed: true }); console.log("PASS worker-dedup-deadline-revocation");
  const recovered = [];
  const restarted = new HostTaskWorker(config, message => recovered.push(message));
  restarted.hello(randomUUID());
  assert.ok(recovered.some(message => message.id === append.id && message.result?.state === "completed"));
  restarted.acknowledge(append.id); recovered.length = 0; restarted.drain();
  assert.ok(!recovered.some(message => message.id === append.id)); await restarted.stop();
  report.checks.push({ name: "receipt-recovery-without-command-replay", passed: true }); console.log("PASS receipt-recovery-without-command-replay");
  writeFileSync(join(task.workspace, "smoke.test.cjs"), 'require("node:test")("offline assertion",()=>require("node:assert/strict").equal(2+2,4));');
  const nodeTest = await new CodexCommand().run(policy, task, "node --test smoke.test.cjs", 4000);
  report.checks.push({ name: "node-project-offline-test", passed: nodeTest.exitCode === 0, exitCode: nodeTest.exitCode, stdout: nodeTest.stdout, stderr: nodeTest.stderr });
  console.log(`${nodeTest.exitCode === 0 ? "PASS" : "FAIL"} node-project-offline-test`);
  await check("npm-offline-launcher", "npm --version", true);
  // Keep the known detached-process counterexample visible. It is an accepted limitation,
  // not a successful strong-cancellation test. This generated fixture only sleeps.
  const c = join(source, "detach.c");
  writeFileSync(c, '#include <unistd.h>\n#include <stdio.h>\nint main(){pid_t p=fork();if(p==0){setsid();freopen("/dev/null","w",stdout);freopen("/dev/null","w",stderr);sleep(30);_exit(0);}FILE*f=fopen("detached.pid","w");fprintf(f,"%d",p);fclose(f);return 0;}');
  execFileSync("/usr/bin/cc", [c, "-o", join(source, "detach")]);
  const daemonTask = createLocalTask(policy, grant("write"));
  await check("daemon-fixture-executed", "./detach", true, daemonTask);
  const daemonPid = Number(readFileSync(join(daemonTask.workspace, "detached.pid"), "utf8"));
  let daemonState = ""; try { daemonState = execFileSync("/bin/ps", ["-o", "stat=", "-p", String(daemonPid)], { encoding: "utf8" }).trim(); } catch { /* gone */ }
  const contained = daemonState === "" || daemonState.startsWith("Z");
  if (!contained) { try { process.kill(daemonPid, "SIGKILL"); } catch { /* fixture already exited */ } }
  report.observations.push({ name: "detached-process-revocation", detachedProcessSurvived: !contained,
    classification: "accepted-limitation", fixtureCleanedUp: true });
  console.log(`OBSERVATION detached child ${contained ? "exited" : "survived managed cleanup; fixture killed by harness"}`);
} finally {
  report.passed = report.checks.length >= 24 && report.checks.every(check => check.passed) && report.observations.length === 1;
  tcp.close(); unix.close();
  writeFileSync(process.argv[3] ?? join(base, "qualification.json"), JSON.stringify(report, null, 2));
  console.log(`Evidence: ${process.argv[3] ?? join(base, "qualification.json")}`);
}
if (!report.passed) process.exitCode = 1;
