/**
 * Tests for DesktopHostRunner: RunOnHost carried to the person's Mac.
 *
 * The claims that matter: the tool exists only while a Mac is connected, a command whose answer
 * never comes back is reported as unknown and never replayed, and vault secrets stay here.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { DesktopHostRunner } from "./host-runner.ts";

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
  const runner = new DesktopHostRunner();
  const s = seat();
  const id = runner.attach(s.write);
  const pending = runner.run("sleep 60");
  runner.detach(id);
  await assert.rejects(pending, /result is unknown/);
  assert.equal(runner.settle({ id: s.frames[0]?.id, result: {} }), false);
});

test("a newer connection replaces the older one, and the old close changes nothing", async () => {
  const runner = new DesktopHostRunner();
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
