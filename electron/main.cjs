/**
 * The desktop shell.
 *
 * Thin on purpose: every feature lives in the web UI the orchestrator serves, so this
 * process does exactly three jobs — supervise that server as a child process, wrap the
 * page in a window whose top bar is the title bar, and keep a tray presence so "is
 * anything working" is answerable without opening the window.
 *
 * The supervisor is what makes the settings dialog's "Save & restart" seamless: the
 * server exits with code 75 (EX_TEMPFAIL, mirrored from src/web/server.ts) to mean
 * "start me again with the new config", and any other non-zero exit is a crash —
 * restarted a bounded number of times, then reported, because a crash loop that
 * restarts itself forever is worse than a window that says what broke.
 *
 * Quitting the shell kills the server child; the Docker box keeps running — it is a
 * separate daemon and always was. The tray's quit item says so.
 */

const {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  Notification,
  Tray,
  dialog,
  nativeImage,
  nativeTheme,
  powerMonitor,
  session,
  shell,
} = require("electron");
const { execFile, spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { desktopAuth } = require("./ui-auth.cjs");
const { dockSignals, shellWordsReader } = require("./dock-signals.cjs");
const { syncLoginItem } = require("./login-item.cjs");
const { windowOpenAction } = require("./external-links.cjs");
const { systemKeychain } = require("./keychain.cjs");
const { connectionStore } = require("./organisations.cjs");
const { organisationWindows, signInWindow } = require("./organisation-windows.cjs");
const { installationViews } = require("./installation-views.cjs");
const { MachineUseRefused, machineUseCalls, machineUseStore, runsPersonalInstallation, startupUse } = require("./machine-use.cjs");
const { JoinRefused, NODE_KEYCHAIN_SERVICE, NODE_REVOKED_EXIT, NodeRefused, organisationNode } = require("./organisation-node.cjs");
// LUMENBOX-REMOTE-PATCH v2: connect-to-server mode (upstream docs/36 stage 7, not shipped
// as of 0.3.8). ~/.agentbox/remote.json = {"url":"https://…","token":"…"} makes this shell a
// seat for a server elsewhere; delete the file to get the local server back.
const REMOTE_FILE = path.join(process.env.AGENTBOX_HOME || path.join(os.homedir(), ".agentbox"), "remote.json");
let REMOTE_ERROR = null;
const REMOTE = loadRemoteTarget();
/**
 * The UI credential of the personal installation, made the first time it is needed — when the
 * personal installation starts — and not when the shell loads: desktopAuth writes
 * ~/.agentbox/ui-token, and a first run that has not chosen yet, or an organisation node, has no
 * ~/.agentbox (INV-1696).
 */
let desktopAuthValue = null;
const personalAuth = () => (desktopAuthValue ??= REMOTE ? desktopAuth({ AGENTBOX_UI_TOKEN: REMOTE.token }) : desktopAuth());
const uiAuth = {
  get token() { return personalAuth().token; },
  get headers() { return personalAuth().headers; },
  bootstrapUrl: base => personalAuth().bootstrapUrl(base),
};

function loadRemoteTarget() {
  if (!fs.existsSync(REMOTE_FILE)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(REMOTE_FILE, "utf8"));
    const url = typeof parsed.url === "string" ? parsed.url.trim() : "";
    const token = typeof parsed.token === "string" ? parsed.token.trim() : "";
    // Plain http would hand the UI token to anyone on the path; the server refuses it too.
    if (!/^https:\/\/[^/\s]+/.test(url)) throw new Error("url must start with https://");
    if (token === "") throw new Error("token is empty");
    return { url: `${url.replace(/\/+$/, "")}/`, token };
  } catch (err) {
    // Loud rather than a silent fallback: starting the local server instead would look like
    // the remote installation lost every agent.
    REMOTE_ERROR = `${REMOTE_FILE}: ${err.message}. Fix it, or delete it to run the local server.`;
    return null;
  }
}

const PORT = Number(process.env.LUMENBOX_PORT || 7777);
const PAGE = REMOTE ? REMOTE.url : `http://127.0.0.1:${PORT}/`;
const pageClient = PAGE.startsWith("https:") ? https : http;
/** Mirrors RESTART_EXIT_CODE in src/web/server.ts. */
const RESTART_EXIT_CODE = 75;
const REPO = path.join(__dirname, "..");

let serverChild = null;
let mainWindow = null;
let tray = null;
/** The first level (INV-1691): which installation the main window shows. */
let installations = null;
let quitting = false;
let crashRestarts = 0;
/** The last lines the server wrote, for the dialog when it will not stay up. */
let recentLog = [];

function log(line) {
  console.log(`[shell] ${line}`);
}

function agentboxHome() {
  return process.env.AGENTBOX_HOME || path.join(os.homedir(), ".agentbox");
}

function configFilePath() {
  return process.env.AGENTBOX_CONFIG || path.join(agentboxHome(), "config.json");
}

function applyStartupItemSettings() {
  if (process.platform !== "darwin" && process.platform !== "win32") return;
  try {
    const result = syncLoginItem(app, configFilePath());
    if (result === "on" || result === "off") log(`startup item turned ${result}`);
  } catch (err) {
    log(`could not apply startup item: ${err.message}`);
  }
}

/**
 * Starts the orchestrator's web server as a child.
 *
 * Run through Electron's own binary in Node mode (ELECTRON_RUN_AS_NODE), so the shell
 * does not depend on a system Node being installed or being the right version. Provider
 * and key come from ~/.agentbox/config.json — the settings dialog writes it, the CLI
 * reads it — so the shell passes no flags of its own.
 */
/**
 * The PATH a Finder-launched app gets is `/usr/bin:/bin:/usr/sbin:/sbin` — no Docker, no
 * Homebrew, no OrbStack — so the server child could not run `docker inspect` and reported
 * the box unavailable while it was up. Found on the first launch by double-click rather
 * than from a terminal; the one launch a new person makes.
 */
function withToolPath(env) {
  const home = os.homedir();
  const extra = [
    "/usr/local/bin",
    "/opt/homebrew/bin",
    path.join(home, ".docker", "bin"),
    path.join(home, ".orbstack", "bin"),
    "/Applications/Docker.app/Contents/Resources/bin",
    "/Applications/OrbStack.app/Contents/MacOS/xbin",
  ];
  const current = (env.PATH || "").split(":").filter(Boolean);
  const merged = [...current];
  for (const dir of extra) if (!merged.includes(dir) && fs.existsSync(dir)) merged.push(dir);
  return { ...env, PATH: merged.join(":") };
}

