/**
 * The ledger of commands that went to the person's Mac and have not come back (LUMENBOX-FORK).
 *
 * Until this existed, the only record of a command in flight was the promise inside
 * `DesktopHostRunner`, and a dropped stream threw it away: the run rejected with "its result is
 * unknown", and a person who wanted to know what happened to `request_id` had nothing to ask.
 *
 * The file is append-only (`host-exec-pending.jsonl`, one JSON object a line), because the Mac can
 * answer a command after the stream it went out on is gone, and a row that is overwritten cannot
 * say when it changed. State is read by folding the rows in order, last field wins:
 *
 *   sent      written before the frame leaves the server
 *   done      the Mac answered; `result` (or `refused`) rides on the row
 *   unknown   the stream dropped and the answer did not arrive inside the grace period
 *
 * A command is never re-sent because of what is in this file. It records; it does not decide.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { agentboxHome } from "../config.ts";
import { appendLine, appendLineDurably, type LedgerKind } from "./jsonl.ts";
import type { DesktopHostRunner } from "./host-runner.ts";

/**
 * What this ledger is: a queue of work in flight. Compaction may drop what is finished (a done row
 * past its day), never what is still unresolved — an unknown row is the only evidence a person has
 * that the command was sent at all.
 */
export const LEDGER_KIND: LedgerKind = "queue";

/** How long a dropped stream waits for the Mac to come back with an answer. */
export const DESKTOP_GRACE_MS = 30_000;
/** Done rows older than this are dropped when the server starts. */
export const KEEP_DONE_MS = 24 * 60 * 60 * 1000;

export type HostExecState = "sent" | "done" | "unknown";

/**
 * What a query can answer. `not_found` is its own word: an id the ledger never saw must never read
 * as "sent and unknown", which says the command may have run.
 */
export type HostExecStatus = HostExecState | "not_found";

/** What a finished command returned, as much of it as the ledger keeps. */
export interface StoredResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
  truncatedBytes: number;
}

export interface StoredStatus {
  state: HostExecStatus;
  result?: StoredResult;
  /** The Mac said it had started the command (a frame of its own, before the result). */
  started: boolean;
  /** Set once a cancel was decided, so asking twice says the same thing. */
  cancelled?: "not_started" | "running";
  /** Why the Mac did not run it, when the answer was a refusal rather than a result. */
  refused?: string;
  at?: string;
}

type Row = { id: string; at: string } & Record<string, unknown>;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export class HostExecStore {
  /** Waiting this long after a disconnect before calling a command unknown. */
  readonly graceMs: number;

  constructor(private readonly file: string = join(agentboxHome(), "host-exec-pending.jsonl"), options: { graceMs?: number } = {}) {
    this.graceMs = options.graceMs ?? DESKTOP_GRACE_MS;
    this.prune();
  }

  /** The frame is about to leave the server. Written before the write, and synced: the record exists first. */
  sent(id: string, agent: string | undefined, command: string): void {
    this.append({ id, at: this.now(), agent: agent ?? null, command, state: "sent", sent_at: this.now() }, true);
  }

  /** The Mac began executing it: from here a cancel may have missed it. */
  started(id: string): void {
    this.append({ id, at: this.now(), started: true });
  }

  /** The Mac answered: a result, or a refusal with the reason. */
  settled(id: string, answer: { result?: StoredResult; refused?: string }): void {
    this.append({ id, at: this.now(), state: "done", ...(answer.result !== undefined ? { result: answer.result } : {}), ...(answer.refused !== undefined ? { refused: answer.refused } : {}) });
  }

  /** The stream dropped and the answer never came. */
  unknown(id: string): void {
    this.append({ id, at: this.now(), state: "unknown" });
  }

  cancelled(id: string, when: "not_started" | "running"): void {
    this.append({ id, at: this.now(), cancelled: when });
  }

  /** One command's state. An id the ledger never saw is `not_found` — never "unknown", never "safe to re-run". */
  status(id: string): StoredStatus {
    const entry = this.rows().get(id);
    if (entry === undefined) return { state: "not_found", started: false };
    return {
      state: (entry.state as HostExecState | undefined) ?? "sent",
      started: entry.started === true,
      ...(isObject(entry.result) ? { result: entry.result as unknown as StoredResult } : {}),
      ...(entry.cancelled === "not_started" || entry.cancelled === "running" ? { cancelled: entry.cancelled } : {}),
      ...(typeof entry.refused === "string" ? { refused: entry.refused } : {}),
      ...(typeof entry.at === "string" ? { at: entry.at } : {}),
    };
  }

  /** Drops done rows older than a day and compacts one row per command. Returns rows removed. */
  prune(now = new Date()): number {
    if (!existsSync(this.file)) return 0;
    try {
      return this.pruneNow(now);
    } catch {
      // A ledger that cannot be read is not a reason to refuse to start: the next write appends to
      // it, and a person's commands matter more than this file's tidiness.
      return 0;
    }
  }

  private pruneNow(now: Date): number {
    const rows = this.rows();
    let removed = 0;
    for (const [id, entry] of rows) {
      // Only done rows expire. `unknown` and `sent` are kept for good: they are the whole record
      // that the command was ever sent, and dropping them at a day old is how the evidence that a
      // command may have run disappears. The file still cannot grow per state change — pruning
      // rewrites one row per command.
      if (entry.state !== "done") continue;
      const at = typeof entry.at === "string" ? Date.parse(entry.at) : Number.NaN;
      if (Number.isFinite(at) && now.getTime() - at > KEEP_DONE_MS) {
        rows.delete(id);
        removed += 1;
      }
    }
    // Compacted even when nothing aged out: the log is read by folding, so one row per id says the
    // same thing and keeps the file from growing with every command the Mac ever ran.
    const body = [...rows.values()].map(entry => JSON.stringify(entry)).join("\n");
    this.write(body === "" ? "" : `${body}\n`);
    return removed;
  }

  private now(): string {
    return new Date().toISOString();
  }

  private append(row: Row, durable = false): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const line = JSON.stringify(row);
    if (durable) appendLineDurably(this.file, line);
    else appendLine(this.file, line);
  }

  private write(body: string): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temporary, body, { mode: 0o600 });
    renameSync(temporary, this.file);
  }

  /** Fold the append log into one entry per command. A broken line is skipped, not fatal. */
  private rows(): Map<string, Record<string, unknown>> {
    const rows = new Map<string, Record<string, unknown>>();
    if (!existsSync(this.file)) return rows;
    for (const line of readFileSync(this.file, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isObject(parsed) || typeof parsed.id !== "string") continue;
      rows.set(parsed.id, { ...(rows.get(parsed.id) ?? {}), ...parsed });
    }
    return rows;
  }
}

