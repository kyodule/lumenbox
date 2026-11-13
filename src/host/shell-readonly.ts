/**
 * Whether a shell command only reads.
 *
 * For the approval card, so a person deciding on `git status && ls -la` is told "this only
 * reads" and can say yes without parsing it themselves. On the Mac this judgement is not a
 * caption: a command it calls read-only runs without asking and without a sandbox, so every
 * place it disagrees with zsh about what will run is a hole.
 *
 * Two things keep it honest, and both were learned the hard way:
 *
 *   - **One scanner decides where quotes are.** `segments`, `stripDiscardRedirects` and `words`
 *     all ask `scanShell` how zsh reads each character, so the answer cannot drift between them.
 *     A word is the shell's word: `-"delete"` is `-delete`, `-de\lete` is `-delete`.
 *   - **What is not modelled is not a read.** A subshell, a zsh glob qualifier, an ANSI-C quote,
 *     a brace expansion: none of them are parsed here, so each makes the command "not known to
 *     be read-only" rather than being guessed at.
 *
 * OpenClaw does the same job with a wrapper-aware chain splitter and a small safe-bins list
 * (jq, cut, uniq, head, tail, tr, wc); Grok Bot 0.30 with tree-sitter-bash. This is the chain
 * splitter and the list without the parser: a real parser earns its dependency once a case
 * this misclassifies is measured, and none has been.
 */

export type ShellClass = { readOnly: true } | { readOnly: false; because: string };

/** One word as zsh would hand it to the program, and whether building it ran an expansion. */
export interface ShellWord {
  text: string;
  /** A `$` or a backtick appeared outside single quotes: the word the program gets is not the word written. */
  expands: boolean;
}

/** Binaries that only read, with no flag that writes. */
const READERS = new Set([
  "ls", "cat", "head", "tail", "less", "more", "wc", "du", "df", "stat", "file", "pwd", "whoami",
  "id", "uname", "date", "echo", "printf", "which", "type", "printenv", "ps", "uptime", "free",
  "tree", "diff", "cmp", "md5sum", "sha1sum", "sha256sum", "shasum", "sort", "uniq", "cut", "tr",
  "jq", "xxd", "hexdump", "strings", "basename", "dirname", "realpath", "readlink", "true",
  "false", "test", "[", "grep", "egrep", "fgrep", "rg", "ag", "column", "nl", "tac", "rev",
  // `yes` writes an endless stream and reads nothing; `bc` is a language interpreter whose only
  // input is arithmetic. Neither is worth an approval-free path, so both ask like any unknown word.
  "hostname", "arch", "nproc", "lscpu", "lsblk", "mount", "env", "locale", "seq",
  "expr", "sleep", "tty", "w", "who", "last", "lsof", "dig", "nslookup", "host",
  // Only this command's own shell changes directory; the next command starts where it did.
  "cd",
]);

// ── reading the command the way zsh does ─────────────────────────────────────────────

/** Where a character sits: outside quotes, or inside one of the quoting forms. */
export type QuoteMode = "plain" | "single" | "ansi" | "double" | "backtick";

/**
 * How zsh reads each character of one command.
 *
 * `delimiter` marks the quote characters themselves (and the `$` of `$'…'`), which are syntax
 * rather than word content. `escapes` marks a backslash that escapes the next character;
 * `escaped` marks the character it escapes, which is literal even when it is a quote or a space.
 */
export interface ShellScan {
  mode: QuoteMode[];
  delimiter: boolean[];
  escapes: boolean[];
  escaped: boolean[];
  /** False when a quote is still open at the end: nothing after it can be read. */
  balanced: boolean;
}

/**
 * One pass over the command, recording how each character is read.
 *
 * Every other function here starts from this, so "where does this quote end" has one answer.
 * The forms with their own rules are modelled as such: `$'…'` ends on an unescaped `'`, `"…"`
 * lets a backslash escape only `$`, `` ` ``, `"` and `\`, and a backtick span lets it escape
 * anything. `$'…'` is refused later as unmodelled syntax — but its boundary still has to be
 * right for that refusal to be about the right text.
 */
