/**
 * Running a command on the machine the orchestrator is on, not inside the box.
 *
 * The box is a wall on purpose: an agent with a shell cannot touch the USB port the
 * Arduino is on, the AppleScript that drives the desktop apps, or a `pi`/`claude`/`codex`
 * CLI installed on the host. That wall is most of the safety story, so the door through
 * it is built to be the narrowest, loudest one possible:
 *
 *   - **Off by default.** No config, no tool. The tool is not offered — not offered and
 *     refused, *absent* — so an agent on a box with this disabled never learns it could
 *     have asked. This is what makes "escape the sandbox" an operator's decision, taken
 *     once, in writing, rather than an emergent capability.
 *   - **Every command asks.** Host execution is in the approval-required set by
 *     construction, so each command pauses for a person who reads the exact text before
 *     it runs. The three approval scopes apply — a repeated safe command can be granted
 *     for the session or always — but the default is once, and the person chooses.
 *   - **A working directory, not the whole disk.** Commands run under a configured root
 *     (the person's choice; there is no default, because inventing one is choosing what
 *     an agent may reach on someone's behalf).
 *   - **Under the OS sandbox (INV-1344).** Writes only under that root, the temp directory
 *     and what the operator listed; network only through the egress relay; `~/.ssh` and its
 *     kin never writable. `hostExec.sandbox: "off"` is the operator's written opt-out; where
 *     the sandbox cannot be applied the command is refused with the reason, never run bare.
 *
 * An approved command still runs with the orchestrator's own privileges where the sandbox
 * allows — reading the disk, driving the desktop. The sandbox is the accident boundary the
 * approval cannot be: a person reads `npm test`, not what every script under it writes.
 *
 * The generality is deliberate: this one tool is how `pi`, `claude`, `codex`, a shell
 * script, `osascript`, or `arduino-cli` all become reachable, without a line of code
 * per integration. The agent runs `pi "refactor the repo"` the way it runs `ls`.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { callEnvironment } from "../egress/call.ts";
import type { HostEgress } from "./host-egress.ts";
import { type HostSandbox, type SandboxMechanism, sandboxViolations } from "./host-sandbox.ts";

export interface HostRunnerConfig {
  /** Whether the host door exists at all. Default false. */
  enabled: boolean;
  /**
   * The directory host commands run under. No default: a default here would be this
   * code choosing what an agent may reach on the operator's machine.
   */
  cwd?: string;
  /** Ceiling on one command, floored and capped so neither a typo nor a hang runs away. */
  timeoutMs: number;
  /** Bytes of combined output kept; the rest is dropped with a note, like the box shell. */
  maxOutputBytes: number;
  /** The OS sandbox around each command. "on" unless the operator wrote "off". */
  sandbox: "on" | "off";
  /** Directories writable besides `cwd` and the temp directory. */
  allowWrite: string[];
}

export interface HostRunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  /** True when the timeout, not the command, ended it. */
  timedOut: boolean;
  /** How much output was dropped for the cap, if any. */
  truncatedBytes: number;
  /** How the command was confined, when it was, and the violations block when the sandbox may have stopped it. */
  sandbox?: { mechanism: SandboxMechanism; note?: string };
}

/** What a host process needs besides its command: the sandbox, and the egress proxy its connections go through. */
export interface HostProcessDeps {
  sandbox?: HostSandbox;
  /** Resolved once the proxy listens; undefined when no relay is configured, and then there is no network. */
  egress?: Promise<HostEgress | undefined>;
}

export function hostRunnerConfig(raw: {
  enabled?: boolean;
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  sandbox?: "on" | "off";
  allowWrite?: string[];
}): HostRunnerConfig {
  return {
    enabled: raw.enabled === true,
    ...(typeof raw.cwd === "string" && raw.cwd.trim() !== "" ? { cwd: raw.cwd.trim() } : {}),
    // Floored at 1s and capped at 30 minutes: a host command may be a long build, but a
    // number outside these is a mistake, not an intention.
    timeoutMs: Math.min(Math.max(Number(raw.timeoutMs) || 300_000, 1_000), 1_800_000),
    maxOutputBytes: Math.min(Math.max(Number(raw.maxOutputBytes) || 200_000, 1_000), 5_000_000),
    sandbox: raw.sandbox === "off" ? "off" : "on",
    allowWrite: (raw.allowWrite ?? []).filter(path => typeof path === "string" && path.trim() !== "").map(path => path.trim()),
  };
}

