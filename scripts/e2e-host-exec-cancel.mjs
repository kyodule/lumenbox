#!/usr/bin/env node
// E2E for the RunOnHost transport: the real web server, the real DesktopHostRunner, the SSE stream,
// the two ledger routes, and the real Electron-Node runner process.
//
// Usage, from the repository root:
//   node --experimental-transform-types scripts/e2e-host-exec-cancel.mjs
// Exit code 0 means both scenarios passed; anything else prints the step it stopped at.
//
// Prerequisites:
//   - macOS with LumenBox.app installed at /Applications (its bundled Node runs the runner).
//     Override with LUMENBOX_APP_BIN=/path/to/LumenBox.
//   - Port 7791 free on 127.0.0.1 (override with E2E_PORT).
//   - Nothing else: no model, no provider key, no API call is made.
//
// What it does NOT cover: the App's own half (electron/main.cjs) — this script plays the Mac with
// the same steps, so the cancel frame -> queue removal -> group kill path inside the App is still
// only covered by unit tests.
//
// The one test seam: it wraps DesktopHostRunner.prototype.control to capture the instance the
// server builds (nothing about its behaviour is replaced), then calls runner.run() directly. That
// is the same method a real agent call reaches.

// E2E over the real pieces: startWebServer, DesktopHostRunner.run, the SSE stream, the two ledger
// routes, and the real Electron-Node runner process. The only test seam is capturing the runner
// instance the server builds (nothing about its behaviour is replaced).
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.E2E_PORT ?? 7791);
const TOKEN = "e2e-token";
const ELECTRON = process.env.LUMENBOX_APP_BIN ?? "/Applications/LumenBox.app/Contents/MacOS/LumenBox";
process.env.AGENTBOX_HOME = mkdtempSync(join(tmpdir(), "lb-e2e-home-"));
process.env.AGENTBOX_HOST_EXEC = "desktop";

const { DesktopHostRunner } = await import("../src/host/host-runner.ts");
const { startWebServer } = await import("../src/web/server.ts");
const { resolveProvider } = await import("../src/host/provider.ts");

let runner;
const original = DesktopHostRunner.prototype.control;
DesktopHostRunner.prototype.control = async function (...args) {
  runner = this;
  return original.apply(this, args);
};

await startWebServer({
  port: PORT,
  host: "127.0.0.1",
  token: TOKEN,
  provider: resolveProvider("anthropic"),
  useBox: false,
});
const base = `http://127.0.0.1:${PORT}`;
const auth = { authorization: `Bearer ${TOKEN}` };
const sleep = ms => new Promise(done => setTimeout(done, ms));