export function scanShell(command: string): ShellScan {
  const mode: QuoteMode[] = new Array<string>(command.length).fill("plain") as QuoteMode[];
  const delimiter: boolean[] = new Array<boolean>(command.length).fill(false);
  const escapes: boolean[] = new Array<boolean>(command.length).fill(false);
  const escaped: boolean[] = new Array<boolean>(command.length).fill(false);
  let quote: QuoteMode = "plain";
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (quote === "single") {
      mode[index] = "single";
      if (char === "'") {
        delimiter[index] = true;
        quote = "plain";
      }
      continue;
    }
    if (quote === "ansi") {
      mode[index] = "ansi";
      if (char === "\\") {
        escapes[index] = true;
        if (index + 1 < command.length) {
          mode[index + 1] = "ansi";
          escaped[index + 1] = true;
          index += 1;
        }
        continue;
      }
      if (char === "'") {
        delimiter[index] = true;
        quote = "plain";
      }
      continue;
    }
    if (quote === "double" || quote === "backtick") {
      mode[index] = quote;
      if (char === "\\" && (quote === "backtick" || "$`\"\\".includes(command[index + 1] ?? ""))) {
        escapes[index] = true;
        if (index + 1 < command.length) {
          mode[index + 1] = quote;
          escaped[index + 1] = true;
          index += 1;
        }
        continue;
      }
      if ((quote === "double" && char === '"') || (quote === "backtick" && char === "`")) {
        delimiter[index] = true;
        quote = "plain";
      }
      continue;
    }
    // plain
    if (char === "\\") {
      escapes[index] = true;
      if (index + 1 < command.length) {
        mode[index + 1] = "plain";
        escaped[index + 1] = true;
        index += 1;
      }
      continue;
    }
    if (char === "'") {
      delimiter[index] = true;
      quote = "single";
      continue;
    }
    if (char === '"') {
      delimiter[index] = true;
      quote = "double";
      continue;
    }
    if (char === "`") {
      delimiter[index] = true;
      quote = "backtick";
      continue;
    }
    if (char === "$" && (command[index + 1] === "'" || command[index + 1] === '"')) {
      delimiter[index] = true;
      delimiter[index + 1] = true;
      quote = command[index + 1] === "'" ? "ansi" : "double";
      index += 1;
    }
  }
  return { mode, delimiter, escapes, escaped, balanced: quote === "plain" };
}

/** True when this character is active shell syntax: outside any quote and not escaped. */
function active(scan: ShellScan, index: number): boolean {
  return scan.mode[index] === "plain" && scan.escaped[index] !== true && scan.escapes[index] !== true;
}

/** The command's characters that are active syntax, so a regex can look at what zsh will act on. */
export function activeText(command: string): string {
  const scan = scanShell(command);
  let out = "";
  for (let index = 0; index < command.length; index += 1) if (active(scan, index)) out += command[index]!;
  return out;
}

// ── the words ───────────────────────────────────────────────────────────────────────

/**
 * The words zsh would pass to the program: quotes removed, adjacent pieces joined, backslashes
 * resolved. Null when a quote is left open.
 *
 * `expands` records that a `$` or a backtick occurred outside single quotes, because a word built
 * that way is not the word written — and for the programs that check their own arguments, that is
 * the difference between `find -delete` and `find -${HOME:+delete}`.
 */
