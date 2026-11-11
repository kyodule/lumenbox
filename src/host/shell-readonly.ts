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
  "hostname", "arch", "nproc", "lscpu", "lsblk", "mount", "env", "locale", "seq", "yes", "bc",
  "expr", "sleep", "tty", "w", "who", "last", "lsof", "dig", "nslookup", "host",
  // Only this command's own shell changes directory; the next command starts where it did.
  "cd",
]);

/** Readers with a flag or subcommand that writes; each gets its own check. */
function guarded(name: string, args: readonly string[]): string | undefined {
  const has = (flag: RegExp) => args.some(arg => flag.test(arg));
  switch (name) {
    case "find":
      return has(/^-(delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls)$/) ? "find with an action flag" : undefined;
    case "sed":
      return has(/^-[a-zA-Z]*i/) || has(/^--in-place/) ? "sed -i" : has(/(^|;)\s*w\s/) ? "sed w" : undefined;
    case "awk":
    case "gawk":
      return args.some(arg => /system\s*\(|>\s*"|>\s*'|\|\s*"/.test(arg)) ? "awk writing or spawning" : undefined;
    case "git": {
      // `--output` writes a file on any subcommand, including the reading ones.
      if (has(/^--output(=|$)/)) return "git --output";
      // `-c key=value` can point a pager at a program, so it is not skipped like -C.
      if (has(/^-c$/)) return "git -c";
      // `-C <dir>` only says where to run, and may repeat; after the subcommand it is a branch copy.
      const rest: string[] = [];
      let seenSub = false;
      for (let index = 0; index < args.length; index += 1) {
        const arg = args[index]!;
        if (!seenSub && arg === "-C") {
          index += 1;
          continue;
        }
        if (!seenSub && !arg.startsWith("-")) seenSub = true;
        rest.push(arg);
      }
      const plain = rest.filter(arg => !arg.startsWith("-"));
      const sub = plain[0];
      const reading = new Set(["status", "log", "diff", "show", "blame", "ls-files", "ls-tree", "rev-parse", "describe", "shortlog", "cat-file", "grep", "reflog", "count-objects", "config"]);
      if (sub === undefined) return "git with no subcommand";
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
    case "docker":
    case "podman": {
      const sub = args.find(arg => !arg.startsWith("-"));
      return sub !== undefined && /^(ps|images|logs|inspect|version|info|stats|top|port|diff|history)$/.test(sub) ? undefined : `docker ${sub ?? ""}`.trim();
    }
    case "npm":
    case "pnpm":
    case "yarn": {
      const sub = args.find(arg => !arg.startsWith("-"));
      return sub !== undefined && /^(ls|list|view|info|outdated|why|--version|-v|audit)$/.test(sub) && !has(/^--fix$/) ? undefined : `${name} ${sub ?? ""}`.trim();
    }
    case "node":
    case "python":
    case "python3":
      return args.length === 1 && /^(-v|--version|-V)$/.test(args[0]!) ? undefined : `${name} running code`;
    case "kubectl": {
      const sub = args.find(arg => !arg.startsWith("-"));
      return sub !== undefined && /^(get|describe|logs|top|version|explain|api-resources)$/.test(sub) ? undefined : `kubectl ${sub ?? ""}`.trim();
    }
    case "systemctl":
      return args.some(arg => /^(status|list-units|list-unit-files|is-active|is-enabled|show|cat)$/.test(arg)) && !args.some(arg => /^(start|stop|restart|reload|enable|disable|mask|unmask|edit|daemon-reload)$/.test(arg)) ? undefined : "systemctl that changes state";
    case "sort":
      // `sort -o` writes the file it is given, and `--compress-program` runs it.
      return has(/^--compress-program(=|$)/) ? "sort --compress-program" : has(/^-[a-zA-Z]*o|^--output(=|$)/) ? "sort -o" : undefined;
    case "xxd":
      // `xxd in out` writes the second path; with no output path it only prints.
      return args.filter(arg => !arg.startsWith("-")).length >= 2 ? "xxd writing a file" : undefined;
    case "rg":
    case "ag":
      // `--pre` turns its argument into a program to run; `--pre-glob` rides along with it.
      return has(/^--pre/) ? `${name} --pre` : undefined;
    case "command": {
      // `command -v node` asks where it is. `command node` runs it, and so does `command rm x`.
      const first = args[0];
      return (first === "-v" || first === "-V") && args.length === 2 ? undefined : "command running a program";
    }
    case "mount":
      // No argument lists what is mounted; anything else attaches a filesystem, and `-a` attaches all.
      return args.filter(arg => !arg.startsWith("-")).length > 0 || has(/^-[a-zA-Z]*a/) ? "mount attaching a filesystem" : undefined;
    default:
      return undefined;
  }
}

const NEVER = /(^|[\s;&|(])(sudo|doas|su|eval|exec|xargs|source|sh|bash|zsh|dash|ksh|fish|env|nohup|timeout|watch|nice|ionice|builtin|time|script|tee|dd|rm|mv|cp|chmod|chown|chgrp|ln|mkdir|rmdir|touch|truncate|shred|kill|pkill|killall|curl|wget|ssh|scp|rsync|ftp|sftp|nc|ncat|telnet|apt|apt-get|yum|dnf|brew|pip|pip3|gem|cargo|go|make|tar|zip|unzip|gzip|gunzip|crontab|mkfs|fdisk|umount|reboot|shutdown|halt|poweroff|passwd|useradd|userdel|usermod|iptables|nft|ufw)(\s|$)/;

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
    const dup = /^(\d*)>&(\d+)/.exec(rest);
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
  const never = NEVER.exec(unquoted);
  if (never !== null) return { readOnly: false, because: never[2]! };
  const parts = segments(text);
  if (parts === null) return { readOnly: false, because: "unbalanced quotes" };
  for (const part of parts) {
    const argv = words(part);
    if (argv === null) return { readOnly: false, because: "an unreadable segment" };
    // A leading VAR=value is a wrapper; what it wraps may be anything.
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0]!)) return { readOnly: false, because: "an environment prefix" };
    const name = argv[0]!.replace(/^.*\//, "");
    const reason = guarded(name, argv.slice(1));
    if (reason !== undefined) return { readOnly: false, because: reason };
    if (!READERS.has(name) && !["find", "sed", "awk", "gawk", "git", "docker", "podman", "npm", "pnpm", "yarn", "node", "python", "python3", "kubectl", "systemctl", "command"].includes(name)) {
      return { readOnly: false, because: `${name} is not a known reader` };
    }
  }
  return { readOnly: true };
}