export class HostRunner {
  constructor(
    private readonly config: HostRunnerConfig,
    private readonly deps: HostProcessDeps = {}
  ) {}

  get enabled(): boolean {
    return this.config.enabled;
  }

  /** True when this runner cannot take vault secrets (the Mac runner, LUMENBOX-HOSTEXEC-PATCH). */
  get refusesSecrets(): boolean {
    return false;
  }

  /**
   * Why a run cannot happen, if it cannot — so the tool can refuse with a reason a
   * person can act on rather than a bare failure.
   */
  unavailableReason(): string | undefined {
    if (!this.config.enabled) {
      return "Host execution is turned off. An operator enables it in Settings.";
    }
    if (this.config.cwd === undefined) {
      return "Host execution has no working directory set; an operator must choose one first.";
    }
    if (!existsSync(this.config.cwd)) {
      return `The host working directory ${this.config.cwd} does not exist.`;
    }
    if (this.config.sandbox === "on") {
      if (this.deps.sandbox === undefined) return "Host execution is sandboxed by default and no sandbox was wired in; an operator sets hostExec.sandbox to \"off\" to run host commands bare.";
      const reason = this.deps.sandbox.unavailableReason();
      if (reason !== undefined) return `Host commands run under the OS sandbox, which is unavailable here: ${reason}. An operator may set hostExec.sandbox to "off" in writing.`;
    }
    return undefined;
  }

  /**
   * Runs one command through the shell, on the host, under the configured root.
   *
   * `secretEnv` is merged over the process environment for this one command only —
   * this is how a vaulted credential reaches a `git push` without ever being written
   * anywhere. It lives in the child's environment for the life of the command and
   * nowhere else; nothing is persisted, and it never enters the box.
   *
   * `call` is the INV-784 token for the tool call this is: the egress proxy credential, so
   * the relay's record names the call and its refusals come back on the result (INV-1345).
   */
  async run(command: string, secretEnv: Record<string, string> = {}, call?: string, _agent?: string): Promise<HostRunResult> {
    const reason = this.unavailableReason();
    if (reason !== undefined) throw new Error(reason);
    const cwd = this.config.cwd!;

    const egress = this.config.sandbox === "on" ? await this.deps.egress : undefined;
    const release = call !== undefined && egress !== undefined ? egress.calls.begin(call) : () => {};
    const egressEnv = egress === undefined ? {} : call !== undefined ? callEnvironment(call, egress.port) : proxyEnvironment(egress.port);
    // Through the login shell so an agent's `pi`/`claude`/`osascript` resolves the
    // same way it does in the person's own terminal — PATH, aliases, rc files. The
    // command is a single argument to the shell, never interpolated into a string,
    // which is why this uses execFile and not exec.
    const wrapped =
      this.config.sandbox === "on"
        ? this.deps.sandbox!.wrap("/bin/sh", ["-lc", command], { cwd, allowWrite: this.config.allowWrite, loopbackPorts: egress === undefined ? [] : [egress.port] })
        : undefined;
    const env = { ...process.env, ...egressEnv, ...(wrapped?.env ?? {}), ...secretEnv };

    return new Promise(resolve => {
      const child = execFile(
        wrapped?.command ?? "/bin/sh",
        wrapped?.args ?? ["-lc", command],
        {
          cwd,
          timeout: this.config.timeoutMs,
          maxBuffer: this.config.maxOutputBytes + 1_000_000,
          killSignal: "SIGKILL",
          env,
        },
        (error, stdout, stderr) => {
          release();
          const cap = (text: string): [string, number] => {
            if (text.length <= this.config.maxOutputBytes) return [text, 0];
            return [text.slice(0, this.config.maxOutputBytes), text.length - this.config.maxOutputBytes];
          };
          const [outText, outDropped] = cap(String(stdout));
          const [errText, errDropped] = cap(String(stderr));
          const timedOut =
            error !== null && (error as NodeJS.ErrnoException & { killed?: boolean }).killed === true;
          const result: HostRunResult = {
            stdout: outText,
            stderr: errText,
            code: child.exitCode,
            timedOut,
            truncatedBytes: outDropped + errDropped,
          };
          if (wrapped !== undefined) {
            const note = sandboxViolations(wrapped, { code: child.exitCode, stderr: String(stderr) });
            result.sandbox = { mechanism: wrapped.mechanism, ...(note !== undefined ? { note } : {}) };
          }
          resolve(result);
        }
      );
    });
  }
}