export function wordSpans(segment: string): ShellWord[] | null {
  const scan = scanShell(segment);
  if (!scan.balanced) return null;
  const out: ShellWord[] = [];
  let current: ShellWord | undefined;
  const begin = (): ShellWord => {
    current ??= { text: "", expands: false };
    return current;
  };
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index]!;
    if (scan.escapes[index] === true) continue; // the backslash itself is not content
    if (scan.delimiter[index] === true) {
      begin();
      if (char === "`") current!.expands = true;
      continue;
    }
    if (scan.escaped[index] === true) {
      begin().text += char;
      continue;
    }
    if (scan.mode[index] === "plain" && /\s/.test(char)) {
      if (current !== undefined) out.push(current);
      current = undefined;
      continue;
    }
    if ((char === "$" || char === "`") && scan.mode[index] !== "single" && scan.mode[index] !== "ansi") begin().expands = true;
    begin().text += char;
  }
  if (current !== undefined) out.push(current);
  return out.length === 0 ? null : out;
}

/** The words of one segment, or null when it cannot be read as plain words. */
export function words(segment: string): string[] | null {
  const spans = wordSpans(segment);
  return spans === null ? null : spans.map(word => word.text);
}

// ── what the shell does between the words ───────────────────────────────────────────

/** Splits on |, ||, &&, ;, and newlines — outside quotes and not escaped. Null when a quote is open. */
export function segments(command: string): string[] | null {
  const scan = scanShell(command);
  if (!scan.balanced) return null;
  const parts: string[] = [];
  let current = "";
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (active(scan, index) && (char === "|" || char === "&" || char === ";" || char === "\n")) {
      parts.push(current);
      current = "";
      // `|` and `&` may be doubled; skip the second half either way (the first already split).
      if (command[index + 1] === char) index += 1;
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.map(part => part.trim()).filter(part => part !== "");
}

/**
 * The command with the redirections that discard output taken out: `2>/dev/null`, `>/dev/null`,
 * `&>/dev/null`, `2>&1`, `>&2`, `</dev/null`. Only a target that is exactly `/dev/null`, and only
 * outside quotes, so `>/dev/null/../x`, `>/dev/nullx`, `>&file`, `>&1file` and `grep "2>/dev/null"
 * are left alone.
 *
 * One scanner decides where quotes are, so `2>&1`'s `&` cannot become a separator by being
 * removed one place and not the other.
 */
export function stripDiscardRedirects(command: string): string {
  const scan = scanShell(command);
  let out = "";
  for (let index = 0; index < command.length; index += 1) {
    if (active(scan, index)) {
      const rest = command.slice(index);
      // One descriptor pointed at another (2>&1, >&2): a stream, never a file. The boundary
      // matters: `>&1file` writes to a file named 1file.
      const dup = /^(\d*)>&(\d+)(?=$|[\s;&|)])/.exec(rest);
      if (dup !== null) {
        index += dup[0].length - 1;
        continue;
      }
      // A redirection whose target is exactly /dev/null, which keeps nothing.
      const discard = /^(\d*|&)(>>?|<)\s*\/dev\/null(?=$|[\s;&|)])/.exec(rest);
      if (discard !== null) {
        index += discard[0].length - 1;
        continue;
      }
    }
    out += command[index]!;
  }
  return out;
}

/**
 * Shell syntax this file does not model, in words a person can act on, or undefined.
 *
 * Each of these lets zsh run something the words do not show — a subshell, a zsh glob qualifier
 * (`*(e:…:)`, `*(+f)`), `=(…)`, an ANSI-C quote with its own escape rules, a brace expansion that
 * splits one word into several. None is parsed, so a command containing one is "not known to be
 * read-only" rather than guessed at.
 */
