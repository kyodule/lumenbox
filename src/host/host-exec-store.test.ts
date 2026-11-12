/**
 * The ledger of commands in flight to the person's Mac, and the grace a disconnect gets.
 *
 * The claims: a command's state survives the stream that carried it, a Mac that comes back inside
 * the grace settles the command it was still holding, and nothing is ever sent twice because of
 * what the ledger says.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HostExecStore } from "./host-exec-store.ts";
import { DesktopHostRunner } from "./host-runner.ts";

function store(graceMs = 20) {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-hostexec-"));
  return { store: new HostExecStore(join(dir, "pending.jsonl"), { graceMs }), dir };
}

function seat() {
  const frames: { type: string; id: string; agent: string | null; command: string; timeoutMs: number }[] = [];
  return { frames, write: (frame: string) => frames.push(JSON.parse(frame.replace(/^data: /, "").trim())) };
}

const result = { stdout: "hi\n", stderr: "", code: 0, timedOut: false, truncatedBytes: 0 };

test("an id the ledger never saw is unknown, never 'safe to re-run'", () => {
  const { store: ledger } = store();
  assert.deepEqual(ledger.status("nope"), { state: "unknown", started: false });
});

test("sent, then done with its result: the record outlives the stream", async () => {
  const { store: ledger } = store();
  const runner = new DesktopHostRunner({ store: ledger });
  const s = seat();
  runner.attach(s.write);
  const pending = runner.run("pwd", {}, undefined, "Ada");
  const id = s.frames[0]?.id;
  assert.ok(id);
  assert.equal(ledger.status(id).state, "sent", "written before the frame left");

  assert.equal(runner.settle({ id, started: true }), true);
  assert.equal(ledger.status(id).started, true);
  assert.equal(runner.settle({ id, result }), true);
  assert.deepEqual(await pending, result);

  assert.deepEqual(ledger.status(id).result, result);
  const first = ledger.status(id);
  assert.equal(ledger.status(id).state, "done");
  assert.deepEqual(ledger.status(id), first, "asking twice says the same thing");

  // A finished command is not cancellable; that is a fact about it, not an error.
  const cancelled = runner.cancel(id);
  assert.equal(cancelled.outcome, "already_completed");
  assert.equal(cancelled.text, "already_completed");
  void first;
});

test("a disconnected stream marks the command unknown after the grace, and never re-sends it", async () => {
  const { store: ledger } = store(30);
  const runner = new DesktopHostRunner({ store: ledger });
  const s = seat();
  const seatId = runner.attach(s.write);
  const pending = runner.run("sleep 60");
  const id = s.frames[0]?.id;
  assert.ok(id);
  runner.detach(seatId);

  assert.equal(ledger.status(id).state, "unknown", "the ledger says unknown at once");
  await assert.rejects(pending, /result is unknown/);
  assert.equal(ledger.status(id).state, "unknown");
  assert.equal(s.frames.length, 1, "the command went out exactly once");
});

test("a Mac that comes back inside the grace settles the command it was holding", async () => {
  const { store: ledger } = store(500);
  const runner = new DesktopHostRunner({ store: ledger });
  const first = seat();
  const firstSeat = runner.attach(first.write);
  const pending = runner.run("make test");
  const id = first.frames[0]?.id;
  assert.ok(id);
  runner.detach(firstSeat);

  // The Mac reconnects on a new stream, still holding the command, and answers it.
  const second = seat();
  runner.attach(second.write);
  await new Promise(done => setTimeout(done, 20));
  assert.equal(runner.settle({ id, result }), true, "the id was still waiting");
  assert.deepEqual(await pending, result);
  assert.deepEqual(ledger.status(id).result, result);
  assert.equal(ledger.status(id).state, "done");
  assert.equal(first.frames.length, 1, "no re-dispatch: the frame count did not grow");
  assert.equal(second.frames.length, 0, "and the new seat was not asked to run it again");
});

test("startup drops done rows older than a day and keeps the rest", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-hostexec-"));
  const file = join(dir, "pending.jsonl");
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  const recent = new Date(Date.now() - 60 * 1000).toISOString();
  writeFileSync(file, [
    JSON.stringify({ id: "old-done", at: old, state: "done", result }),
    JSON.stringify({ id: "recent-done", at: recent, state: "done", result }),
    JSON.stringify({ id: "old-unknown", at: old, state: "unknown" }),
    JSON.stringify({ id: "old-sent", at: old, state: "sent" }),
  ].join("\n") + "\n");

  const ledger = new HostExecStore(file, { graceMs: 20 });
  assert.equal(ledger.status("old-done").state, "unknown", "a day-old done row was cleaned");
  assert.equal(ledger.status("recent-done").state, "done");
  assert.equal(ledger.status("old-unknown").state, "unknown", "an unknown outcome is kept: it is the evidence");
  assert.equal(ledger.status("old-sent").state, "sent", "a command that never came back is kept too");
});