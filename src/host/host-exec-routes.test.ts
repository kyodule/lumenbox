/**
 * The ledger's two routes: status by request_id, and cancel.
 *
 * These are what make A.3 and B.2 real — a person holding a request_id after a disconnect can ask
 * what became of the command, and can stop one. Both sit behind the same admin guard as the Mac's
 * own routes, because both are a door to that machine.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HostExecStore, serveLedger } from "./host-exec-store.ts";
import { DesktopHostRunner } from "./host-runner.ts";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-hostexec-routes-"));
  const ledger = new HostExecStore(join(dir, "pending.jsonl"), { graceMs: 20 });
  const runner = new DesktopHostRunner({ store: ledger });
  const frames: { type: string; id: string }[] = [];
  runner.attach(frame => frames.push(JSON.parse(frame.replace(/^data: /, "").trim())));
  const sent: { status: number; body: unknown }[] = [];
  const send = (_res: ServerResponse, status: number, body: unknown) => void sent.push({ status, body });
  const res = {} as ServerResponse;
  const admin = () => false;
  return { ledger, runner, frames, sent, send, res, admin };
}

const get = (id: string) => ({ url: `/api/host-exec/status?id=${encodeURIComponent(id)}` }) as IncomingMessage;
const post = (body: unknown) => (({ url: "/api/host-exec/cancel" }) as IncomingMessage);
const bodyReader = (body: unknown) => async () => body;
const noopReader = async () => ({});

test("GET status: a request_id the ledger never saw is not_found", async () => {
  const { runner, sent, send, res, admin } = fixture();
  assert.equal(await serveLedger("GET /api/host-exec/status", get("nope"), res, send, admin, noopReader, runner), true);
  assert.deepEqual(sent.at(-1), { status: 200, body: { state: "not_found", started: false } });
});

test("GET status: a command that went out reads as sent, and one that finished carries its result", async () => {
  const { ledger, runner, sent, send, res, admin } = fixture();
  ledger.sent("r1", "Ada", "pwd");
  assert.equal(await serveLedger("GET /api/host-exec/status", get("r1"), res, send, admin, noopReader, runner), true);
  assert.equal((sent.at(-1)?.body as { state?: string }).state, "sent");

  const result = { stdout: "/x\n", stderr: "", code: 0, timedOut: false, truncatedBytes: 0 };
  ledger.settled("r1", { result });
  assert.equal(await serveLedger("GET /api/host-exec/status", get("r1"), res, send, admin, noopReader, runner), true);
  const body = sent.at(-1)?.body as { state?: string; result?: unknown };
  assert.equal(body.state, "done");
  assert.deepEqual(body.result, result);
});

test("POST cancel: a pending command is cancelled on the Mac, and the answer says which case it was", async () => {
  const { runner, frames, sent, send, res, admin } = fixture();
  const pending = runner.run("rm -rf build");
  const id = frames[0]!.id;
  assert.equal(await serveLedger("POST /api/host-exec/cancel", post({ id }), res, send, admin, bodyReader({ id }), runner), true);
  assert.deepEqual(sent.at(-1), { status: 200, body: { outcome: "not_started", text: "已取消，未执行" } });
  assert.equal(frames.filter(frame => frame.type === "cancel").length, 1, "the frame went to the Mac");
  runner.settle({ id, refused: "cancelled in a test" });
  await pending.catch(() => {});
});

test("POST cancel: a lost outcome is answered without asking the Mac to guess", async () => {
  const { ledger, runner, frames, sent, send, res, admin } = fixture();
  ledger.sent("lost", "Ada", "sleep 300");
  ledger.unknown("lost");
  assert.equal(await serveLedger("POST /api/host-exec/cancel", post({ id: "lost" }), res, send, admin, bodyReader({ id: "lost" }), runner), true);
  assert.deepEqual(sent.at(-1), { status: 200, body: { outcome: "unknown", text: "结果未知，无法取消；先确认它是否执行过" } });
  assert.equal(frames.filter(frame => frame.type === "cancel").length, 0);
});

test("both routes are admin-only: a refused role answers nothing", async () => {
  const { runner, sent, send, res } = fixture();
  const refused = () => true;
  assert.equal(await serveLedger("GET /api/host-exec/status", get("x"), res, send, refused, noopReader, runner), true);
  assert.equal(await serveLedger("POST /api/host-exec/cancel", post({ id: "x" }), res, send, refused, bodyReader({ id: "x" }), runner), true);
  assert.equal(sent.length, 0, "no body was sent");
});

test("both routes need an id, and other routes fall through to serve()", async () => {
  const { runner, sent, send, res, admin } = fixture();
  assert.equal(await serveLedger("GET /api/host-exec/status", get(""), res, send, admin, noopReader, runner), true);
  assert.deepEqual(sent.at(-1), { status: 400, body: { error: "id is required" } });
  assert.equal(await serveLedger("POST /api/host-exec/cancel", post({}), res, send, admin, bodyReader({}), runner), true);
  assert.deepEqual(sent.at(-1), { status: 400, body: { error: "id is required" } });
  assert.equal(await serveLedger("GET /api/events", get("x"), res, send, admin, noopReader, runner), false);
  assert.equal(await serveLedger("POST /api/host-exec/result", post({}), res, send, admin, bodyReader({}), runner), false);
});