// LUMENBOX-HOSTEXEC-PATCH v2: RunOnHost on the person's Mac, through the LumenBox app there
// (ops/lumenbox/patch_hostd_host_exec.py in personal-bot). The app holds a stream open; each
// approved command goes out on it and comes back on POST /api/host-exec/result. The Mac decides
// whether to run it: its own switch, directory, network and sandbox; this side only carries.

interface PendingDesktopRun {
  resolve: (result: HostRunResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  seat: number;
}

/** What the Mac may hold a command for: its approval dialog, then the command itself. */
export const DESKTOP_APPROVAL_MS = 120_000;
const DESKTOP_SLACK_MS = 30_000;
const DESKTOP_MAX_TEXT = 5_000_000;

/** RunOnHost's description in desktop mode: the default one says commands run where LumenBox runs, the server here. */
export const DESKTOP_RUN_ON_HOST =
  "Run a command on the person's Mac, through the LumenBox app on it. You run on a server; " +
  "this tool is the only way to reach that Mac, and it exists only while the app is open there " +
  "with Mac execution switched on. If a call says the Mac is not connected, tell the person; do " +
  "not retry in a loop. Commands run through the person's login shell under a working directory " +
  "they chose on the Mac. Writes are allowed only there and in the temp directory, never into " +
  "~/.ssh, shell startup files or .git/hooks; network follows the person's setting. Every call " +
  "stops for the person to approve the exact command, here and possibly again on the Mac, so write " +
  "the command you mean and say in your message why you need it. Returns stdout, stderr and the " +
  "exit code, the same as `bash`. `secrets` is not supported here: credentials stay on the server.";

/** The answer when RunOnHost names vault secrets in desktop mode, given before any is resolved. */
export const DESKTOP_SECRETS_REFUSAL =
  "Secrets are not sent to the person's Mac. Run the command without `secrets`; git on the Mac uses the Mac's own ssh keys or keychain.";

export class DesktopHostRunner extends HostRunner {
  private seat: { id: number; write: (frame: string) => void } | undefined;
  private seats = 0;
  private readonly pending = new Map<string, PendingDesktopRun>();
  private readonly note: (line: string) => void;
  private readonly approvalMs: number;
  private readonly commandMs: number;

  constructor(options: { log?: (line: string) => void; approvalMs?: number; commandMs?: number } = {}) {
    super(hostRunnerConfig({ enabled: true }));
    this.note = options.log ?? (() => {});
    this.approvalMs = options.approvalMs ?? DESKTOP_APPROVAL_MS;
    this.commandMs = options.commandMs ?? hostRunnerConfig({}).timeoutMs;
  }

  /** Offered to an agent only while the Mac is connected; a closed app means no tool, not a refusal. */
  override get enabled(): boolean {
    return this.seat !== undefined;
  }

  /** Vault values stay on the server; a command that needs one is refused before it is resolved. */
  override get refusesSecrets(): boolean {
    return true;
  }

  override unavailableReason(): string | undefined {
    return this.seat === undefined
      ? "The person's Mac is not connected: the LumenBox app there is closed, or Mac execution is off in its tray menu."
      : undefined;
  }