export function unmodelledSyntax(command: string): string | undefined {
  const scan = scanShell(command);
  const text = command;
  // `$'…'` first: its escaping differs from every other quote, so a scan of the rest of the line
  // is off by one (the trailing quote of `$'\''` opens a quote that zsh does not see).
  for (let index = 0; index + 1 < text.length; index += 1) {
    if (text[index] === "$" && scan.delimiter[index] === true && (text[index + 1] === "'" || text[index + 1] === '"')) {
      return "an ANSI-C or localised quote";
    }
  }
  if (!scan.balanced) return "unbalanced quotes";
  // A substitution runs inside double quotes and inside backticks too; only single quotes and
  // `$'…'` make it literal.
  const substitutes = (index: number): boolean =>
    scan.escaped[index] !== true && (scan.mode[index] === "plain" || scan.mode[index] === "double" || scan.mode[index] === "backtick");
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    // `$(` runs a command; `$((` is arithmetic, which is refused as unmodelled below.
    if (char === "`" && substitutes(index)) return "a command substitution";
    if (char === "$" && text[index + 1] === "(" && text[index + 2] !== "(" && substitutes(index)) return "a command substitution";
    // zsh's parameter expansion has too many forms to model (flags, subscripts, `:-`, `$[`, …),
    // and `(e)` re-expands its value, which is how `"${(e):-\$(touch pwn)}"` runs. Only `$NAME`
    // and `${NAME}` are read; anything else is not known to be read-only.
    if (char === "$" && substitutes(index)) {
      const rest = text.slice(index + 1);
      if (/^[A-Za-z_]/.test(rest)) {
        // $NAME — the word is the value of a variable.
      } else if (rest.startsWith("{")) {
        const close = text.indexOf("}", index + 2);
        const name = close === -1 ? "" : text.slice(index + 2, close);
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return "an expansion that is not modelled";
      } else {
        return "an expansion that is not modelled";
      }
    }
    if (!active(scan, index)) continue;
    if (char === "(" || char === ")") return "a subshell or a pattern qualifier";
    if (char === "$" && (text[index + 1] === "'" || text[index + 1] === '"')) return "an ANSI-C or localised quote";
    if (char === "{") {
      const close = text.indexOf("}", index + 1);
      if (close > index && /[,]|\.\./.test(text.slice(index + 1, close))) return "a brace expansion";
    }
  }
  return undefined;
}

// ── per program: arguments that write or run something ──────────────────────────────

type Guard = (args: readonly string[]) => string | undefined;

const has = (args: readonly string[], flag: RegExp) => args.some(arg => flag.test(arg));
const positional = (args: readonly string[]) => args.filter(arg => !arg.startsWith("-"));

/**
 * A long option, including the abbreviation getopt_long accepts: `--o`, `--outp`, `--output=pwn`
 * are all `--output`. An abbreviation of anything at least three characters long is taken as a
 * hit even where it is ambiguous — asking costs a click, missing one costs the file.
 */
function longOption(args: readonly string[], name: string, ignoreCase = false): boolean {
  const target = ignoreCase ? name.toLowerCase() : name;
  return args.some(arg => {
    const head = arg.split("=")[0]!;
    if (!head.startsWith("--") || head.length < 3) return false;
    const text = ignoreCase ? head.toLowerCase() : head;
    return target.startsWith(text);
  });
}

/** A short option, wherever it sits in a cluster: `-bC`, `-Nopwn`, `-o`, `-opwn`. */
function shortOption(args: readonly string[], letter: string): boolean {
  return args.some(arg => arg.length >= 2 && arg[0] === "-" && arg[1] !== "-" && arg.slice(1).includes(letter));
}

