/**
 * Tests for DesktopHostRunner: RunOnHost carried to the person's Mac.
 *
 * The claims that matter: the tool exists only while a Mac is connected, a command whose answer
 * never comes back is reported as unknown and never replayed, and vault secrets stay here.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopHostRunner, type HostRunner } from "./host-runner.ts";
import { HostExecStore } from "./host-exec-store.ts";
import { dispatchTool, type ToolContext } from "./tools.ts";

/** A runner with a ledger in a temp dir and a grace short enough for a test to wait on. */
function withStore(graceMs = 20) {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-hostexec-"));
  return { runner: new DesktopHostRunner({ store: new HostExecStore(join(dir, "pending.jsonl"), { graceMs }) }), dir };
}

function seat() {
  const frames: { type: string; id: string; agent: string | null; command: string; timeoutMs: number }[] = [];
  return { frames, write: (frame: string) => frames.push(JSON.parse(frame.replace(/^data: /, "").trim())) };
}

test("offered only while a Mac is connected", () => {
  const runner = new DesktopHostRunner();
  assert.equal(runner.enabled, false);
  assert.match(runner.unavailableReason() ?? "", /not connected/);
  const id = runner.attach(seat().write);
  assert.equal(runner.enabled, true);
  assert.equal(runner.unavailableReason(), undefined);
  runner.detach(id);
  assert.equal(runner.enabled, false);
});

test("a command goes out on the stream and its answer comes back", async () => {
  const runner = new DesktopHostRunner();
  const s = seat();
  runner.attach(s.write);
  const pending = runner.run("pwd", {}, undefined, "Ada");
  assert.equal(s.frames.length, 1);
  const frame = s.frames[0];
  assert.ok(frame);
  assert.equal(frame.type, "run");
  assert.equal(frame.command, "pwd");
  assert.equal(frame.agent, "Ada");
  assert.equal(runner.settle({ id: frame.id, result: { stdout: "/x\n", stderr: "", code: 0, timedOut: false, truncatedBytes: 0, sandbox: { mechanism: "sandbox-exec" } } }), true);
  const result = await pending;
  assert.equal(result.stdout, "/x\n");
  assert.equal(result.code, 0);
  assert.equal(result.sandbox?.mechanism, "sandbox-exec");
  assert.equal(runner.settle({ id: frame.id, result: {} }), false, "a settled id is not settled twice");
});

test("a refusal on the Mac rejects with its reason", async () => {
  const runner = new DesktopHostRunner();
  const s = seat();
  runner.attach(s.write);
  const pending = runner.run("rm -rf x");
  runner.settle({ id: s.frames[0]?.id, refused: "the person declined on the Mac" });
  await assert.rejects(pending, /Not run on the Mac: the person declined/);
});

test("a disconnect while a command is out reports the result as unknown, never replays", async () => {
  const { runner } = withStore();
  const s = seat();
  const id = runner.attach(s.write);
  const pending = runner.run("sleep 60");
  runner.detach(id);
  await assert.rejects(pending, /result is unknown/);
  assert.equal(runner.settle({ id: s.frames[0]?.id, result: {} }), false);
});

test("a newer connection replaces the older one, and the old close changes nothing", async () => {
  const { runner } = withStore();
  const first = seat();
  const firstId = runner.attach(first.write);
  const pending = runner.run("pwd");
  const second = seat();
  runner.attach(second.write);
  await assert.rejects(pending, /newer connection/);
  runner.detach(firstId);
  assert.equal(runner.enabled, true, "the stale close did not drop the new seat");
});

test("secrets are refused and nothing is sent", async () => {
  const runner = new DesktopHostRunner();
  const s = seat();
  runner.attach(s.write);
  assert.equal(runner.refusesSecrets, true);
  await assert.rejects(runner.run("git push", { GITHUB_TOKEN: "x" }), /Secrets are not sent/);
  assert.equal(s.frames.length, 0);
});

test("no Mac means a refusal with the reason, and nothing pending", async () => {
  const runner = new DesktopHostRunner();
  await assert.rejects(runner.run("pwd"), /not connected/);
});

test("a write that throws means the command did not run", async () => {
  const runner = new DesktopHostRunner();
  runner.attach(() => {
    throw new Error("socket closed");
  });
  await assert.rejects(runner.run("pwd"), /did not run/);
});

test("serve answers only its two routes, admin only, and the stream's close detaches the Mac", async () => {
  const runner = new DesktopHostRunner();
  const sent: { status: number; body: unknown }[] = [];
  const send = (_res: ServerResponse, status: number, body: unknown) => void sent.push({ status, body });
  const chunks: string[] = [];
  const res = { writeHead: () => res, write: (chunk: string) => chunks.push(chunk) > 0 } as unknown as ServerResponse;
  const req = Object.assign(new EventEmitter(), {}) as unknown as IncomingMessage;
  const admin = () => false;
  const noBody = async () => ({});

  assert.equal(await runner.serve("GET /api/events", req, res, send, admin, noBody), false, "other routes fall through");
  assert.equal(await runner.serve("GET /api/host-exec/stream", req, res, send, () => true, noBody), true);
  assert.equal(runner.enabled, false, "a refused role attaches nothing");

  assert.equal(await runner.serve("GET /api/host-exec/stream", req, res, send, admin, noBody), true);
  assert.equal(runner.enabled, true);
  const pending = runner.run("pwd");
  const frame = JSON.parse((chunks.at(-1) ?? "").replace(/^data: /, "").trim()) as { id: string };
  const answer = async () => ({ id: frame.id, result: { stdout: "/x\n", stderr: "", code: 0 } });
  assert.equal(await runner.serve("POST /api/host-exec/result", req, res, send, admin, answer), true);
  assert.deepEqual(sent.at(-1), { status: 200, body: { ok: true } });
  assert.equal((await pending).stdout, "/x\n");

  req.emit("close");
  assert.equal(runner.enabled, false, "the stream closing is the Mac going away");
});

test("the agent's name reaches the Mac through the tool dispatch, which is where it was missing", async () => {
  // The direct runner call below has always carried the name; the bug was that RunOnHost's
  // dispatch never passed it, so the dialog said "An agent" and the audit said `"agent":null`.
  const calls: unknown[][] = [];
  const stub = {
    enabled: true,
    refusesSecrets: false,
    run: async (...args: unknown[]) => {
      calls.push(args);
      return { stdout: "ok\n", stderr: "", code: 0, timedOut: false, truncatedBytes: 0 };
    },
  } as unknown as HostRunner;
  const context = {
    agent: { id: "agent-1", profile: { name: "Ada" } } as unknown as ToolContext["agent"],
    hostRunner: stub,
  } as ToolContext;
  const outcome = await dispatchTool("RunOnHost", { command: "pwd" }, context);
  assert.notEqual(outcome.isError, true, outcome.text);
  assert.equal(calls[0]?.[0], "pwd");
  assert.equal(calls[0]?.[3], "Ada", "the 4th argument is the agent name the Mac's dialog and its audit show");
});