/**
 * The server's output, on disk. A Finder-launched app has no terminal, so until this existed
 * the server's log went nowhere — and the first real incident ("the box is unavailable", "my
 * message got no reply") had nothing to read. ~/Library/Logs/LumenBox/server.log, rotated at
 * 5 MB to one .1 copy; Console.app finds it, and so does `tail -f`.
 */
const LOG_DIR = path.join(os.homedir(), "Library", "Logs", "LumenBox");
const LOG_FILE = path.join(LOG_DIR, "server.log");
// Each line stamped when it is written: the first real read of this log (2026-09-13)
// had "socket lost" and "heard nothing for 2h" with no way to tell whether that was
// ten minutes or a day ago. A chunk may end mid-line, so the stamp goes on the next
// line start, not on every chunk.
let logAtLineStart = true;
function appendServerLog(text) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    try {
      if (fs.statSync(LOG_FILE).size > 5 * 1024 * 1024) fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
    } catch {}
    const stamp = `${new Date().toISOString()} `;
    let out = "";
    for (const piece of text.split(/(\n)/)) {
      if (piece === "") continue;
      if (piece === "\n") {
        out += piece;
        logAtLineStart = true;
        continue;
      }
      out += (logAtLineStart ? stamp : "") + piece;
      logAtLineStart = false;
    }
    fs.appendFileSync(LOG_FILE, out);
  } catch {}
}

function startServer() {
  const cli = path.join(REPO, "src", "cli.ts");
  serverChild = spawn(
    process.execPath,
    ["--experimental-transform-types", cli, "web", "--port", String(PORT), "--desktop"], // --desktop: this is the desktop app, so a first start makes the Owner (INV-1685)
    {
      cwd: REPO,
      env: withToolPath({ ...process.env, ELECTRON_RUN_AS_NODE: "1", ...(uiAuth.token ? { AGENTBOX_UI_TOKEN: uiAuth.token } : {}) }),
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  const remember = chunk => {
    const text = String(chunk);
    process.stdout.write(text);
    appendServerLog(text);
    recentLog = recentLog.concat(text.split("\n").filter(l => l.trim() !== "")).slice(-30);
  };
  serverChild.stdout.on("data", remember);
  serverChild.stderr.on("data", remember);

  serverChild.on("exit", (code, signal) => {
    serverChild = null;
    if (quitting) return;

    if (code === RESTART_EXIT_CODE) {
      // The settings dialog asked for this. Not a crash; the counter resets.
      log("server asked to be restarted (new config)");
      applyStartupItemSettings();
      updateTrayMenu();
      crashRestarts = 0;
      startServer();
      whenServerReady(() => { mainWindow?.reload(); restartSupervision(); });
      return;
    }

    log(`server exited (code ${code}, signal ${signal})`);
    crashRestarts += 1;
    if (crashRestarts <= 3) {
      setTimeout(() => {
        startServer();
        whenServerReady(() => mainWindow?.reload());
      }, 1000 * crashRestarts);
      return;
    }
    // A server that dies every time it starts will not be fixed by a fourth start.
    dialog.showErrorBox(
      "The LumenBox server will not stay up",
      `It exited ${crashRestarts} times in a row. Last output:\n\n${recentLog.join("\n")}`
    );
  });
}

// ── supervision ───────────────────────────────────────────────────────────────
// The watchdog and the supervisor's run queue, as one child beside the server (INV-1527): outside
// the server, so a server that hangs is seen, but started and stopped with the app so nobody
// installs a service. What a person should hear arrives as `@@notify {json}` lines.

const SUPERVISION_LOG = path.join(LOG_DIR, "supervision.log");
let supervisionChild = null;
let supervisionRestarts = 0;
let supervisionDeliberate = false;

function appendSupervisionLog(line) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    if (fs.existsSync(SUPERVISION_LOG) && fs.statSync(SUPERVISION_LOG).size > 5 * 1024 * 1024) fs.renameSync(SUPERVISION_LOG, `${SUPERVISION_LOG}.1`);
    fs.appendFileSync(SUPERVISION_LOG, `${new Date().toISOString()} ${line}\n`);
  } catch {}
}

function startSupervision() {
  if (quitting || supervisionChild) return;
  // LUMENBOX-FORK: supervision is a sidecar of a server on this Mac, hard-wired to a local
  // door. In remote mode that server is on the VM, so it is not started at all.
  if (REMOTE) { log("supervision: not started (the server is remote)"); return; }
  const cli = path.join(REPO, "src", "cli.ts");
  const startedAt = Date.now();
  supervisionChild = spawn(process.execPath, ["--experimental-transform-types", cli, "supervision", "--url", `http://127.0.0.1:${PORT}`], {
    cwd: REPO,
    env: withToolPath({ ...process.env, ELECTRON_RUN_AS_NODE: "1", ...(uiAuth.token ? { AGENTBOX_UI_TOKEN: uiAuth.token } : {}) }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let pending = "";
  const onData = chunk => {
    pending += String(chunk);
    let end = pending.indexOf("\n");
    while (end >= 0) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      end = pending.indexOf("\n");
      if (line.startsWith("@@notify ")) {
        try {
          const message = JSON.parse(line.slice("@@notify ".length));
          notify(String(message.title ?? "LumenBox"), String(message.body ?? ""));
        } catch {}
        appendSupervisionLog(`notified: ${line.slice("@@notify ".length)}`);
      } else if (line.trim() !== "") {
        appendSupervisionLog(line);
      }
    }
  };
  supervisionChild.stdout.on("data", onData);
  supervisionChild.stderr.on("data", onData);
  updateTrayMenu();
  supervisionChild.on("exit", (code, signal) => {
    supervisionChild = null;
    updateTrayMenu();
    if (quitting) return;
    if (supervisionDeliberate || code === RESTART_EXIT_CODE) {
      // Asked for (new settings, from the shell or the process itself): not a crash.
      supervisionDeliberate = false;
      startSupervision();
      return;
    }
    log(`supervision exited (code ${code}, signal ${signal})`);
    if (Date.now() - startedAt > 10 * 60_000) supervisionRestarts = 0;
    supervisionRestarts += 1;
    if (supervisionRestarts <= 5) {
      setTimeout(startSupervision, 2000 * supervisionRestarts);
      return;
    }
    notify("LumenBox supervision stopped", "It exited five times in a row. See ~/Library/Logs/LumenBox/supervision.log.");
  });
}

/** New settings: the supervision child reads them at start, so it starts again. */
function restartSupervision() {
  if (!supervisionChild) return startSupervision();
  supervisionDeliberate = true;
  supervisionChild.kill();
}

/**
 * System notifications, from the server's own event stream.
 *
 * Exactly three kinds of thing leave the page and reach the OS (INV-1626): an agent that
 * started waiting on the person (a consent, a question, a spend pause — "needs you", with
 * sound), a turn that ended with something new to read while nobody was looking ("done",
 * silent), and the box or server going away. Everything else stays in the activity feed,
 * because a notification channel that carries everything carries nothing.
 */
let eventsRequest = null;
let eventsGeneration = 0;
/** Agents with a turn in flight, from the server's event stream: the memory guard
 *  waits out a live turn before reloading the page under it. */
const busyAgents = new Set();

function windowIsVisible() {
  return mainWindow !== null && mainWindow.isVisible() && mainWindow.isFocused();
}

function notify(title, body, options = {}) {
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title, body: body.slice(0, 240), silent: options.silent === true });
  // Clicking opens the window on what the notice was about: the agent, or the organisation.
  notification.on("click", () => (options.installationId ? showInstallation(options.installationId) : showAgent(options.agentId)));
  notification.show();
}