/** `uniq`'s positional arguments, ignoring the options that take a value. */
function uniqPositional(args: readonly string[]): number {
  let count = 0;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (/^(-f|-s|-w|--skip-fields|--skip-chars|--check-chars)$/.test(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    count += 1;
  }
  return count;
}

/**
 * sed is judged by what its scripts can do, and by the options it accepts: `-e` can be glued to a
 * script (`-es/a/b/w /tmp/x`), so an option whitelist is the only safe way to know where a
 * script starts.
 */
function sedWrites(args: readonly string[]): string | undefined {
  if (has(args, /^-[a-zA-Z]*i|^--in-place/)) return "sed -i";
  if (has(args, /^-[a-zA-Z]*f|^--file/)) return "sed -f";
  const scripts: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg.startsWith("--expression=")) {
      scripts.push(arg.slice("--expression=".length));
      continue;
    }
    if (arg === "--expression" || arg === "-e") {
      scripts.push(args[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (arg === "--quiet" || arg === "--silent" || arg === "--regexp-extended") continue;
    if (/^-([nEr]*)$/.test(arg)) continue;
    if (/^-([nEr]*)e$/.test(arg)) {
      // `-ne <script>`: the letters run together and the script is the next argument.
      scripts.push(args[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (/^-([nEr]*)e./.test(arg)) {
      // `-es/a/b/w /tmp/x`: the script is glued to the `e`.
      scripts.push(arg.replace(/^-([nEr]*)e/, ""));
      continue;
    }
    if (arg.startsWith("-")) return "a sed option that is not modelled";
    // Without an option the first positional is the script; with one, positionals are files.
    if (scripts.length === 0) scripts.push(arg);
    break;
  }
  if (scripts.length === 0) return "sed with no script";
  for (const script of scripts) {
    for (const piece of script.split(";")) {
      const text = piece.trim();
      if (text === "") continue;
      const prints = /^(\d+|\$|\/[^/]*\/)?(,(\d+|\$|\/[^/]*\/))?[pdq=]$/.test(text);
      const substitutes = /^s\/([^/\\]|\\.)*\/([^/\\]|\\.)*\/[gpIi0-9]*$/.test(text);
      if (!prints && !substitutes) return "sed script that may write or run";
    }
  }
  return undefined;
}

/** awk: a program read from a file is invisible, and `system(`, `| getline` and `print >` reach out of it. */
function awkWrites(args: readonly string[]): string | undefined {
  if (shortOption(args, "f") || shortOption(args, "i") || longOption(args, "--file")) return "awk reading a program from a file";
  const program = args.filter(arg => !arg.startsWith("-")).join("\n");
  if (/system\s*\(/.test(program)) return "awk system()";
  if (/getline/.test(program) && /\|/.test(program)) return "awk piping into getline";
  // Statements, not lines: `{` and `}` end one too, so a comparison inside a rule is not read as
  // the redirection of the `print` beside it.
  for (const statement of program.split(/[;{}\n]/)) {
    if (/\b(print|printf)\b/.test(statement) && /[>|]/.test(statement)) return "awk writing a file or a pipe";
  }
  return undefined;
}

/**
 * `git config` is a whitelist: reading means one key on its own (`git config user.name`), the
 * `--get*`/`--list` actions with a key, or the new `get`/`list` subcommands. `--file`/`--blob` read
 * somewhere else and are not worth an approval-free path; everything else asks.
 */
function gitConfigWrites(args: readonly string[]): string | undefined {
  const mutating = /^--(unset|unset-all|add|replace-all|edit|rename-section|remove-section|file|blob)(=|$)/;
  if (args.some(arg => mutating.test(arg)) || shortOption(args, "f")) return "git config that writes";
  const flags = args.filter(arg => arg.startsWith("-"));
  const plain = args.filter(arg => !arg.startsWith("-"));
  const reads = /^(--get|--get-all|--get-regexp|--list|-l)(=|$)/;
  const scopes = /^(--global|--local|--system|--worktree|--show-origin|--show-scope|--null|-z|--name-only|--includes|--no-includes)(=|$)/;
  if (!flags.every(arg => scopes.test(arg) || reads.test(arg))) return "a git config option that is not modelled";
  const readAction = flags.some(arg => reads.test(arg));
  if (plain[0] === "get") return plain.length >= 2 ? undefined : "git config get needs a key";
  if (plain[0] === "list") return plain.length === 1 ? undefined : "git config list takes no key";
  if (readAction) return undefined;
  return plain.length === 1 ? undefined : "git config without a single key";
}

/**
 * git runs programs from its options long before the subcommand: `-c`/`--config-env` set a pager,
 * `grep -O` sets one too. Before the subcommand only these global options are harmless.
 */
function gitWrites(args: readonly string[]): string | undefined {
  if (longOption(args, "--output")) return "git --output";
  if (args.some(arg => arg === "-c")) return "git -c";
  const rest: string[] = [];
  let seenSub = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (seenSub) {
      rest.push(arg);
      continue;
    }
    if (arg === "-C") {
      index += 1;
      continue;
    }
    if (arg === "--no-pager" || arg === "-P" || arg === "--no-optional-locks") continue;
    if (/^--(git-dir|work-tree)=/.test(arg)) continue;
    if (!arg.startsWith("-")) {
      seenSub = true;
      rest.push(arg);
      continue;
    }
    return `git global option ${arg.split("=")[0]}`;
  }
  const plain = rest.filter(arg => !arg.startsWith("-"));
  const sub = plain[0];
  const extra = plain.slice(1);
  const reading = new Set(["status", "log", "diff", "show", "blame", "ls-files", "ls-tree", "rev-parse", "describe", "shortlog", "cat-file", "grep", "reflog", "count-objects", "config"]);
  if (sub === undefined) return "git with no subcommand";
  if (sub === "grep" && (shortOption(rest, "O") || longOption(rest, "--open-files-in-pager"))) return "git grep running a program";
  if (longOption(rest, "--ext-diff") || longOption(rest, "--textconv")) return `git ${sub} running an external diff`;
  // `reflog` deletes once it is given an action other than show.
  if (sub === "reflog" && extra[0] !== undefined && extra[0] !== "show") return "git reflog rewriting history";
  // A flag that deletes, moves or rewrites comes first, so `git branch -D old` says what it does.
  if ((sub === "branch" || sub === "tag" || sub === "remote" || sub === "stash") &&
      rest.some(arg => /^-(d|D|m|M|c|C|f|u)$|^--(delete|move|copy|force|set-upstream|unset-upstream|edit-description)$/.test(arg))) {
    return `git ${sub} that changes refs`;
  }
  // A bare name makes a branch or a tag; a pattern with -l/--list/… only lists.
  if ((sub === "branch" || sub === "tag") && extra.length > 0 &&
      !rest.some(arg => /^(-l|--list|--contains|--no-contains|--merged|--no-merged|--points-at)$/.test(arg))) {
    return `git ${sub} creating a ref`;
  }
  // Bare `git stash` is `stash push`: only list and show read.
  if (sub === "stash") return extra[0] !== undefined && /^(list|show)$/.test(extra[0]) ? undefined : "git stash changing the stack";
  if (sub === "remote" && extra[0] !== undefined) return "git remote changing a remote";
  if (sub === "branch" || sub === "tag" || sub === "remote" || sub === "stash") return undefined;
  if (sub === "config") return gitConfigWrites(rest.slice(1));
  return reading.has(sub) ? undefined : `git ${sub}`;
}

const dockerReads = (args: readonly string[]): string | undefined => {
  const sub = positional(args)[0];
  return sub !== undefined && /^(ps|images|logs|inspect|version|info|stats|top|port|diff|history)$/.test(sub) ? undefined : `docker ${sub ?? ""}`.trim();
};

/**
 * How long `sleep` may sleep and still count as a read.
 *
 * A short pause between two reads is harmless. A long one is not a read at all: `sleep 300` holds
 * the Mac for five minutes doing nothing, and asking the person to approve that is the point.
 */
const SLEEP_READ_SECONDS = 5;

/** Seconds a `sleep` argument asks for, or undefined for a form this does not model. */
function sleepSeconds(word: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)([smhd]?)$/.exec(word);
  if (match === null) return undefined;
  const per = match[2] === "m" ? 60 : match[2] === "h" ? 3_600 : match[2] === "d" ? 86_400 : 1;
  const value = Number(match[1]) * per;
  return Number.isFinite(value) ? value : undefined;
}

const npmReads = (args: readonly string[]): string | undefined => {
  const plain = positional(args);
  if (has(args, /^--fix$/)) return "npm --fix";
  const sub = plain[0];
  if (sub === "audit" && plain[1] === "fix") return "npm audit fix";
  return sub !== undefined && /^(ls|list|view|info|outdated|why|--version|-v|audit)$/.test(sub) ? undefined : `npm ${sub ?? ""}`.trim();
};

const runtimeVersion = (name: string) => (args: readonly string[]): string | undefined =>
  args.length === 1 && /^(-v|--version|-V)$/.test(args[0]!) ? undefined : `${name} running code`;

const kubectlReads = (args: readonly string[]): string | undefined => {
  const sub = positional(args)[0];
  return sub !== undefined && /^(get|describe|logs|top|version|explain|api-resources)$/.test(sub) ? undefined : `kubectl ${sub ?? ""}`.trim();
};

/**
 * The programs whose arguments can write a file or start another program, and the check for each.
 * This record is the one list: membership drives both the check below and the "an expansion in
 * its arguments" rule, so a new program cannot be guarded without also refusing expansions in it.
 */
const GUARDS: Record<string, Guard> = {
  find: args => (has(args, /^-(delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls)$/) ? "find with an action flag" : undefined),
  sed: sedWrites,
  awk: awkWrites,
  gawk: awkWrites,
  git: gitWrites,
  docker: dockerReads,
  podman: dockerReads,
  npm: npmReads,
  pnpm: npmReads,
  yarn: npmReads,
  node: runtimeVersion("node"),
  python: runtimeVersion("python"),
  python3: runtimeVersion("python3"),
  kubectl: kubectlReads,
  systemctl: args =>
    args.some(arg => /^(status|list-units|list-unit-files|is-active|is-enabled|show|cat)$/.test(arg)) &&
    !args.some(arg => /^(start|stop|restart|reload|enable|disable|mask|unmask|edit|daemon-reload)$/.test(arg))
      ? undefined
      : "systemctl that changes state",
  sort: args =>
    longOption(args, "--compress-program") ? "sort --compress-program" : shortOption(args, "o") || longOption(args, "--output") ? "sort -o" : undefined,
  // `xxd in out` writes the second path; with no output path it only prints.
  xxd: args => (positional(args).length >= 2 ? "xxd writing a file" : undefined),
  // `--pre` and `--hostname-bin` turn their argument into a program; `--pager` likewise.
  rg: args => (longOption(args, "--pre") || longOption(args, "--pre-glob") ? "rg --pre" : longOption(args, "--hostname-bin") ? "rg --hostname-bin" : longOption(args, "--pager") ? "rg --pager" : undefined),
  ag: args => (longOption(args, "--pre") || longOption(args, "--pre-glob") ? "ag --pre" : longOption(args, "--hostname-bin") ? "ag --hostname-bin" : longOption(args, "--pager") ? "ag --pager" : undefined),
  tree: args => (shortOption(args, "o") || longOption(args, "--output") ? "tree -o" : undefined),
  // `uniq in out` writes out; the options that take a value are not positional arguments.
  uniq: args => (uniqPositional(args) >= 2 ? "uniq writing its second file" : undefined),
  file: args => (shortOption(args, "C") || longOption(args, "--compile") ? "file -C compiling a magic file" : undefined),
  less: args => (shortOption(args, "o") || shortOption(args, "O") || longOption(args, "--log-file", true) ? "less writing a log file" : undefined),
  more: args => (shortOption(args, "o") || shortOption(args, "O") || longOption(args, "--log-file", true) ? "more writing a log file" : undefined),
  date: args => (shortOption(args, "s") || longOption(args, "--set") ? "date setting the clock" : undefined),
  hostname: args => (positional(args).length > 0 ? "hostname setting the name" : undefined),
  // A sleep is a read only while it is short. Anything this cannot read for certain — a flag, a
  // form `sleep` would refuse — is treated as long, which errs towards asking.
  sleep: args => {
    const seconds = args.map(sleepSeconds);
    if (seconds.length === 0 || seconds.some(value => value === undefined)) return "a sleep duration this does not model";
    const total = (seconds as number[]).reduce((sum, value) => sum + value, 0);
    return total > SLEEP_READ_SECONDS ? `sleep for ${total} seconds` : undefined;
  },
  // `--paginate` runs whatever PAGER names.
  diff: args => (longOption(args, "--paginate") ? "diff running a pager" : undefined),
  // `command -v node` asks where it is. `command node` runs it, and so does `command rm x`.
  command: args => (args[0] === "-v" || args[0] === "-V" ? (args.length === 2 ? undefined : "command running a program") : "command running a program"),
  // No argument lists what is mounted; anything else attaches a filesystem, and `-a` attaches all.
  mount: args => (positional(args).length > 0 || shortOption(args, "a") ? "mount attaching a filesystem" : undefined),
};

/** Every program with its own check; exported so a test can hold the list still. */
export const GUARDED_NAMES: ReadonlySet<string> = new Set(Object.keys(GUARDS));

function guarded(name: string, args: readonly string[]): string | undefined {
  return GUARDS[name]?.(args);
}

/**
 * Commands that must be asked about wherever they are the command, whatever their arguments.
 *
 * Matched against each segment's first word only. A whole-command scan also refused
 * `grep -rn source src` and `cat make`, because a dangerous word appeared among the arguments —
 * where it names a pattern or a file, not a command.
 */
const NEVER = new Set(["sudo", "doas", "su", "eval", "exec", "xargs", "source", "sh", "bash", "zsh", "dash", "ksh", "fish", "env", "nohup", "timeout", "watch", "nice", "ionice", "builtin", "time", "script", "tee", "dd", "rm", "mv", "cp", "chmod", "chown", "chgrp", "ln", "mkdir", "rmdir", "touch", "truncate", "shred", "kill", "pkill", "killall", "curl", "wget", "ssh", "scp", "rsync", "ftp", "sftp", "nc", "ncat", "telnet", "apt", "apt-get", "yum", "dnf", "brew", "pip", "pip3", "gem", "cargo", "go", "make", "tar", "zip", "unzip", "gzip", "gunzip", "crontab", "mkfs", "fdisk", "umount", "reboot", "shutdown", "halt", "poweroff", "passwd", "useradd", "userdel", "usermod", "iptables", "nft", "ufw"]);

// ── the judgement ───────────────────────────────────────────────────────────────────

export function classifyShell(command: string): ShellClass {
  const text = stripDiscardRedirects(command).trim();
  if (text === "") return { readOnly: false, because: "empty command" };
  const unmodelled = unmodelledSyntax(text);
  if (unmodelled !== undefined) return { readOnly: false, because: unmodelled };
  const scan = scanShell(text);
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (!active(scan, index)) continue;
    if (char === ">" || char === "<") return { readOnly: false, because: "a redirection" };
  }
  const parts = segments(text);
  if (parts === null) return { readOnly: false, because: "unbalanced quotes" };
  for (const part of parts) {
    const argv = wordSpans(part);
    if (argv === null) return { readOnly: false, because: "an unreadable segment" };
    // A leading VAR=value is a wrapper; what it wraps may be anything.
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0]!.text)) return { readOnly: false, because: "an environment prefix" };
    const name = argv[0]!.text.replace(/^.*\//, "");
    // Where it matters is the command position: `grep source src` reads, `source src` runs.
    if (NEVER.has(name)) return { readOnly: false, because: name };
    // A program that checks its own arguments cannot be checked when an argument is built at run
    // time: `find . -${HOME:+delete}` writes `-delete` and reads as something else here.
    if (GUARDED_NAMES.has(name) && argv.slice(1).some(word => word.expands)) {
      return { readOnly: false, because: `an expansion in ${name}'s arguments` };
    }
    const reason = guarded(name, argv.slice(1).map(word => word.text));
    if (reason !== undefined) return { readOnly: false, because: reason };
    if (!READERS.has(name) && !GUARDED_NAMES.has(name)) {
      return { readOnly: false, because: `${name} is not a known reader` };
    }
  }
  return { readOnly: true };
}