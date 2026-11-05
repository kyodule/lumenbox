/** Real App worker + authenticated transport, using generated canaries only.
 * node --experimental-transform-types scripts/qualify-host-task-transport.mjs <codex> <electron-executable> [packaged-app-resources] [report.json]
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as http from "node:http";
import { DesktopHostTasks } from "../src/host/host-tasks.ts";
import { taskConfig } from "./host-task-config.mjs";

const [runtime, executable, packaged = process.cwd(), reportPath = "/tmp/lumen-task-transport.json"] = process.argv.slice(2);
if (!runtime || !executable || process.platform !== "darwin") throw new Error("Supply Codex and the packaged Electron executable on Mac");
const { HostTaskClient } = createRequire(import.meta.url)(join(resolve(packaged), "electron/host-task-client.cjs"));
const base = mkdtempSync(join(tmpdir(), "lht-wire-")), source = join(base, "source"), broker = join(base, "broker");
mkdirSync(source); mkdirSync(broker);
writeFileSync(join(source, "input.txt"), "TRANSPORT_CANARY");
writeFileSync(join(source, "smoke.test.cjs"), 'require("node:test")("Mac offline test",()=>require("node:assert/strict").equal(3*7,21));');
const configPath = join(broker, "host-tasks.json");
writeFileSync(configPath, JSON.stringify(taskConfig(runtime, [source], process.execPath)));
const tasks = new DesktopHostTasks(), events = [];
const send = (res, code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
const server = createServer(async (req, res) => {
  if (req.headers.authorization !== "Bearer generated-fixture") { send(res, 401, {}); return; }
  try {
    const handled = await tasks.serve(`${req.method} ${req.url}`, req, res, send, () => false,
      async request => { let body = ""; for await (const part of request) body += part; return JSON.parse(body); });
    if (!handled) send(res, 404, {});
  } catch (error) { send(res, 400, { error: error.message }); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const page = `http://127.0.0.1:${server.address().port}/`;
const client = new HostTaskClient({ configPath, page, client: http, headers: { authorization: "Bearer generated-fixture" }, executable,
  log: message => events.push(message) });
const waitUntil = async predicate => {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error(`Timed out: ${events.join("; ")}`);
};
const report = { base, packaged: resolve(packaged), executable, passed: false };
try {
  const unauthenticated = await fetch(`${page}api/host-task/stream`); assert.equal(unauthenticated.status, 401);
  client.start(true); await waitUntil(() => tasks.capabilities);
  const task = tasks.propose({ principalId: "fixture-person", agentId: "fixture-agent", conversation: "main" },
    { root: tasks.capabilities.roots[0], purpose: "Transport qualification", access: "write" });
  const start = await tasks.start(task); assert.equal(start.state, "active");
  const run = await tasks.run(task, "cat input.txt; node --test smoke.test.cjs");
  assert.equal(run.exitCode, 0, JSON.stringify(run)); assert.match(run.stdout, /TRANSPORT_CANARY/);
  const running = tasks.run(task, 'printf completed > checkpoint; sleep 30 & child=$!; printf %s "$child" > running.pid; wait');
  await waitUntil(() => existsSync(join(start.workspace, "running.pid")));
  const cancelling = tasks.end(task, "cancel");
  await assert.rejects(tasks.run(task, "touch must-not-run"), /not active/);
  const stopped = await cancelling; await running;
  report.receipt = stopped;
  assert.equal(stopped.authorization, "revoked"); assert.equal(stopped.cleanup.managedProcesses, "stopped");
  assert.equal(stopped.cleanup.detachedProcesses, "may-remain");
  assert.equal(readFileSync(join(start.workspace, "checkpoint"), "utf8"), "completed");
  assert.equal(existsSync(join(source, "checkpoint")), false); assert.equal(existsSync(join(start.workspace, "must-not-run")), false);
  client.stop(); await waitUntil(() => !tasks.capabilities);
  client.start(true); await waitUntil(() => tasks.capabilities);
  await assert.rejects(tasks.run(task, "touch replay"), /connection changed/);
  report.passed = true; report.receipt = stopped;
} finally {
  client.stop(); tasks.disconnect(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`${report.passed ? "PASS" : "FAIL"} packaged worker / transport: ${reportPath}`);
}