function showAgent(agentId) {
  createWindow();
  installations?.select("personal");
  if (agentId) mainWindow?.webContents.executeJavaScript(`select(${JSON.stringify(agentId)})`).catch(() => {});
}

/** Opens the window on an organisation (INV-1709): the column marks it as the one shown. */
function showInstallation(id) {
  createWindow();
  installations?.show(id).catch(error => log(`installations: could not show ${id}: ${error.message}`));
}

/**
 * The agents as the server last reported them, with their facts (INV-1625): the dock badge is
 * the unread they carry, and a change between two reports is what a notification is about
 * (INV-1626). Read every ten seconds and right after a turn ends or a consent is asked for, so
 * the badge moves with the window closed. The joined organisations' counts join the same badge,
 * and an organisation that starts owing the person something gets its own notice (INV-1709,
 * dock-signals.cjs).
 */
const signals = dockSignals({
  setBadge: count => { if (process.platform === "darwin") app.setBadgeCount(count); },
  notify,
  focused: () => windowIsVisible(),
  words: shellWordsReader({
    execPath: process.execPath,
    repo: REPO,
    languages: () => app.getPreferredSystemLanguages(),
    choice: () => session.defaultSession.cookies.get({ url: PAGE, name: "lumen-lang" }).then(found => found[0]?.value, () => ""),
  }),
  log,
});

function readAgentFacts() {
  pageClient.get(`${PAGE}api/state`, { headers: uiAuth.headers }, response => {
    let body = "";
    response.on("data", chunk => { body += String(chunk); });
    response.on("end", () => {
      let agents;
      try { agents = JSON.parse(body).agents || []; } catch { return; }
      signals.agentsRead(agents);
    });
  }).on("error", () => {});
}

function watchEvents() {
  eventsRequest?.destroy();
  // One retry per stream, from whichever of end/close/error comes first. Upstream retried
  // on end only, so a server that went away mid-stream (a restart, a dropped connection)
  // left the shell without notifications until it was relaunched. The generation check
  // keeps a stream replaced on purpose (resume) from scheduling a second one.
  const generation = ++eventsGeneration;
  let retried = false;
  const retry = () => {
    if (retried || generation !== eventsGeneration) return;
    retried = true;
    setTimeout(watchEvents, 3000);
  };
  const request = pageClient.get(`${PAGE}api/events`, { headers: uiAuth.headers }, response => {
    let buffer = "";
    response.on("data", chunk => {
      buffer += String(chunk);
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue;
          try {
            handleServerEvent(JSON.parse(line.slice(5)));
          } catch {
            // A torn frame; the next one is whole.
          }
        }
      }
    });
    response.on("end", retry);
    response.on("close", retry);
    response.on("error", retry);
  });
  request.on("error", retry);
  eventsRequest = request;
}

function handleServerEvent(event) {
  if (event.type === "turn_started") {
    busyAgents.add(event.agentId);
  }
  if (event.type === "turn_finished" || event.type === "turn_failed" || event.type === "turn_interrupted") {
    busyAgents.delete(event.agentId);
  }
  // A consent asked for or a turn ended: the facts moved, and the badge and notices follow them.
  if (event.type === "approval_pending" || event.type === "turn_finished" || event.type === "turn_failed") readAgentFacts();
  if (event.type === "error" && /box stopped answering/i.test(String(event.message ?? ""))) {
    notify("The box stopped answering", String(event.message));
  }
}

// ── renderer memory guard ─────────────────────────────────────────────────────
// A window left open for days watched its renderer's physical footprint climb past
// 16 GB — nearly all of it parked in the macOS compressor — while RSS stayed under
// 300 MB, so anything looking at working set saw nothing. The accumulation traced to
// Chromium's own pools over long runs, not to the page, and the honest fix at this
// layer is a recycle: the page holds nothing of record (transcripts, the activity
// feed and settings all live in the server), so a reload is invisible to the work.
// The reload waits out a live turn, and forces through if the wait runs too long.

const MEMGUARD_LIMIT_MB = Number(process.env.LUMENBOX_MEMGUARD_MB || 2048);
/** Past twice the limit, a live turn no longer buys more waiting. */
const MEMGUARD_FORCE_AFTER_MS = 30 * 60_000;
const MEMGUARD_FILE = path.join(LOG_DIR, "memguard.log");
let memguardOverSince = 0;
let memguardReloading = false;

function appendGuardLog(text) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(MEMGUARD_FILE, `${new Date().toISOString()} ${text}\n`);
  } catch {}
}

function parseFootprintMb(text) {
  const match = text.match(/Physical footprint:\s+([\d.]+)\s*(B|K|M|G)\b/);
  if (!match) return null;
  const scale = { B: 1 / 1048576, K: 1 / 1024, M: 1, G: 1024 }[match[2]];
  return Math.round(Number(match[1]) * scale);
}

function checkRendererMemory() {
  const pid = mainWindow?.webContents.getOSProcessId?.();
  if (!pid) {
    memguardOverSince = 0;
    return;
  }
  execFile("/usr/bin/vmmap", ["--summary", String(pid)], { timeout: 30_000 }, (error, stdout) => {
    if (error) return; // the renderer went away mid-read; the next tick retries
    const mb = parseFootprintMb(String(stdout));
    if (mb === null) return;
    appendGuardLog(`check pid=${pid} footprint=${mb}MB limit=${MEMGUARD_LIMIT_MB}MB`);
    if (mb < MEMGUARD_LIMIT_MB) {
      memguardOverSince = 0;
      return;
    }
    if (memguardReloading) return;
    const overForMs = memguardOverSince ? Date.now() - memguardOverSince : 0;
    if (busyAgents.size > 0 && overForMs < MEMGUARD_FORCE_AFTER_MS) {
      if (!memguardOverSince) {
        memguardOverSince = Date.now();
        appendGuardLog(`over limit but a turn is live; deferring the reload`);
      }
      return;
    }
    memguardReloading = true;
    appendGuardLog(`reloading renderer (footprint ${mb}MB, over for ${Math.round(overForMs / 60000)}min)`);
    log(`renderer footprint ${mb}MB over ${MEMGUARD_LIMIT_MB}MB; reloading the page`);
    mainWindow?.reload();
    setTimeout(() => {
      memguardReloading = false;
      memguardOverSince = 0;
    }, 60_000);
  });
}

