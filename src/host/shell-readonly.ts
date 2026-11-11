/**
 * Whether a shell command only reads.
 *
 * For the approval card, so a person deciding on `git status && ls -la` is told "this only
 * reads" and can say yes without parsing it themselves. Conservative on purpose: the answer is
 * "read-only" only when every segment is a known reader with no way to write — a redirection, a
 * substitution, a wrapper, an unknown binary, or a flag that turns a reader into a writer all
 * make it "not known to be read-only", which is the state every command was in before.
 *
 * OpenClaw does the same job with a wrapper-aware chain splitter and a small safe-bins list
 * (jq, cut, uniq, head, tail, tr, wc); Grok Bot 0.30 with tree-sitter-bash. This is the chain
 * splitter and the list without the parser: a real parser earns its dependency once a case
 * this misclassifies is measured, and none has been.
 */

export type ShellClass = { readOnly: true } | { readOnly: false; because: string };

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

/** The judgement needs a parser per program for these: each has a flag or a subcommand that writes. */
const GUARDED_NAMES = new Set(["find", "sed", "awk", "gawk", "git", "docker", "podman", "npm", "pnpm", "yarn", "node", "python", "python3", "kubectl", "systemctl", "command"]);

/** Readers with a flag or subcommand that writes or runs a program; each gets its own check. */
function guarded(name: string, args: readonly string[]): string | undefined {
  const has = (flag: RegExp) => args.some(arg => flag.test(arg));
  const positional = args.filter(arg => !arg.startsWith("-"));
  switch (name) {
    case "find":
      return has(/^-(delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls)$/) ? "find with an action flag" : undefined;
    case "sed":
      return sedWrites(args);
    case "awk":
    case "gawk":
      return awkWrites(args);
    case "git":
      return gitWrites(args);
    case "docker":
    case "podman": {
      const sub = positional[0];
      return sub !== undefined && /^(ps|images|logs|inspect|version|info|stats|top|port|diff|history)$/.test(sub) ? undefined : `docker ${sub ?? ""}`.trim();
    }
    case "npm":
    case "pnpm":
    case "yarn": {
      const sub = positional[0];
      return sub !== undefined && /^(ls|list|view|info|outdated|why|--version|-v|audit)$/.test(sub) && !has(/^--fix$/) ? undefined : `${name} ${sub ?? ""}`.trim();
    }
    case "node":
    case "python":
    case "python3":
      return args.length === 1 && /^(-v|--version|-V)$/.test(args[0]!) ? undefined : `${name} running code`;
    case "kubectl": {
      const sub = positional[0];
      return sub !== undefined && /^(get|describe|logs|top|version|explain|api-resources)$/.test(sub) ? undefined : `kubectl ${sub ?? ""}`.trim();
    }
    case "systemctl":
      return args.some(arg => /^(status|list-units|list-unit-files|is-active|is-enabled|show|cat)$/.test(arg)) && !args.some(arg => /^(start|stop|restart|reload|enable|disable|mask|unmask|edit|daemon-reload)$/.test(arg)) ? undefined : "systemctl that changes state";
    case "sort":
      // `sort -o` writes the file it is given, and `--compress-program` runs it.
      return has(/^--compress-program(=|$)/) ? "sort --compress-program" : has(/^-[a-zA-Z]*o|^--output(=|$)/) ? "sort -o" : undefined;
    case "xxd":
      // `xxd in out` writes the second path; with no output path it only prints.
      return positional.length >= 2 ? "xxd writing a file" : undefined;
    case "rg":
    case "ag":
      // `--pre` and `--hostname-bin` turn their argument into a program; `--pager` likewise.
      return has(/^--pre/) ? `${name} --pre` : has(/^--hostname-bin/) ? `${name} --hostname-bin` : has(/^--pager/) ? `${name} --pager` : undefined;
    case "tree":
      return has(/^-o|^--output/) ? "tree -o" : undefined;
    case "uniq":
      // `uniq in out` writes out; the options that take a value are not positional arguments.
      return uniqPositional(args) >= 2 ? "uniq writing its second file" : undefined;
    case "file":
      return has(/^-C|^--compile/) ? "file -C compiling a magic file" : undefined;
    case "less":
    case "more":
      return has(/^-[oO]|^--log-file/) ? `${name} writing a log file` : undefined;
    case "date":
      return has(/^-[a-zA-Z]*s|^--set/) ? "date setting the clock" : undefined;
    case "hostname":
      return positional.length > 0 ? "hostname setting the name" : undefined;
    case "diff":
      // `--paginate` runs whatever PAGER names.
      return has(/^--paginate/) ? "diff running a pager" : undefined;
    case "command": {
      // `command -v node` asks where it is. `command node` runs it, and so does `command rm x`.
      const first = args[0];
      return (first === "-v" || first === "-V") && args.length === 2 ? undefined : "command running a program";
    }
    case "mount":
      // No argument lists what is mounted; anything else attaches a filesystem, and `-a` attaches all.
      return positional.length > 0 || has(/^-[a-zA-Z]*a/) ? "mount attaching a filesystem" : undefined;
    default:
      return undefined;
  }
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
 * sed is judged by what its scripts can do, not by a list of bad flags: `s///w`, `1e`, `w` and a
 * script read from a file can all write or run a command, and the space of scripts is too large to
 * deny flag by flag. Only `p`, `d`, `q`, `=` on addresses, and `s///` with printing flags, are reads.
 */
function sedWrites(args: readonly string[]): string | undefined {
  if (args.some(arg => /^-[a-zA-Z]*i|^--in-place/.test(arg))) return "sed -i";
  if (args.some(arg => /^-[a-zA-Z]*f|^--file/.test(arg))) return "sed -f";
  const scripts: string[] = [];
  let sawExpression = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "-e" || arg === "--expression") {
      scripts.push(args[index + 1] ?? "");
      sawExpression = true;
      index += 1;
      continue;
    }
    if (arg.startsWith("--expression=")) {
      scripts.push(arg.slice("--expression=".length));
      sawExpression = true;
      continue;
    }
    if (arg.startsWith("-")) continue;
    // With -e every positional is a file; without it the first one is the script.
    if (!sawExpression) scripts.push(arg);
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
  if (args.some(arg => /^-f|^--file|^-i/.test(arg))) return "awk reading a program from a file";
  const program = args.filter(arg => !arg.startsWith("-")).join("\n");
  if (/system\s*\(/.test(program)) return "awk system()";
  if (/getline/.test(program) && /\|/.test(program)) return "awk piping into getline";
  for (const statement of program.split(/[;\n]/)) {
    if (/\b(print|printf)\b/.test(statement) && /[>|]/.test(statement)) return "awk writing a file or a pipe";
  }
  return undefined;
}

/**
 * git runs programs from its options long before the subcommand: `-c`/`--config-env` set a pager,
 * and `grep -O` sets one too. Before the subcommand only these global options are harmless; any
 * other one asks.
 */
function gitWrites(args: readonly string[]): string | undefined {
  if (args.some(arg => /^--output(=|$)/.test(arg))) return "git --output";
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
  const reading = new Set(["status", "log", "diff", "show", "blame", "ls-files", "ls-tree", "rev-parse", "describe", "shortlog", "cat-file", "grep", "reflog", "count-objects", "config"]);
  if (sub === undefined) return "git with no subcommand";
  if (sub === "grep" && rest.some(arg => /^-O|^--open-files-in-pager/.test(arg))) return "git grep running a program";
  if (rest.some(arg => /^--(ext-diff|textconv)$/.test(arg))) return `git ${sub} running an external diff`;
  if (sub === "branch" || sub === "tag" || sub === "remote" || sub === "stash") {
    return rest.some(arg => /^-(d|D|m|M|c|C|f|u)$|^--(delete|move|copy|force|set-upstream|unset-upstream|edit-description)$/.test(arg)) ||
      (sub === "remote" && plain.length > 1) ||
      (sub === "stash" && plain.length > 1 && !/^(list|show)$/.test(plain[1] ?? ""))
      ? `git ${sub} that changes refs`
      : undefined;
  }
  if (sub === "config") return rest.some(arg => /^--(unset|add|replace-all|edit)$/.test(arg)) || plain.length > 2 ? "git config that writes" : undefined;
  return reading.has(sub) ? undefined : `git ${sub}`;
}

/**
 * Commands that must be asked about wherever they are the command, whatever their arguments.
 *
 * Matched against each segment's first word only. The whole-command scan this replaced also
 * refused `grep -rn source src` and `cat make`, because a dangerous word appeared among the
 * arguments — where it names a pattern or a file, not a command.
 */
const NEVER = new Set(["sudo", "doas", "su", "eval", "exec", "xargs", "source", "sh", "bash", "zsh", "dash", "ksh", "fish", "env", "nohup", "timeout", "watch", "nice", "ionice", "builtin", "time", "script", "tee", "dd", "rm", "mv", "cp", "chmod", "chown", "chgrp", "ln", "mkdir", "rmdir", "touch", "truncate", "shred", "kill", "pkill", "killall", "curl", "wget", "ssh", "scp", "rsync", "ftp", "sftp", "nc", "ncat", "telnet", "apt", "apt-get", "yum", "dnf", "brew", "pip", "pip3", "gem", "cargo", "go", "make", "tar", "zip", "unzip", "gzip", "gunzip", "crontab", "mkfs", "fdisk", "umount", "reboot", "shutdown", "halt", "poweroff", "passwd", "useradd", "userdel", "usermod", "iptables", "nft", "ufw"]);

/** Splits on |, ||, &&, ;, and newlines — outside quotes. Null when the quoting is unbalanced. */
export function segments(command: string): string[] | null {
  const parts: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (quote !== undefined) {
      current += char;
      if (char === "\\" && quote === '"') {
        current += command[index + 1] ?? "";
        index += 1;
      } else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "\\") {
      current += char + (command[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (char === "|" || char === "&" || char === ";" || char === "\n") {
      parts.push(current);
      current = "";
      if ((char === "|" || char === "&") && command[index + 1] === char) index += 1;
      continue;
    }
    current += char;
  }
  if (quote !== undefined) return null;
  parts.push(current);
  return parts.map(part => part.trim()).filter(part => part !== "");
}

/** The words of one segment, quotes stripped, or null when it cannot be read as plain words. */
export function words(segment: string): string[] | null {
  const out: string[] = [];
  const pattern = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  for (const match of segment.matchAll(pattern)) {
    out.push(match[1] !== undefined ? match[1].replace(/\\(.)/g, "$1") : (match[2] ?? match[3]!));
  }
  return out.length === 0 ? null : out;
}

/**
 * The command with the redirections that discard output taken out: `2>/dev/null`, `>/dev/null`,
 * `&>/dev/null`, `2>&1`, `>&2`, `</dev/null`. Only a target that is exactly `/dev/null`, and only
 * outside quotes, so `>/dev/null/../x`, `>/dev/nullx`, `>&file` and `grep "2>/dev/null" f` are
 * left alone. One function because both judgements must see the same text: `2>&1` holds an `&`,
 * and splitting before removing it would turn one command into two.
 */
export function stripDiscardRedirects(command: string): string {
  let out = "";
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (quote !== undefined) {
      out += char;
      if (char === "\\" && quote === '"') {
        out += command[index + 1] ?? "";
        index += 1;
      } else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      out += char;
      continue;
    }
    if (char === "\\") {
      out += char + (command[index + 1] ?? "");
      index += 1;
      continue;
    }
    const rest = command.slice(index);
    // One descriptor pointed at another (2>&1, >&2): a stream, never a file.
    // The boundary matters: `>&1file` writes to a file named 1file, it does not copy a stream.
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
    out += char;
  }
  return out;
}

export function classifyShell(command: string): ShellClass {
  const text = stripDiscardRedirects(command).trim();
  if (text === "") return { readOnly: false, because: "empty command" };
  if (/(^|[^<])>|<\(|>\(/.test(text.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, ""))) {
    return { readOnly: false, because: "a redirection" };
  }
  const unquoted = text.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, "");
  if (/\$\(|`/.test(unquoted)) return { readOnly: false, because: "a command substitution" };
  const parts = segments(text);
  if (parts === null) return { readOnly: false, because: "unbalanced quotes" };
  for (const part of parts) {
    const argv = words(part);
    if (argv === null) return { readOnly: false, because: "an unreadable segment" };
    // A leading VAR=value is a wrapper; what it wraps may be anything.
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0]!)) return { readOnly: false, because: "an environment prefix" };
    const name = argv[0]!.replace(/^.*\//, "");
    // Where it matters is the command position: `grep source src` reads, `source src` runs.
    if (NEVER.has(name)) return { readOnly: false, because: name };
    const reason = guarded(name, argv.slice(1));
    if (reason !== undefined) return { readOnly: false, because: reason };
    if (!READERS.has(name) && !GUARDED_NAMES.has(name)) {
      return { readOnly: false, because: `${name} is not a known reader` };
    }
  }
  return { readOnly: true };
}