/**
 * A stream dropped while commands were out. Mark them unknown, and keep the promise pending for a
 * grace period: the Mac may come back on a new seat and answer one of them, and `settle()` finds
 * the id still in the runner's map. When the grace runs out, the ledger decides — a `done` row
 * written by a late answer resolves the promise, anything else is the unknown it always was.
 */
export function waitAfterDisconnect(
  store: HostExecStore | undefined,
  id: string,
  waiting: { resolve: (result: StoredResult) => void; reject: (error: Error) => void },
  forget: () => void,
  why: string,
): void {
  store?.unknown(id);
  setTimeout(() => {
    forget();
    const status = store?.status(id);
    if (status?.state === "done" && status.result !== undefined) {
      waiting.resolve(status.result);
      return;
    }
    // Never replayed here or anywhere: the command may already have run once on the Mac.
    waiting.reject(new Error(`${why} while the command was out. Its result is unknown: it may or may not have run on the Mac. Check before running it again.`));
  }, store?.graceMs ?? DESKTOP_GRACE_MS).unref?.();
}

/**
 * The ledger's two routes, behind the same guard as the Mac's own routes in `serve()` (admin only:
 * they are a door to the same machine's commands). Status by request_id, and cancel.
 *
 * Here rather than in host-runner.ts because that file's line budget has one line left, and this is
 * the part that will grow.
 */
export async function serveLedger(
  route: string,
  req: IncomingMessage,
  res: ServerResponse,
  send: (res: ServerResponse, status: number, body: unknown) => void,
  refusedRole: (need: "admin") => boolean,
  readJson: (req: IncomingMessage) => Promise<unknown>,
  runner: DesktopHostRunner,
): Promise<boolean> {
  if (route !== "GET /api/host-exec/status" && route !== "POST /api/host-exec/cancel") return false;
  if (refusedRole("admin")) return true;
  if (route === "GET /api/host-exec/status") {
    const id = new URL(req.url ?? "", "http://localhost").searchParams.get("id") ?? "";
    if (id === "") {
      send(res, 400, { error: "id is required" });
      return true;
    }
    send(res, 200, runner.status(id));
    return true;
  }
  const body = (await readJson(req)) as { id?: unknown } | null;
  const id = body !== null && typeof body === "object" && typeof body.id === "string" ? body.id : "";
  if (id === "") {
    send(res, 400, { error: "id is required" });
    return true;
  }
  send(res, 200, runner.cancel(id));
  return true;
}

export type CancelOutcome = "not_started" | "running" | "already_completed" | "unknown" | "not_found";

export interface CancelDecision {
  outcome: CancelOutcome;
  /** What the caller shows the person. The first two share a wording: neither ran. */
  text: string;
}

/**
 * What cancelling one command would mean, decided from the ledger before anything is sent.
 *
 * The distinction that matters is "may have run": once the Mac said it started, killing the group
 * cannot promise the command did nothing. Asking again returns what the first ask decided, so a
 * repeated cancel is not a second, stronger claim.
 */
export function cancelDecision(
  store: HostExecStore | undefined,
  id: string,
  pending: boolean,
  send: (frame: string) => void,
): CancelDecision {
  const status = store?.status(id);
  const text = {
    not_started: "已取消，未执行",
    running: "已取消，可能已执行",
    completed: "已完成，无需取消",
    lost: "结果未知，无法取消；先确认它是否执行过",
    missing: "账本里没有这条命令，无法取消",
  } as const;
  if (status?.cancelled !== undefined) return { outcome: status.cancelled, text: text[status.cancelled] };
  if (status?.state === "done") return { outcome: "already_completed", text: text.completed };
  if (!pending) {
    // Nothing is waiting here. A cancel frame now would be a command the Mac has to guess the
    // meaning of, and it is almost certainly not holding this one any more.
    if (status?.state === "sent" || status?.state === "unknown") return { outcome: "unknown", text: text.lost };
    return { outcome: "not_found", text: text.missing };
  }
  const running = status?.started === true;
  send(`data: ${JSON.stringify({ type: "cancel", id })}\n\n`);
  store?.cancelled(id, running ? "running" : "not_started");
  return running ? { outcome: "running", text: text.running } : { outcome: "not_started", text: text.not_started };
}