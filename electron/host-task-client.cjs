// LUMENBOX-FORK: authenticated SSE transport. This process never evaluates remote commands.
const { spawn } = require("node:child_process");
const { existsSync, readFileSync, writeFileSync, watchFile } = require("node:fs");
const path = require("node:path");

class HostTaskClient {
  constructor({ configPath, page, client, headers, executable, log, onStatus }) {
    Object.assign(this, { configPath, page, client, headers, executable, log, onStatus });
    this.generation = 0;
    this.status = "Project tasks: not connected";
    this.outbox = new Map();
  }
  setStatus(status) { this.status = status; this.onStatus?.(); }
  start(enabled) {
    this.stop();
    if (!enabled || process.platform !== "darwin" || !existsSync(this.configPath)) return;
    const generation = this.generation;
    // Only the worker gets this environment. The UI token remains in the App transport.
    const env = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin", ELECTRON_RUN_AS_NODE: "1", LANG: "en_US.UTF-8" };
    const worker = spawn(this.executable, ["--experimental-transform-types", "--no-warnings", path.join(__dirname, "host-task-worker.ts"), this.configPath],
      { env, stdio: ["pipe", "pipe", "pipe"] });
    this.worker = worker;
    worker.stdin.on("error", () => {});
    let buffer = "", unavailable;
    worker.stdout.setEncoding("utf8");
    worker.stdout.on("data", chunk => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer) > 900_000) { this.stop(); return; }
      let pos;
      while ((pos = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, pos); buffer = buffer.slice(pos + 1);
        try {
          const message = JSON.parse(line);
          if (message.event) { this.post(message); continue; }
          if (generation !== this.generation) continue;
          if (message.type === "ready") this.connect(message.capabilities, generation);
          else if (message.type === "unavailable") { unavailable = `Project tasks unavailable: ${message.error}`; this.setStatus(unavailable); this.log(this.status); }
        } catch { this.stop(); }
      }
    });
    worker.stderr.on("data", () => {}); // no unbounded output retained in the App
    worker.on("error", error => { this.log(`host task worker: ${error.message}`); this.stop(); this.setStatus(`Project tasks unavailable: ${error.message}`); });
    worker.on("exit", () => { if (generation === this.generation) { this.stop(); if (unavailable) this.setStatus(unavailable); } });
  }
  stop() {
    ++this.generation;
    clearTimeout(this.retry); clearInterval(this.watchdog);
    this.request?.destroy(); this.request = null;
    const worker = this.worker; this.worker = null;
    if (worker) {
      try { worker.stdin.end(`${JSON.stringify({ type: "stop" })}\n`); } catch {}
      const timer = setTimeout(() => worker.kill("SIGKILL"), 3000); timer.unref();
      worker.once("exit", () => clearTimeout(timer));
    }
    this.setStatus("Project tasks: not connected");
  }
  write(message) { if (this.worker?.stdin.writable) this.worker.stdin.write(`${JSON.stringify(message)}\n`); }
  connect(capabilities, generation) {
    let lost = false;
    const disconnect = () => {
      if (lost || generation !== this.generation) return;
      lost = true; this.stop(); // revoke immediately; never wait for the reconnect timer
      const next = this.generation;
      this.retry = setTimeout(() => { if (next === this.generation) this.start(true); }, 3000);
    };
    let heartbeat = Date.now();
    this.watchdog = setInterval(() => { if (Date.now() - heartbeat > 30_000) disconnect(); }, 1000);
    this.watchdog.unref();
    this.request = this.client.get(`${this.page}api/host-task/stream`, { headers: { ...this.headers,
      "x-lumenbox-host-task": Buffer.from(JSON.stringify(capabilities)).toString("base64") } }, response => {
      if (response.statusCode !== 200) { response.resume(); disconnect(); return; }
      this.setStatus(`Project tasks: ${capabilities.roots.length} project(s), network off; detached work may remain after stop`);
      this.log("host tasks: connected with a qualified local executor");
      let buffer = "";
      response.setEncoding("utf8");
      response.on("data", chunk => {
        if (generation !== this.generation) return;
        heartbeat = Date.now(); this.write({ type: "heartbeat" }); this.write({ type: "drain" });
        buffer += chunk.toString("utf8");
        if (Buffer.byteLength(buffer) > 64_000) { disconnect(); return; }
        let end;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          for (const line of frame.split("\n")) if (line.startsWith("data:")) {
            try { const message = JSON.parse(line.slice(5)); if (["hello", "job"].includes(message.type)) this.write(message); }
            catch { disconnect(); return; }
          }
        }
      });
      response.on("end", disconnect); response.on("close", disconnect); response.on("error", disconnect);
    });
    this.request.on("error", disconnect);
  }
  post(answer, attempt = 0) {
    const payload = JSON.stringify(answer);
    if (Buffer.byteLength(payload) > 800_000) { this.log("host tasks: refused oversized result"); return; }
    if (this.outbox.size >= 512 && !this.outbox.has(answer.id)) return;
    // A result supersedes a started event. Retry only receipts, never commands.
    if (attempt === 0) this.outbox.set(answer.id, payload);
    if (this.outbox.get(answer.id) !== payload) return;
    let finished = false;
    const retry = () => {
      if (finished) return; finished = true;
      if (attempt >= 8) { this.outbox.delete(answer.id); this.log(`host tasks: receipt ${answer.id} retained on disk; delivery unconfirmed`); return; }
      const timer = setTimeout(() => this.post(answer, attempt + 1), Math.min(5000, 250 * 2 ** attempt)); timer.unref();
    };
    const request = this.client.request(`${this.page}api/host-task/result`, { method: "POST", headers: { ...this.headers,
      "content-type": "application/json", "content-length": Buffer.byteLength(payload) } }, response => {
      response.resume();
      if (response.statusCode === 200 || response.statusCode === 404) {
        finished = true;
        if (this.outbox.get(answer.id) === payload) this.outbox.delete(answer.id);
        if (answer.event === "result") this.write({ type: "ack", id: answer.id });
      }
      else retry();
    });
    request.setTimeout(10_000, () => request.destroy()); request.on("error", retry); request.end(payload);
  }
  watch(onChange) { watchFile(this.configPath, { interval: 1000 }, onChange); }
  async chooseProjects(dialog, parent) {
    if (!existsSync(this.configPath)) { this.log("host tasks: install the qualified runtime before selecting projects"); return; }
    const picked = await dialog.showOpenDialog(parent, { title: "Projects available to task approvals", properties: ["openDirectory", "multiSelections"] });
    if (picked.canceled || !picked.filePaths.length) return;
    const raw = JSON.parse(readFileSync(this.configPath, "utf8")); raw.roots = picked.filePaths.slice(0, 8);
    writeFileSync(this.configPath, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
  }
}
module.exports = { HostTaskClient };