  /** The Mac's stream opened. One Mac at a time: a newer connection replaces the older one. */
  attach(write: (frame: string) => void): number {
    if (this.seat !== undefined) this.dropSeat("A newer connection from the Mac replaced this one");
    const id = ++this.seats;
    this.seat = { id, write };
    this.note(`host exec: the Mac connected (seat ${id})`);
    return id;
  }

  /** The Mac's stream closed. A stale close from a replaced stream changes nothing. */
  detach(id: number): void {
    if (this.seat?.id !== id) return;
    this.dropSeat("The Mac disconnected");
    this.note(`host exec: the Mac disconnected (seat ${id})`);
  }

  private dropSeat(why: string): void {
    const old = this.seat?.id;
    this.seat = undefined;
    for (const [id, waiting] of this.pending) {
      if (waiting.seat !== old) continue;
      this.pending.delete(id);
      clearTimeout(waiting.timer);
      // Never replayed: the command may already have run once on the Mac.
      waiting.reject(new Error(`${why} while the command was out. Its result is unknown: it may or may not have run on the Mac. Check before running it again.`));
    }
  }

  override async run(command: string, secretEnv: Record<string, string> = {}, _call?: string, agent?: string): Promise<HostRunResult> {
    if (Object.keys(secretEnv).length > 0) throw new Error("Secrets are not sent to the person's Mac.");
    const seat = this.seat;
    if (seat === undefined) throw new Error(this.unavailableReason());
    const id = randomUUID();
    const timeoutMs = this.commandMs;
    return new Promise<HostRunResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`No answer from the Mac within ${Math.round((this.approvalMs + timeoutMs + DESKTOP_SLACK_MS) / 1000)} seconds. Its result is unknown.`));
      }, this.approvalMs + timeoutMs + DESKTOP_SLACK_MS);
      this.pending.set(id, { resolve, reject, timer, seat: seat.id });
      try {
        seat.write(`data: ${JSON.stringify({ type: "run", id, agent: agent ?? null, command, timeoutMs })}\n\n`);
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new Error(`Could not send the command to the Mac: ${error instanceof Error ? error.message : String(error)}. It did not run.`));
      }
    });
  }

  /** The Mac's answer for one command. False when no command with that id is waiting. */
  settle(body: unknown): boolean {
    const answer = (body ?? {}) as { id?: unknown; result?: unknown; refused?: unknown };
    if (typeof answer.id !== "string") return false;
    const waiting = this.pending.get(answer.id);
    if (waiting === undefined) return false;
    this.pending.delete(answer.id);
    clearTimeout(waiting.timer);
    if (typeof answer.refused === "string") {
      waiting.reject(new Error(`Not run on the Mac: ${answer.refused}`));
      return true;
    }
    const raw = answer.result as Partial<HostRunResult> | undefined;
    if (raw === undefined || raw === null || typeof raw !== "object") {
      waiting.reject(new Error("The Mac sent an answer this server cannot read; the result is unknown."));
      return true;
    }
    const text = (value: unknown) => (typeof value === "string" ? value.slice(0, DESKTOP_MAX_TEXT) : "");
    waiting.resolve({
      stdout: text(raw.stdout),
      stderr: text(raw.stderr),
      code: typeof raw.code === "number" ? raw.code : null,
      timedOut: raw.timedOut === true,
      truncatedBytes: typeof raw.truncatedBytes === "number" ? raw.truncatedBytes : 0,
      ...(raw.sandbox !== undefined && typeof raw.sandbox === "object" && raw.sandbox !== null
        ? { sandbox: { mechanism: "sandbox-exec" as const, ...(typeof raw.sandbox.note === "string" ? { note: raw.sandbox.note } : {}) } }
        : {}),
    });
    return true;
  }
}

/** The proxy variables without a call credential: a connection the relay records as unattributed. */
export function proxyEnvironment(port: number): Record<string, string> {
  const proxy = `http://127.0.0.1:${port}`;
  return { HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy, NO_PROXY: "localhost,127.0.0.1,::1", no_proxy: "localhost,127.0.0.1,::1" };
}