function startMemoryGuard() {
  // vmmap walks the whole region table, so a check costs seconds — fine at this cadence.
  setTimeout(checkRendererMemory, 2 * 60_000);
  setInterval(checkRendererMemory, 10 * 60_000);
}

/** Polls the page until the server answers, then calls back. */
// A remote server can be away for longer than a local child takes to start (a network
// change, the VM restarting), so remote mode keeps waiting, more slowly.
function whenServerReady(callback, deadline = Date.now() + (REMOTE ? Infinity : 60_000)) {  const request = pageClient.get(PAGE, { headers: uiAuth.headers }, response => {
    response.resume();
    if (response.statusCode && response.statusCode < 500) {
      callback();
      return;
    }
    retry();
  });
  request.on("error", retry);
  function retry() {
    if (Date.now() > deadline) {
      log("server did not come up within a minute");
      return;
    }
    setTimeout(() => whenServerReady(callback, deadline), REMOTE ? 3000 : 500);
  }
}

function createWindow() {
  if (mainWindow) {
    mainWindow.show();
    return;
  }
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 840,
    minWidth: 1120,
    minHeight: 720,
    // The page's own top bar is the title bar; the traffic lights inset into it.
    ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" } : {}),
    // No flash of the wrong theme while the page loads.
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0a0e16" : "#f7f6f2",
    icon: path.join(REPO, "assets", "app-icon", "png", "lumenbox-256.png"),
    // The preload is the page's one way to the shell: its organisation connections (INV-1690).
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, "preload.cjs") },
  });
  mainWindow.setMenuBarVisibility(false);
  // The Manual link and any other off-origin link open in the system browser: not a bare
  // child window, and not in place of the app when a link has no target="_blank".
  const openOutside = url => shell.openExternal(url).catch(err => log(`could not open ${url}: ${err.message}`));
  mainWindow.webContents.setWindowOpenHandler(({ url }) => windowOpenAction(url, new URL(PAGE).origin, openOutside));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (windowOpenAction(url, new URL(PAGE).origin, openOutside).action === "deny") event.preventDefault();
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  loadShellPage();
}

/**
 * What the window shows (INV-1696): the personal page once the personal installation runs; before
 * that, the first-run page that asks what this machine is for; on an organisation node, the node's
 * page — there is no personal server to show.
 */
