/**
 * Cancel: what a person is told when they stop a command on the Mac, and what happens to the group.
 *
 * Three outcomes, because they mean different things to whoever reads the transcript:
 *   - it never went out            「已取消，未执行」
 *   - it went out, never started   「已取消，未执行」
 *   - it had started               「已取消，可能已执行」 — the signal is a promise, not an undo
 * A command that already finished is `already_completed`, which is a fact, not a failure.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { HostExecStore } from "./host-exec-store.ts";
import { DesktopHostRunner } from "./host-runner.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RUNNER = join(ROOT, "electron", "host-exec-runner.ts");

function store(graceMs = 20) {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-hostexec-"));
  return new HostExecStore(join(dir, "pending.jsonl"), { graceMs });
}

function seat() {
  const frames: { type: string; id: string; agent: string | null; command: string; timeoutMs: number }[] = [];
  return { frames, write: (frame: string) => frames.push(JSON.parse(frame.replace(/^data: /, "").trim())) };
}

const result = { stdout: "", stderr: "", code: 0, timedOut: false, truncatedBytes: 0 };

/** A run() left hanging holds a 450-second timer; settle it so the test process can end. */
async function drain(runner: DesktopHostRunner, id: string, pending: Promise<unknown>) {
  runner.settle({ id, refused: "cancelled in a test" });
  await pending.catch(() => {});
}

test("an id that never went out is cancelled as not run, and nothing is sent", async () => {
  const runner = new DesktopHostRunner({ store: store() });
  const s = seat();
  runner.attach(s.write);
  const decision = runner.cancel("never-sent");
  assert.equal(decision.outcome, "not_sent");
  assert.equal(decision.text, "已取消，未执行");
  assert.equal(s.frames.filter(frame => frame.type === "cancel").length, 0, "there is nothing to cancel on the Mac");
});

test("sent but not started: cancelled as not run, and the Mac is told", async () => {
  const runner = new DesktopHostRunner({ store: store() });
  const s = seat();
  runner.attach(s.write);
  const pending = runner.run("rm -rf build");
  const id = s.frames[0]!.id;

  const decision = runner.cancel(id);
  assert.equal(decision.outcome, "not_started");
  assert.equal(decision.text, "已取消，未执行");
  const frame = s.frames.at(-1);
  assert.equal(frame?.type, "cancel");
  assert.equal((frame as { id?: string }).id, id);
  const again = runner.cancel(id);
  assert.equal(again.text, decision.text, "a repeated cancel says the same thing");
  assert.equal(s.frames.filter(one => one.type === "cancel").length, 1, "and sends nothing more");
  await drain(runner, id, pending);
});

test("started: cancelled as may-have-run", async () => {
  const runner = new DesktopHostRunner({ store: store() });
  const s = seat();
  runner.attach(s.write);
  const pending = runner.run("npm test");
  const id = s.frames[0]!.id;
  assert.equal(runner.settle({ id, started: true }), true);

  const decision = runner.cancel(id);
  assert.equal(decision.outcome, "running");
  assert.equal(decision.text, "已取消，可能已执行");
  assert.equal(runner.cancel(id).text, "已取消，可能已执行", "idempotent");
  await drain(runner, id, pending);
});

test("a finished command is already_completed, not an error", async () => {
  const runner = new DesktopHostRunner({ store: store() });
  const s = seat();
  runner.attach(s.write);
  const pending = runner.run("pwd");
  const id = s.frames[0]!.id;
  runner.settle({ id, result });
  await pending;

  const decision = runner.cancel(id);
  assert.equal(decision.outcome, "already_completed");
  assert.equal(decision.text, "already_completed");
  assert.equal(s.frames.filter(frame => frame.type === "cancel").length, 0);
});

/** The pid the runner announces for the group it detached, once it has said so. */
function firstStartedPid(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("the runner announced no pid")), 20_000);
    child.stdout?.on("data", chunk => {
      buffer += String(chunk);
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        try {
          const parsed = JSON.parse(line) as { started?: boolean; pid?: number };
          if (parsed.started === true && typeof parsed.pid === "number") {
            clearTimeout(timer);
            resolve(parsed.pid);
            return;
          }
        } catch {}
      }
    });
    child.on("error", reject);
  });
}

function killGroup(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {}
  }
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {}
  try {
    process.kill(pid, 0);
    return true;
  } catch {}
  return false;
}

const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));

test("a running group dies within two seconds, and the wording says it may have run", async () => {
  const runner = new DesktopHostRunner({ store: store() });
  const s = seat();
  runner.attach(s.write);
  const pending = runner.run("sleep 300");
  const id = s.frames[0]!.id;
  runner.settle({ id, started: true });

  // A real command group on this machine, started the way the Mac starts it.
  const child = spawn(process.execPath, ["--experimental-transform-types", "--no-warnings", RUNNER], { stdio: ["pipe", "pipe", "pipe"] });
  const closed = new Promise(done => child.on("close", done));
  child.stdin?.end(JSON.stringify({ phase: "run", command: "sleep 300" }));
  try {
    const pid = await firstStartedPid(child);
    assert.equal(groupAlive(pid), true, "the group is running before the cancel");

    const decision = runner.cancel(id);
    assert.equal(decision.outcome, "running");
    assert.equal(decision.text, "已取消，可能已执行");

    // The Mac's half (electron/main.cjs): SIGTERM, a second, SIGKILL, then wait for the end.
    const startedAt = Date.now();
    killGroup(pid, "SIGTERM");
    setTimeout(() => killGroup(pid, "SIGKILL"), 1000);
    while (groupAlive(pid) && Date.now() - startedAt < 3000) await sleep(25);
    const elapsed = Date.now() - startedAt;
    assert.equal(groupAlive(pid), false, "the group is gone");
    assert.ok(elapsed < 2000, `gone in ${elapsed}ms`);
  } finally {
    await drain(runner, id, pending);
    killGroup(Number((child as { pid?: number }).pid ?? 0), "SIGKILL");
    // A race against a timer leaves that timer running; clear it, or the test process waits it out.
    let guard: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([closed, new Promise(done => { guard = setTimeout(done, 2000); })]);
    clearTimeout(guard);
  }
});