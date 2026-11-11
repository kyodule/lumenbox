/**
 * The Mac's own answer to "may this command run here?" (LUMENBOX-FORK).
 *
 * Codex and Claude Code put this decision on the machine the command runs on: the person in front
 * of it reads the command, runs it once, allows it from then on by its first words, or refuses.
 * That is the whole design here, and it lives beside the shell's splitter rather than inside
 * Electron so it can be tested without spawning anything: `electron/main.cjs` asks a short-lived
 * child for a decision (`phase: "decide"`) and then shows the dialog the answer describes.
 *
 * Two rules hold it together:
 *
 *   - **A command is judged by its worst part.** `npm test && rm -rf build` is not `npm test` with
 *     something after it: the line is split, each part is classified, and any part that is neither
 *     read-only nor already allowed means the whole line asks. An allowed prefix therefore cannot
 *     carry a second command it did not name.
 *   - **A prefix is offered only when the words are the command.** A substitution, a redirection or
 *     a `VAR=value` prefix puts in the line something its words do not show, so those get "run
 *     once" and no "always allow": remembering `echo` from `echo $(whoami)` would hand `echo` away
 *     for a later, different substitution. The same goes for a prefix that is itself still
 *     read-only (`find .` from `find . -delete`): the danger is in the flags it does not cover, so
 *     remembering the words would let any other flag after them through.
 *
 * Nothing here is a sandbox. The person's protection is the dialog and the prefixes they chose,
 * which is the trade the design takes: commands run as them, where they could type them.
 */

import { classifyShell, segments, words } from "./shell-readonly.ts";

/** The Mac's own switch, as `~/.agentbox/host-exec.json` spells it. */
export type MacApprovalMode = "off" | "ask" | "always";

/** A command the person allowed from then on: its first words, and when they said so. */
export interface MacAllowEntry {
  prefix: readonly string[];
  at: string;
}

export type MacApprovalDecision =
  /** Run it without asking. `because` is for the audit log: why nothing was asked. */
  | { kind: "auto"; because: string }
  /**
   * Show the dialog. `once` is the label of the button that runs it this time; `remember`, when
   * present, is the label of the button that allows these words from then on, and `prefix` is the
   * text that gets stored when it is pressed.
   */
  | { kind: "ask"; once: string; remember?: string; prefix: string }
  | { kind: "refuse"; because: string };

/** The dialog's buttons, in the person's language. */
const ONCE = "执行一次";
const REMEMBER = "一直允许";

/** True when the command only reads, by the same judgement the server's approval card uses. */
export function readOnly(command: string): boolean {
  return classifyShell(command).readOnly;
}

/**
 * The command's parts, or null when it cannot be read as a list of plain commands.
 *
 * The splitting is upstream's `segments()`, not a second parser: the read-only judgement splits
 * the same way, so a part this approval judges is a part that judgement saw, and only one place
 * has to be right about quoting. `segments()` cannot see the three things below, which is why
 * they are refused a prefix rather than split again.
 */
export function shellParts(command: string): string[] | null {
  // `$(...)` and backticks run a command named nowhere in the words. They stay active inside
  // double quotes (and `classifyShell` is fooled by exactly that: `cat "$(rm x)"` reads as a
  // `cat`), so this check runs before quotes are stripped — single quotes only, where they are
  // literal.
  if (/\$\(|`/.test(command.replace(/'[^']*'/g, ""))) return null;
  // A redirection writes somewhere that is not a word of the command, and `$( )`-free or not,
  // no prefix covers it. Outside quotes only: `grep "a>b"` writes nothing.
  if (/[<>]/.test(command.replace(/'(?:[^']*)'|"(?:[^"\\]|\\.)*"/g, ""))) return null;
  const parts = segments(command);
  if (parts === null) return null; // unbalanced quotes: no way to tell where a part ends
  // `FOO=bar command`: what the assignment prefixes may be anything at all.
  if (parts.some(part => /^[A-Za-z_][A-Za-z0-9_]*=/.test(part))) return null;
  return parts;
}

/** The words a decision is remembered by: the command's first one, and its second when it has one. */
export function commandPrefix(command: string): { words: string[]; text: string } {
  const parsed = words(command.trim()) ?? [];
  const head = parsed.slice(0, 2);
  return { words: head, text: head.join(" ") };
}

/** The entry that covers these words, if the person allowed one. A prefix covers longer commands with the same first words. */
function allowed(entry: readonly MacAllowEntry[], prefix: readonly string[]): MacAllowEntry | undefined {
  if (prefix.length === 0) return undefined;
  return entry.find(one => one.prefix.length > 0 && one.prefix.length <= prefix.length && one.prefix.every((word, index) => word === prefix[index]));
}

/**
 * What to do with one command, in the order that decides it:
 *
 *   1. mode "always" — the person said everything runs; ask nothing.
 *   2. a line that cannot be read as plain commands — ask, and only "run once".
 *   3. every part only reads — run it.
 *   4. every part is read-only or allowed from before — run it.
 *   5. otherwise — ask, offering to remember the first part that was not covered, unless those
 *      words are themselves read-only (see above).
 *
 * The one invariant: one unsafe part makes the whole line ask. An allowed prefix is never a pass
 * for a part it does not itself match.
 */
export function decideApproval(
  command: string,
  options: { mode: MacApprovalMode; allow?: readonly MacAllowEntry[] }
): MacApprovalDecision {
  // Off is not "ask": this Mac is not taking commands at all. The answer exists for the moment
  // between a tray change and the server noticing the stream closed.
  if (options.mode === "off") return { kind: "refuse", because: "Mac execution is off on this Mac" };
  if (options.mode === "always") return { kind: "auto", because: "Mac execution is set to full access" };
  const allow = options.allow ?? [];
  const whole = commandPrefix(command);
  const parts = shellParts(command);
  if (parts === null || parts.length === 0) return { kind: "ask", once: ONCE, prefix: whole.text };
  const judged = parts.map(part => ({ reads: readOnly(part), prefix: commandPrefix(part) }));
  if (judged.every(one => one.reads)) return { kind: "auto", because: "every part of it only reads" };
  const writes = judged.filter(one => !one.reads);
  const uncovered = writes.filter(one => allowed(allow, one.prefix.words) === undefined);
  if (uncovered.length === 0) {
    return { kind: "auto", because: `every part of it was allowed before (${writes.map(one => one.prefix.text).join(", ")})` };
  }
  const first = uncovered[0]!;
  // Nothing to remember when the words do not name a command (`> out`, an odd segment).
  if (first.prefix.text === "") return { kind: "ask", once: ONCE, prefix: whole.text };
  // A prefix that still reads as read-only means the danger is in the words it does NOT cover
  // (`find . -delete`: `find .` alone only reads). Remembering it would open the door for any
  // other flag after the same words, so those get one run and no standing grant.
  if (readOnly(first.prefix.text)) return { kind: "ask", once: ONCE, prefix: first.prefix.text };
  return { kind: "ask", once: ONCE, remember: `${REMEMBER} ${first.prefix.text}`, prefix: first.prefix.text };
}