let shellMode = "personal";
let firstRunHtml = null;
function loadShellPage() {
  if (!mainWindow) return;
  if (shellMode === "personal") { whenServerReady(() => mainWindow?.loadURL(uiAuth.bootstrapUrl(PAGE))); return; }
  firstRunPage().then(html => mainWindow?.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}${shellMode === "node" ? "#node" : ""}`)).catch(err => {
    log(`first-run page: ${err.message}`);
    dialog.showErrorBox("LumenBox could not start", err.message);
  });
}

/** The first-run page, in the system's language, rendered from the bundle by a child (the shell does not load TypeScript). */
function firstRunPage() {
  if (firstRunHtml) return Promise.resolve(firstRunHtml);
  const script = path.join(REPO, "src", "web", "first-run-page.ts");
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ["--experimental-transform-types", script, app.getPreferredSystemLanguages().join(",")], { cwd: REPO, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, maxBuffer: 4 * 1024 * 1024, timeout: 60_000 }, (error, stdout) => {
      if (error) { reject(new Error(`the first-run page did not render: ${error.message}`)); return; }
      firstRunHtml = String(stdout);
      resolve(firstRunHtml);
    });
  });
}

/**
 * Organisation connections (INV-1690, docs/95 §4): a list in the shell's own data directory and a
 * token per connection in the keychain — nothing under ~/.agentbox, nothing started locally.
 */
function startOrganisations(onConnectionsChanged) {
  const store = connectionStore({ file: path.join(app.getPath("userData"), "organisations.json"), keychain: systemKeychain() });
  const openOutside = url => shell.openExternal(url).catch(err => log(`could not open ${url}: ${err.message}`));
  installations = installationViews({ store, mainWindow: () => mainWindow, openOutside, log, onCounts: organisations => signals.organisationsRead(organisations) });
  const windows = organisationWindows({ store, views: installations, personalOrigin: new URL(PAGE).origin, parentWindow: () => mainWindow, openOutside, log, onConnectionsChanged });
  windows.handle(() => mainWindow?.webContents);
  installations.start();
  return { store, windows };
}

/**
 * What this machine is for (INV-1696, docs/96 §3), kept in userData/machine.json — the machine's,
 * not under ~/.agentbox, which an organisation node does not have. Answers the bridge's three
 * calls: `get` for the first-run page and the personal page, `choose` for the first-run page only,
 * `change` for the personal page only.
 */
function startMachineUse() {
  const store = machineUseStore({ file: path.join(app.getPath("userData"), "machine.json") });
  node = organisationNode({
    file: path.join(app.getPath("userData"), "node.json"),
    keychain: systemKeychain(process.platform, NODE_KEYCHAIN_SERVICE),
    signIn: address => signInWindow(address, { parent: mainWindow, openOutside: url => shell.openExternal(url).catch(err => log(`could not open ${url}: ${err.message}`)) }),
    startNode: startNodeProcess,
    log,
  });
  let organisations = null;
  const calls = machineUseCalls({
    store,
    organisations: {
      count: () => organisations.store.list().length,
      ids: () => organisations.store.list().map(c => c.id),
      disconnect: id => organisations.windows.disconnect(id),
    },
    node,
    started: use => startUse(use),
    log,
  });
  organisations = startOrganisations(() => calls.connectionsChanged());
  const personalOrigin = new URL(PAGE).origin;
  const from = event => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return "";
    const url = event.senderFrame?.url ?? event.sender.getURL();
    if (url.startsWith("data:text/html")) return "first-run";
    try { return new URL(url).origin === personalOrigin ? "personal" : ""; } catch { return ""; }
  };
  const reply = (pages, fn) => async (event, ...args) => {
    if (!pages.includes(from(event))) return { error: "refused" };
    try { return await fn(...args); }
    catch (error) {
      if (error instanceof MachineUseRefused || error instanceof NodeRefused || error instanceof JoinRefused) return { error: error.code };
      log(`machine use: ${error.message}`);
      return { error: "failed" };
    }
  };
  ipcMain.handle("machine:get", reply(["first-run", "personal"], () => calls.get()));
  ipcMain.handle("machine:choose", reply(["first-run"], (use, details) => calls.choose(String(use), details && typeof details === "object" ? { address: String(details.address ?? ""), name: String(details.name ?? "") } : {})));
  ipcMain.handle("machine:change", reply(["personal"], to => calls.change(String(to))));
  return startupUse({ store, agentboxHome: agentboxHome(), connections: organisations.store.list().length });
}

/**
 * An organisation node (INV-1697): `agentbox node run` with the node credential in its environment
 * and a state directory of its own (userData/node) — never ~/.agentbox, which a node does not have.
 * The address its boxes listen on comes from AGENTBOX_NODE_ADVERTISE (a network the node and the
 * organisation's server share), loopback otherwise. AGENTBOX_NODE_SCREEN=1 opens this Mac's own screen
 * to the computer tool (`--screen`, INV-1707): set at the machine, never from the organisation.
 * Its output goes to node.log beside server.log.
 */
let node = null;
let nodeChild = null;
function startNodeProcess({ origin, name, credential, onExit }) {
  if (nodeChild) return;
  const home = path.join(app.getPath("userData"), "node");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const args = ["--experimental-transform-types", path.join(REPO, "src", "cli.ts"), "node", "run", "--control", origin, "--name", name, ...(process.env.AGENTBOX_NODE_ADVERTISE ? ["--advertise", process.env.AGENTBOX_NODE_ADVERTISE] : []), ...(process.env.AGENTBOX_NODE_SCREEN === "1" ? ["--screen"] : [])];
  const { AGENTBOX_HOME: _personal, ...inherited } = process.env;
  nodeChild = spawn(process.execPath, args, { cwd: REPO, env: withToolPath({ ...inherited, ELECTRON_RUN_AS_NODE: "1", AGENTBOX_HOME: home, AGENTBOX_NODE_CREDENTIAL: credential }), stdio: ["ignore", "pipe", "pipe"] });
  const NODE_LOG = path.join(LOG_DIR, "node.log");
  const remember = chunk => { try { fs.mkdirSync(LOG_DIR, { recursive: true }); fs.appendFileSync(NODE_LOG, String(chunk)); } catch {} };
  nodeChild.stdout.on("data", remember);
  nodeChild.stderr.on("data", remember);
  nodeChild.on("exit", code => {
    nodeChild = null;
    log(`organisation node: exited (${code})`);
    onExit(code);
    loadShellPage();
    // A node that crashed comes back, as the personal server does; a revoked one (exit 3) does not, and resume() checks the record.
    if (!quitting && code !== NODE_REVOKED_EXIT) setTimeout(() => node.resume().catch(err => log(`organisation node: ${err.message}`)), 5_000);
  });
}

/** Starts what a use runs: the personal installation, or (an organisation node) nothing local but its page. */
function startUse(use) {
  if (runsPersonalInstallation(use)) {
    shellMode = "personal";
    startPersonal();
  } else {
    shellMode = "node";
  }
  loadShellPage();
}

// LUMENBOX-HOSTEXEC-PATCH v2 (fork kyodule/lumenbox): run the server's RunOnHost commands on this
// Mac, after this Mac asks the person in front of it. ~/.agentbox/host-exec.json is this Mac's own
// word: mode off | ask | always, and the command prefixes allowed so far. There is no directory
// setting: a command starts in the person's home directory, as it would in their terminal.
// The server only carries.
const HOST_EXEC_FILE = path.join(process.env.AGENTBOX_HOME || path.join(os.homedir(), ".agentbox"), "host-exec.json");
const HOST_EXEC_RUNNER = path.join(__dirname, "host-exec-runner.ts");
const HOST_EXEC_APPROVAL_MS = 120_000;
// Written by this version, and what tells a pre-v2 file (where "always" meant "the server
// already asked") from this version's own choice of full access.
const HOST_EXEC_SCHEMA = 2;
const hostExecQueue = [];
const hostExecSeen = new Set();
// One entry per command this Mac is handling: queued, deciding, asking, or running. `pid` is the
// process group the runner announced, and `answered` says a cancel already sent its own answer so
// the normal result is not posted twice.
const hostExecActive = new Map();
let hostExecRequest = null;
let hostExecGeneration = 0;
let hostExecBusy = false;
let hostExecError = null;
// The mode the open stream was connected with: what a hand edit to the file is compared against.
let hostExecModeSeen = null;
// One line per command this Mac was asked to run, with what was decided: the Mac's own record.
const HOST_EXEC_LOG = path.join(os.homedir(), "Library", "Logs", "LumenBox", "host-exec.log");

function hostExecAudit(fields) {
  try {
    fs.mkdirSync(path.dirname(HOST_EXEC_LOG), { recursive: true });
    fs.appendFileSync(HOST_EXEC_LOG, `${JSON.stringify({ at: new Date().toISOString(), ...fields })}\n`, { mode: 0o600 });
  } catch (err) {
    log(`host exec: could not write ${HOST_EXEC_LOG}: ${err.message}`);
  }
}

function writeHostExec(raw) {
  fs.mkdirSync(path.dirname(HOST_EXEC_FILE), { recursive: true });
  fs.writeFileSync(HOST_EXEC_FILE, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
}

/** The allow list as this code can use it: a hand-edited file may say anything, and a broken entry is ignored. */
function hostExecAllow(list) {
  if (!Array.isArray(list)) return [];
  const entries = [];
  for (const one of list) {
    if (one === null || typeof one !== "object" || !Array.isArray(one.prefix)) continue;
    const prefix = one.prefix.filter(word => typeof word === "string" && word !== "");
    if (prefix.length === 0) continue;
    entries.push({ prefix, at: typeof one.at === "string" ? one.at : "" });
  }
  return entries;
}

/**
 * `cwd` and `network` are no longer settings: nothing reads them, and a key nobody reads only
 * tells the person there is still something to configure. Dropped on every write.
 */
function withoutRetired(raw) {
  if (raw === null || typeof raw !== "object") return {};
  const { cwd, network, ...kept } = raw;
  return kept;
}

function readHostExec() {
  hostExecError = null;
  if (!fs.existsSync(HOST_EXEC_FILE)) return { mode: "off", allow: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(HOST_EXEC_FILE, "utf8"));
    let mode = raw.mode === "ask" || raw.mode === "always" ? raw.mode : "off";
    // A file written before this version: "always" then meant "the server already asked me", not
    // "run anything". It becomes "ask", in writing, once — the person's next choice is theirs.
    if (raw.schema !== HOST_EXEC_SCHEMA && mode === "always") {
      mode = "ask";
      writeHostExec({ ...withoutRetired(raw), mode, schema: HOST_EXEC_SCHEMA });
      hostExecAudit({ id: null, agent: null, command: null, mode, decision: "migrated", from: "always" });
      log("host exec: mode migrated always → ask, because the server no longer asks");
    }
    return { mode, allow: hostExecAllow(raw.allow) };
  } catch (err) {
    // A broken file is off, and the tray says so: it must never become a door left open.
    hostExecError = `${HOST_EXEC_FILE}: ${err.message}`;
    return { mode: "off", allow: [] };
  }
}

/** Writes one field into the file and keeps everything else, minus the keys this version retired. */
function editHostExec(change) {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(HOST_EXEC_FILE, "utf8"));
  } catch {}
  const next = withoutRetired(change(raw) ?? raw);
  next.schema = HOST_EXEC_SCHEMA;
  writeHostExec(next);
  return next;
}

function setHostExecMode(mode) {
  editHostExec(raw => ({ ...raw, mode }));
  log(`host exec: mode set to ${mode}`);
  watchHostExec();
}

/**
 * Remembers the words of a command the person allowed from now on. The list comes back from the
 * runner, which owns the dedupe and the cap: this process only carries it to the file. Throws when
 * the list could not be made — the caller runs the command anyway and says so in the audit.
 */
async function rememberHostExecPrefix(prefixWords) {
  if (!Array.isArray(prefixWords) || prefixWords.length === 0) throw new Error("no prefix words to remember");
  const config = readHostExec();
  const answer = await runHostExecChild({ phase: "remember", allow: config.allow, prefixWords, at: new Date().toISOString() }, 30_000);
  if (!Array.isArray(answer.allow)) throw new Error(answer.refused ?? "the Mac runner returned no allow list");
  editHostExec(raw => ({ ...raw, allow: hostExecAllow(answer.allow) }));
  log(`host exec: allowed from now on: ${prefixWords.join(" ")}`);
  updateTrayMenu();
}

function forgetHostExecCommands() {
  editHostExec(raw => ({ ...raw, allow: [] }));
  log("host exec: the allowed commands were forgotten");
  updateTrayMenu();
}

function hostExecTrayItems() {
  const config = readHostExec();
  const choose = mode => () => setHostExecMode(mode);
  const where = hostExecError
    ? `Config error, see ${HOST_EXEC_FILE}`
    : `${config.allow.length} allowed ${config.allow.length === 1 ? "command" : "commands"}`;
  return [
    { type: "separator" },
    { label: "Mac execution", enabled: false },
    { label: "Off", type: "radio", checked: config.mode === "off", click: choose("off") },
    { label: "Ask every time", type: "radio", checked: config.mode === "ask", click: choose("ask") },
    { label: "Full access", type: "radio", checked: config.mode === "always", click: choose("always") },
    { label: where, enabled: false },
    { label: "Forget allowed commands", enabled: !hostExecError && config.allow.length > 0, click: forgetHostExecCommands },
  ];
}

/** Holds the command stream open while the mode is not off. Off means not connected: the server then offers no RunOnHost. */
function watchHostExec() {
  hostExecRequest?.destroy();
  hostExecRequest = null;
  const generation = ++hostExecGeneration;
  // Queued commands belong to the stream they came on, and the server gave them up when it closed.
  hostExecQueue.length = 0;
  const config = readHostExec();
  hostExecModeSeen = config.mode;
  updateTrayMenu();
  if (hostExecError) log(`host exec: ${hostExecError}`);
  if (!REMOTE || config.mode === "off") return;
  let retried = false;
  const retry = delay => {
    if (retried || generation !== hostExecGeneration) return;
    retried = true;
    setTimeout(() => {
      if (generation === hostExecGeneration) watchHostExec();
    }, delay);
  };
  const request = pageClient.get(`${PAGE}api/host-exec/stream`, { headers: uiAuth.headers }, response => {
    if (response.statusCode !== 200) {
      log(`host exec: the server answered ${response.statusCode}; trying again in 30 s`);
      response.resume();
      retry(30_000);
      return;
    }
    log("host exec: connected; this Mac takes commands");
    let buffer = "";
    response.on("data", chunk => {
      buffer += String(chunk);
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue;
          let job;
          try {
            job = JSON.parse(line.slice(5));
          } catch {
            continue;
          }
          if (job?.type === "cancel" && typeof job.id === "string") { void cancelHostExec(job.id); continue; }
          if (job?.type !== "run" || typeof job.id !== "string" || typeof job.command !== "string" || hostExecSeen.has(job.id)) continue;
          hostExecSeen.add(job.id);
          hostExecQueue.push({ ...job, generation });
          void pumpHostExec();
        }
      }
    });
    const lost = () => retry(3_000);
    response.on("end", lost);
    response.on("close", lost);
    response.on("error", lost);
  });
  request.on("error", () => retry(3_000));
  hostExecRequest = request;
}

/** One command at a time: two approval sheets on one window cannot both be read. */
async function pumpHostExec() {
  if (hostExecBusy) return;
  hostExecBusy = true;
  try {
    while (hostExecQueue.length > 0) {
      const job = hostExecQueue.shift();
      if (job.generation !== hostExecGeneration) continue;
      let answer;
      try {
        answer = await handleHostExecJob(job);
      } catch (err) {
        answer = { refused: `the Mac failed: ${err.message}` };
      }
      const active = hostExecActive.get(job.id);
      if (active === undefined || active.answered !== true) postHostExecResult({ id: job.id, ...answer });
      hostExecActive.delete(job.id);
    }
  } finally {
    hostExecBusy = false;
  }
}

/**
 * The server asked this Mac to stop a command.
 *
 * A command still queued is dropped before anything runs. A running one is killed as a group —
 * SIGTERM, a second, SIGKILL — because the shell was detached and its children hold the pipes.
 * "可能已执行" is the honest wording once the group existed: what it already wrote is not undone.
 *
 * 取消只置 entry.cancelled 标记，不会关掉已经弹出的审批框：Electron 的 showMessageBox 没有程序化
 * 关闭的 API，那个框要等人回答、或等它自己的 120 秒超时。框被回答后，跑子进程之前的检查会看到
 * 标记并直接中止，所以取消之后即使点「Run once」也不会执行——只是 UI 上那块框会多挂一会儿。
 */
async function cancelHostExec(id) {
  const queued = hostExecQueue.findIndex(job => job.id === id);
  if (queued >= 0) hostExecQueue.splice(queued, 1);
  const entry = hostExecActive.get(id);
  if (entry === undefined) {
    if (queued < 0) return; // already answered, or never seen here
    hostExecAudit({ id, decision: "cancelled", cancelled: "not_started" });
    postHostExecResult({ id, refused: "已取消，未执行" });
    return;
  }
  entry.cancelled = true; // a decision or a dialog in progress stops at its next check
  const pid = entry.pid;
  if (pid === undefined) {
    entry.answered = true;
    hostExecAudit({ id, decision: "cancelled", cancelled: "not_started" });
    postHostExecResult({ id, refused: "已取消，未执行" });
    return;
  }
  const signal = name => {
    try {
      process.kill(-pid, name);
    } catch {
      try {
        process.kill(pid, name);
      } catch {}
    }
  };
  signal("SIGTERM");
  setTimeout(() => signal("SIGKILL"), 1000);
  const until = Date.now() + 2000;
  while (Date.now() < until && groupAlive(pid)) await new Promise(done => setTimeout(done, 50));
  entry.answered = true;
  hostExecAudit({ id, decision: "cancelled", cancelled: "running" });
  postHostExecResult({ id, refused: "已取消，可能已执行" });
}

/** True while any process in the group the runner announced still exists. */
function groupAlive(pid) {
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

async function handleHostExecJob(job) {
  const active = { cancelled: false, answered: false };
  hostExecActive.set(job.id, active);
  const config = readHostExec();
  const audit = fields => hostExecAudit({ id: job.id, agent: job.agent ?? null, command: job.command.slice(0, 2000), mode: config.mode, ...fields });
  if (config.mode === "off") {
    audit({ decision: "off" });
    return { refused: "Mac execution is off on this Mac" };
  }
  if (active.cancelled) return { refused: "已取消，未执行" };
  // The decision is TypeScript shared with the server's tests; this process only carries it.
  // Anything but a decision this version understands is a refusal: fail closed.
  let decision;
  try {
    decision = await runHostExecChild({ phase: "decide", command: job.command, mode: config.mode, allow: config.allow }, 30_000);
  } catch (err) {
    decision = { refused: `the Mac could not decide about this command: ${err.message}` };
  }
  if (decision.kind !== "auto" && decision.kind !== "ask") {
    const because = decision.kind === "refuse" ? decision.because : decision.refused ?? "the Mac could not decide about this command";
    audit({ decision: decision.kind === "refuse" ? "refused" : "undecided", because });
    return { refused: because };
  }

  let answeredMs = null;
  let remembered = null;
  let rememberError = null;
  let decisionName = decision.kind;
  if (decision.kind === "ask") {
    const asked = await askHostExec(job, decision);
    answeredMs = asked.ms;
    if (!asked.approved) {
      audit({ decision: asked.decision, answeredMs });
      return { refused: asked.decision === "timeout" ? "no answer on the Mac within 2 minutes" : "the person declined on the Mac" };
    }
    decisionName = "approved";
    if (asked.remember) {
      try {
        await rememberHostExecPrefix(decision.prefixWords);
        remembered = decision.prefixWords;
      } catch (err) {
        rememberError = err.message;
        log(`host exec: could not remember "${(decision.prefixWords ?? []).join(" ")}": ${err.message}; it will ask again`);
      }
    }
    if (job.generation !== hostExecGeneration) {
      audit({ decision: "stale", answeredMs });
      return { refused: "the connection to the server changed while the Mac was asking" };
    }
  }
  if (active.cancelled) return { refused: "已取消，未执行" };
  log(`host exec: running for ${job.agent ?? "an agent"} (${decisionName}): ${job.command.slice(0, 200)}`);
  const answer = await runHostExecChild({ phase: "run", command: job.command, timeoutMs: job.timeoutMs }, (job.timeoutMs || 300_000) + 30_000, pid => {
    active.pid = pid;
    postHostExecResult({ id: job.id, started: true });
  });
  audit({ decision: decisionName, prefix: remembered, remember: remembered !== null, ...(rememberError !== null ? { rememberError } : {}), answeredMs, code: answer.result?.code ?? null, refused: answer.refused ?? null });
  return answer;
}

/**
 * The dialog on this Mac. Buttons: run once, allow these words from now on (when the decision
 * offers it), decline. On macOS a message box with no parent runs synchronously and ignores the
 * timeout, so the app is not brought forward and a click on Decline is the default and the
 * cancel: running takes a deliberate click.
 */
async function askHostExec(job, decision) {
  createWindow();
  if (!mainWindow) return { approved: false, remember: false, decision: "declined", ms: 0 };
  if (!mainWindow.isVisible()) mainWindow.showInactive();
  const bounce = process.platform === "darwin" ? app.dock?.bounce("critical") : undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HOST_EXEC_APPROVAL_MS);
  const shownAt = Date.now();
  const buttons = decision.remember !== undefined ? [decision.once, decision.remember, "Decline"] : [decision.once, "Decline"];
  const decline = buttons.length - 1;
  const remembered = decision.remember !== undefined ? `\n\n"Always allow" runs later commands that begin with these words without asking.` : "";
  try {
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: "warning",
      buttons,
      defaultId: decline,
      cancelId: decline,
      noLink: true,
      title: "Run a command on this Mac?",
      message: `${job.agent ?? "An agent"} wants to run a command on this Mac`,
      detail: `${job.command}\n\nRuns as you, in your login shell, with no sandbox.${remembered}\nDeclined automatically after 2 minutes.`,
      signal: controller.signal,
    });
    const ms = Date.now() - shownAt;
    if (controller.signal.aborted) return { approved: false, remember: false, decision: "timeout", ms };
    if (response === 0) return { approved: true, remember: false, decision: "approved", ms };
    if (decision.remember !== undefined && response === 1) return { approved: true, remember: true, decision: "approved", ms };
    return { approved: false, remember: false, decision: "declined", ms };
  } finally {
    clearTimeout(timer);
    if (bounce !== undefined) app.dock?.cancelBounce(bounce);
  }
}

/** One child, one phase: the decision or the run. Its answer is JSON on stdout. */
function runHostExecChild(job, budgetMs, onStarted) {
  return new Promise(resolve => {
    const env = withToolPath({ ...process.env, ELECTRON_RUN_AS_NODE: "1" });
    delete env.AGENTBOX_UI_TOKEN;
    const child = spawn(process.execPath, ["--experimental-transform-types", "--no-warnings", HOST_EXEC_RUNNER], {
      cwd: REPO,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    let buffer = "";
    let answer = null;
    child.stdout.on("data", chunk => {
      const text = String(chunk);
      out += text;
      buffer += text;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (line === "") continue;
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (parsed?.started === true && typeof parsed.pid === "number") {
          onStarted?.(parsed.pid);
          continue;
        }
        answer = parsed;
      }
    });
    child.stderr.on("data", chunk => {
      err += String(chunk);
    });
    const killer = setTimeout(() => child.kill("SIGKILL"), budgetMs);
    child.on("error", error => {
      clearTimeout(killer);
      resolve({ refused: `could not start the Mac runner: ${error.message}` });
    });
    child.on("close", () => {
      clearTimeout(killer);
      try {
        resolve(answer ?? JSON.parse(buffer.trim()));
      } catch {
        resolve({ refused: `the Mac runner gave no answer${err.trim() ? `: ${err.trim().slice(0, 500)}` : ""}` });
      }
    });
    child.stdin.end(JSON.stringify(job));
  });
}

/**
 * An edit to host-exec.json by hand takes effect like a tray change: reconnect only when the mode
 * changed. The allow list and the directory are read again for every command, so remembering one
 * must not tear down the stream the command is waiting on — that would make the command it was
 * just approved for arrive as "stale".
 */
function watchHostExecFile() {
  fs.watchFile(HOST_EXEC_FILE, { interval: 2000 }, () => {
    // Compared with what the open stream was connected for, not with the previous read: a tray
    // change already reconnected, and this must not tear the new stream down a second time.
    if (readHostExec().mode === hostExecModeSeen) return;
    log("host exec: the mode changed in host-exec.json; connecting again");
    watchHostExec();
  });
}

function postHostExecResult(body) {
  const payload = JSON.stringify(body);
  const request = pageClient.request(
    `${PAGE}api/host-exec/result`,
    { method: "POST", headers: { ...uiAuth.headers, "content-type": "application/json", "content-length": Buffer.byteLength(payload) } },
    response => {
      response.resume();
      if (response.statusCode !== 200) log(`host exec: the server answered ${response.statusCode} to the result for ${body.id}`);
    }
  );
  request.on("error", error => log(`host exec: could not send the result for ${body.id}: ${error.message}`));
  request.end(payload);
}

function buildTrayMenu() {
  const loginSettings = app.getLoginItemSettings();
  return Menu.buildFromTemplate([
    { label: "Open LumenBox", click: () => createWindow() },
    { label: "Open in browser", enabled: personalStarted, click: () => { void shell.openExternal(uiAuth.bootstrapUrl(PAGE)); } },
    // Launch-at-login is set in Settings and applied here from config.json: one writer for
    // the file (the server), one applier for the OS (this process).
    {
      label: `Launch at login: ${loginSettings.openAtLogin ? "on" : "off"} (change in Settings)`,
      enabled: false,
    },
    { label: `Supervision: ${supervisionChild ? "running" : "not running"}`, enabled: false },
    ...(REMOTE
      ? [{ label: `Connected to ${new URL(PAGE).host}`, enabled: false }, ...hostExecTrayItems()]
      : [{
          label: "Restart server",
          click: () => {
            // Kill and let the exit handler bring it back; the reload rides on ready.
            crashRestarts = -1; // the deliberate kill is not a crash
            serverChild?.kill();
          },
        }]),
    { type: "separator" },
    { label: "Quit — keeps the box running", click: () => app.quit() },
  ]);
}

function updateTrayMenu() {
  if (tray) {
    tray.setContextMenu(buildTrayMenu());
  }
}

function createTray() {
  const image = nativeImage.createFromPath(
    path.join(REPO, "assets", "app-icon", "tray", "trayTemplate.png")
  );
  if (process.platform === "darwin") image.setTemplateImage(true);
  tray = new Tray(image);
  tray.setToolTip("LumenBox");
  tray.setContextMenu(buildTrayMenu());
  tray.on("click", () => createWindow());
}

// One shell, one server: a second launch focuses the first window instead of racing
// for the same port.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    createWindow();
    mainWindow?.focus();
  });

  app.setName("LumenBox");

  app.whenReady().then(() => {
    // The BrowserWindow icon option is Windows/Linux only; on macOS the Dock icon
    // comes from the app bundle — which, unpackaged, is Electron's own. Set it at
    // runtime so the mark from the brand sheet shows in every mode. (The name beside
    // the menus still says Electron until the app is packaged; that is a bundle
    // property no runtime call can change.)
    if (process.platform === "darwin" && app.dock) {
      app.dock.setIcon(
        nativeImage.createFromPath(
          path.join(REPO, "assets", "app-icon", "png", "lumenbox-512.png")
        )
      );
    }
    if (REMOTE_ERROR) {
      dialog.showErrorBox("LumenBox remote mode", REMOTE_ERROR);
      app.quit();
      return;
    }
    createTray();
    const start = startMachineUse();
    if (start.wizard) {
      // A first run: nothing is created until the person says what this machine is for (INV-1696).
      log("first run: asking what this machine is for");
      shellMode = "first-run";
    } else if (runsPersonalInstallation(start.use)) {
      startPersonal();
    } else {
      shellMode = "node";
      node.resume().catch(err => log(`organisation node: ${err.message}`));
    }
    createWindow();
  });

  // The window closing is not the app ending: the tray keeps the agents reachable,
  // which is the point of a shell over a page.
  app.on("window-all-closed", () => {});
  app.on("activate", () => createWindow());
  app.on("before-quit", () => {
    quitting = true;
    serverChild?.kill();
    supervisionChild?.kill();
    nodeChild?.kill();
  });
}

/** The personal installation: its server, its supervision, and what watches them. */
let personalStarted = false;
function startPersonal() {
  if (personalStarted) return;
  personalStarted = true;
  updateTrayMenu();
  applyStartupItemSettings();
  if (REMOTE) log(`remote mode: ${PAGE}`);
  else startServer();
  startMemoryGuard();
  setInterval(readAgentFacts, 10_000); setTimeout(readAgentFacts, 4_000);
  // A laptop that slept comes back with chat sockets that still claim to be connected and
  // a Docker engine that is still waking. Ask the server to sweep the vendors now rather
  // than at the next ten-minute tick — the box watch recovers on its own within a minute.
  powerMonitor.on("resume", () => {
    if (REMOTE) {
      // The server never slept; only this side's sockets may be stale.
      log("system resumed; reconnecting the remote event stream");
      watchEvents();
      watchHostExec();
      return;
    }
    log("system resumed; asking the server to sweep the chat channels");
    setTimeout(() => {
      fetch(`http://127.0.0.1:${PORT}/api/channels/sweep`, { method: "POST", headers: uiAuth.headers }).then(response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
      }).catch(error => {
        log(`sweep after resume failed: ${error.message}`);
      });
    }, 8_000);
  });
  whenServerReady(() => { watchEvents(); startSupervision(); });
  if (REMOTE) whenServerReady(() => { watchHostExec(); watchHostExecFile(); });
}