/** The Mac's half: one SSE connection, parsed into frames, with a handler per frame type. */
function macConnection(name) {
  const frames = [];
  const controller = new AbortController();
  const waiters = [];
  const deliver = frame => {
    frames.push(frame);
    for (const waiter of [...waiters]) if (waiter.match(frame)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(frame); }
  };
  const ready = fetch(`${base}/api/host-exec/stream`, { headers: auth, signal: controller.signal }).then(response => {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let boundary = buffer.indexOf("\n\n");
          while (boundary >= 0) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            boundary = buffer.indexOf("\n\n");
            for (const line of frame.split("\n")) {
              if (!line.startsWith("data:")) continue;
              try { deliver(JSON.parse(line.slice(5))); } catch {}
            }
          }
        }
      } catch {}
    })();
    return response;
  });
  return {
    frames,
    ready,
    next(match, timeoutMs = 5000) {
      const found = frames.find(match);
      if (found !== undefined) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${name}: no matching frame within ${timeoutMs}ms`)), timeoutMs);
        waiters.push({ match, resolve: frame => { clearTimeout(timer); resolve(frame); } });
      });
    },
    close() { controller.abort(); },
  };
}

/** Start `sleep N` the way the App does: the real runner, as a detached process group. */
function startRunChild(command, timeoutMs) {
  const child = spawn(ELECTRON, ["--experimental-transform-types", "--no-warnings", join(ROOT, "electron", "host-exec-runner.ts")], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", LUMENBOX_APP_ROOT: ROOT },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const started = new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("the runner announced no pid")), 15_000);
    child.stdout.on("data", chunk => {
      buffer += String(chunk);
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        try {
          const parsed = JSON.parse(line);
          if (parsed.started === true && typeof parsed.pid === "number") { clearTimeout(timer); resolve(parsed.pid); }
        } catch {}
      }
    });
    child.on("error", reject);
  });
  const closed = new Promise(done => child.on("close", code => done(code)));
  child.stdin.end(JSON.stringify({ phase: "run", command, timeoutMs }));
  return { child, started, closed };
}

const groupAlive = pid => {
  try { process.kill(-pid, 0); return true; } catch {}
  try { process.kill(pid, 0); return true; } catch {}
  return false;
};
const killGroup = (pid, signal) => {
  try { process.kill(-pid, signal); } catch { try { process.kill(pid, signal); } catch {} }
};

import { existsSync } from "node:fs";
if (!existsSync(ELECTRON)) {
  console.error(`missing ${ELECTRON}: install LumenBox.app (or set LUMENBOX_APP_BIN) — its bundled Node runs the runner`);
  process.exit(2);
}

const results = {};

// ── 1–5: a run, a real cancel, and the group dying ──────────────────────────────────────────
const mac = macConnection("mac-1");
await mac.ready;
if (runner === undefined) throw new Error("the server built no DesktopHostRunner");
console.log("server runner captured:", runner.constructor.name, "enabled:", runner.enabled);

const running = runner.run("sleep 60", {}, undefined, "Ada");
running.catch(() => {}); // a cancelled command rejects on purpose; handled here so it is not unhandled
const runFrame = await mac.next(frame => frame.type === "run");
console.log("1. server dispatched:", JSON.stringify(runFrame));

const { started, closed } = startRunChild("sleep 60", 60_000);
const pid = await started;
console.log("2. runner announced:", JSON.stringify({ started: true, pid }));
const startedPost = await fetch(`${base}/api/host-exec/result`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ id: runFrame.id, started: true }) });
console.log("3. POST started:", startedPost.status);

// The Mac's half of a cancel: it sees the frame and kills the group (electron/main.cjs does this).
const cancelledFrame = mac.next(frame => frame.type === "cancel");
const cancelResponse = await fetch(`${base}/api/host-exec/cancel`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ id: runFrame.id }) });
const cancelBody = await cancelResponse.json();
console.log("4. POST cancel:", cancelResponse.status, JSON.stringify(cancelBody));
const frameSeen = await cancelledFrame;
console.log("5. Mac received:", JSON.stringify(frameSeen));

const killStart = Date.now();
killGroup(pid, "SIGTERM");
setTimeout(() => killGroup(pid, "SIGKILL"), 1000);
while (groupAlive(pid) && Date.now() - killStart < 3000) await sleep(25);
const goneMs = Date.now() - killStart;
let esrch = false;
try { process.kill(-pid, 0); } catch (error) { esrch = error.code === "ESRCH"; }
console.log("6. group gone:", !groupAlive(pid), "in", goneMs, "ms; kill(-pid,0) ESRCH:", esrch);
console.log("7. runner child exited:", await Promise.race([closed, sleep(3000).then(() => "timeout")]));
await fetch(`${base}/api/host-exec/result`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ id: runFrame.id, refused: cancelBody.text }) });
console.log("8. pending run settled:", await running.then(() => "resolved", error => `rejected: ${error.message}`));

results.cancel = { cancelBody, pid, goneMs, esrch };
const statusAfterCancel = await (await fetch(`${base}/api/host-exec/status?id=${runFrame.id}`, { headers: auth })).json();
console.log("9. status after cancel:", JSON.stringify(statusAfterCancel));
mac.close();

// ── 6–8: a run lost with the stream, reconnected, and asked about ───────────────────────────
const first = macConnection("mac-2");
await first.ready;
const reconnecting = runner.run("sleep 5", {}, undefined, "Ada");
reconnecting.catch(() => {});
const lostFrame = await first.next(frame => frame.type === "run");
console.log("10. dispatched then dropped:", JSON.stringify(lostFrame));
first.close();                              // the stream goes away while the command is out
await sleep(3000);                          // the Mac comes back
const second = macConnection("mac-3");
await second.ready;
const resultBody = { stdout: "slept 5\n", stderr: "", code: 0, timedOut: false, truncatedBytes: 0 };
const post = await fetch(`${base}/api/host-exec/result`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ id: lostFrame.id, result: resultBody }) });
console.log("11. POST result after reconnect:", post.status);
const status = await (await fetch(`${base}/api/host-exec/status?id=${lostFrame.id}`, { headers: auth })).json();
console.log("12. status:", JSON.stringify(status));
console.log("13. pending run resolved with:", JSON.stringify(await reconnecting));
second.close();

const okCancel = cancelBody.outcome === "running" && cancelBody.text === "已取消，可能已执行" && esrch;
const okReconnect = status.state === "done" && JSON.stringify(status.result) === JSON.stringify(resultBody);
console.log("VERDICT cancel:", okCancel ? "PASS" : "FAIL", "| reconnect:", okReconnect ? "PASS" : "FAIL");
process.exit(okCancel && okReconnect ? 0 : 1);
