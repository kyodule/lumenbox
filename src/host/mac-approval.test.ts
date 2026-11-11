/**
 * Tests for the Mac's own approval decision (LUMENBOX-FORK).
 *
 * The claim worth testing is not "read-only commands run" — it is that an allowed prefix is never
 * a pass for a part it does not cover. Every case below about `&&` exists because Claude Code
 * shipped that bug more than once (issues #4956, #16180, #28784, #36637): a person allowed
 * `npm test` and a later line carried `rm -rf build` under it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  commandPrefix,
  decideApproval,
  type MacAllowEntry,
  readOnly,
  rememberPrefix,
  shellParts,
} from "./mac-approval.ts";

const allow = (...prefixes: string[]): MacAllowEntry[] =>
  prefixes.map(prefix => ({ prefix: prefix.split(" "), at: "2026-11-11T00:00:00.000Z" }));

const ask = { mode: "ask" as const };

test("read-only commands run without a dialog: ls -la, git status, cat x", () => {
  for (const command of ["ls -la", "git status", "cat x", "rg TODO src", "pwd", "git log --oneline -5"]) {
    const decision = decideApproval(command, { ...ask, allow: [] });
    assert.equal(decision.kind, "auto", `${command} should run unasked`);
  }
});

test("a chain of read-only parts runs without a dialog: ls && cat x", () => {
  const decision = decideApproval("ls && cat x", { ...ask, allow: [] });
  assert.equal(decision.kind, "auto");
});

test("npm test && rm -rf build always asks: the second part decides it", () => {
  const fresh = decideApproval("npm test && rm -rf build", { ...ask, allow: [] });
  assert.equal(fresh.kind, "ask");
  assert.equal(fresh.kind === "ask" ? fresh.prefix : "", "npm test", "the first part it does not cover is the one offered");

  // Acceptance 3, as tightened by E4: with `npm test` remembered the dialog is about the part it
  // does NOT cover (`rm -rf`), and "always allow" is no longer offered for it — `rm` is one of the
  // prefixes a standing grant would turn into "delete anything, anywhere".
  const carried = decideApproval("npm test && rm -rf build", { ...ask, allow: allow("npm test") });
  assert.equal(carried.kind, "ask", "the allowed prefix must not carry the second command");
  assert.equal(carried.kind === "ask" ? carried.prefix : "", "rm -rf");
  assert.equal(carried.kind === "ask" ? carried.remember : "x", undefined, "rm is never rememberable");
  assert.deepEqual(carried.kind === "ask" ? carried.prefixWords : [], ["rm", "-rf"]);
});

test("an allowed prefix does not carry the next part: npm test && npm run lint still asks", () => {
  const decision = decideApproval("npm test && npm run lint", { ...ask, allow: allow("npm test") });
  assert.equal(decision.kind, "ask", "npm run lint was never allowed");
  assert.equal(decision.kind === "ask" ? decision.prefix : "", "npm run");
});

test("a line whose words are not the command offers only one run", () => {
  for (const command of ["echo $(whoami)", "ls > /tmp/x", "FOO=1 ls", "cat < /tmp/x", "echo `whoami`"]) {
    const decision = decideApproval(command, { ...ask, allow: [] });
    assert.equal(decision.kind, "ask", `${command} should ask`);
    assert.equal(decision.kind === "ask" ? decision.remember : "x", undefined, `${command} must not offer "always allow"`);
  }
  // Unbalanced quoting cannot be split at all.
  assert.equal(shellParts('echo "unclosed'), null);
  assert.equal(decideApproval("echo 'unclosed", { ...ask, allow: [] }).kind, "ask");
});

test("an allowed single command runs unasked", () => {
  assert.equal(decideApproval("npm test", { ...ask, allow: allow("npm test") }).kind, "auto");
  assert.equal(decideApproval("npm test -- --watch=false", { ...ask, allow: allow("npm test") }).kind, "auto");
  assert.equal(decideApproval("npm tests", { ...ask, allow: allow("npm test") }).kind, "ask", "a longer word is a different command");
});

test("full access runs everything, and off refuses everything", () => {
  for (const command of ["npm test && rm -rf build", "echo $(whoami)", "ls"]) {
    assert.equal(decideApproval(command, { mode: "always", allow: [] }).kind, "auto");
  }
  const off = decideApproval("ls", { mode: "off", allow: [] });
  assert.equal(off.kind, "refuse");
  assert.match(off.kind === "refuse" ? off.because : "", /off/);
});

test("reading ~/.ssh is read-only, because the design takes that risk rather than inventing a directory list", () => {
  assert.equal(readOnly("cat ~/.ssh/id_rsa"), true);
  assert.equal(decideApproval("cat ~/.ssh/id_rsa", { ...ask, allow: [] }).kind, "auto");
  // `$HOME` is a plain word to the shell, not a substitution: it names a path, so it reads too.
  assert.equal(readOnly("cat $HOME/.zshrc"), true);
  assert.equal(decideApproval("cat $HOME/.zshrc", { ...ask, allow: [] }).kind, "auto");
});

test("the remembered prefix is the first two words, and is what the dialog offers", () => {
  assert.deepEqual(commandPrefix("npm test -- --watch"), { words: ["npm", "test"], text: "npm test" });
  assert.deepEqual(commandPrefix("ls"), { words: ["ls"], text: "ls" });
  const decision = decideApproval("git commit -m x", { ...ask, allow: [] });
  assert.equal(decision.kind, "ask");
  assert.equal(decision.kind === "ask" ? decision.remember : "", "Always allow git commit");
});

test("the parts are upstream's split, so the read-only judgement and this one see the same segments", () => {
  assert.deepEqual(shellParts("npm test && npm run lint"), ["npm test", "npm run lint"]);
  assert.deepEqual(shellParts("a | b ; c"), ["a", "b", "c"]);
  assert.deepEqual(shellParts("echo 'a && b'"), ["echo 'a && b'"], "a quoted operator is not a split");
});

test("every part is either read-only or allowed: ls && npm test runs once npm test is allowed", () => {
  assert.equal(decideApproval("ls && npm test", { ...ask, allow: allow("npm test") }).kind, "auto");
  assert.equal(decideApproval("ls && npm test", { ...ask, allow: [] }).kind, "ask");
});
test("a prefix that still reads as read-only gets one run and no standing grant: find . -delete", () => {
  for (const command of ["find . -delete", "find . -name '*.log' -delete"]) {
    const decision = decideApproval(command, { ...ask, allow: [] });
    assert.equal(decision.kind, "ask", command);
    assert.equal(decision.kind === "ask" ? decision.remember : "x", undefined,
      `${command}: "find ." alone only reads, so remembering it would hand over every flag after it`);
  }
});

test("a prefix whose own words already write can be remembered: sed -i, sort -o, git push, npm test", () => {
  const cases: [string, string][] = [
    ["sed -i s/a/b/ f", "sed -i"],
    ["sort -o out in", "sort -o"],
    ["git push origin main", "git push"],
    ["npm test", "npm test"],
    ["rg --pre ./evil x", "rg --pre"],
  ];
  for (const [command, prefix] of cases) {
    const decision = decideApproval(command, { ...ask, allow: [] });
    assert.equal(decision.kind, "ask", command);
    assert.equal(decision.kind === "ask" ? decision.prefix : "", prefix, command);
    assert.equal(decision.kind === "ask" ? decision.remember : "", `Always allow ${prefix}`, command);
  }
});

test("a write hidden in a flag of a reading subcommand is one run, not a prefix: git diff --output", () => {
  const decision = decideApproval("git diff --output=/tmp/out.txt", { ...ask, allow: [] });
  assert.equal(decision.kind, "ask");
  assert.equal(decision.kind === "ask" ? decision.remember : "x", undefined, `"git diff" alone reads; the write is in the flag`);
});

test("always allow is stored as words and covers the next command: mkdir -p then mkdir -p elsewhere", () => {
  const first = decideApproval("mkdir -p /tmp/a", { ...ask, allow: [] });
  assert.equal(first.kind, "ask");
  assert.deepEqual(first.kind === "ask" ? first.prefixWords : [], ["mkdir", "-p"]);
  const allow = rememberPrefix([], first.kind === "ask" ? first.prefixWords : [], "2026-11-11T00:00:00.000Z");
  assert.equal(allow.length, 1);
  assert.deepEqual(allow[0]!.prefix, ["mkdir", "-p"]);
  const second = decideApproval("mkdir -p /tmp/b", { ...ask, allow });
  assert.equal(second.kind, "auto", "the dialog's promise has to hold for the next command");
});

test("remembering the same prefix twice does not duplicate it, and the 51st pushes the first out", () => {
  const once = rememberPrefix([], ["npm", "test"], "t1");
  const twice = rememberPrefix(once, ["npm", "test"], "t2");
  assert.equal(twice.length, 1, "one entry, refreshed rather than repeated");
  assert.equal(twice[0]!.at, "t2");
  let allow: MacAllowEntry[] = [];
  for (let index = 0; index < 51; index += 1) allow = rememberPrefix(allow, ["cmd", String(index)], "t");
  assert.equal(allow.length, 50);
  assert.deepEqual(allow[0]!.prefix, ["cmd", "1"], "the oldest entry is the one that went");
  assert.deepEqual(allow[49]!.prefix, ["cmd", "50"]);
});

test("a quoted argument with a space stays one word: the prefix is compared as words, never split", () => {
  const first = decideApproval('grp "a b"', { ...ask, allow: [] });
  assert.equal(first.kind, "ask");
  assert.deepEqual(first.kind === "ask" ? first.prefixWords : [], ["grp", "a b"]);
  const allow = rememberPrefix([], first.kind === "ask" ? first.prefixWords : [], "t");
  const again = decideApproval('grp "a b" x', { ...ask, allow });
  assert.equal(again.kind, "auto");
  assert.equal(decideApproval('grp "a  b" x', { ...ask, allow }).kind, "ask", "two spaces is another word");
});

test("a wrapper or an interpreter with no script of its own is never offered as a prefix", () => {
  const noRemember = [
    "sudo ls",
    "doas ls",
    "su -",
    "env FOO=1 ls",
    "xargs rm",
    "nohup ls",
    "time ls",
    "timeout 5 ls",
    "nice ls",
    "eval ls",
    "exec ls",
    "command ls",
    "builtin cd /",
    "sh",
    "bash -lc ls",
    "zsh -c ls",
    "python3 -c 1",
    "node -e 1",
    "perl -e 1",
    "ruby -e 1",
    "osascript -e 1",
    "rm -rf x",
    "git",
    "git -C x commit",
    "git -c core.pager=less status",
  ];
  for (const command of noRemember) {
    const decision = decideApproval(command, { ...ask, allow: [] });
    assert.equal(decision.kind, "ask", command);
    assert.equal(decision.kind === "ask" ? decision.remember : "x", undefined, `${command} must not offer "always allow"`);
  }
});

test("the prefixes that carry the command themselves stay rememberable", () => {
  const rememberable: [string, string][] = [
    ["npm test", "npm test"],
    ["mkdir -p /tmp/a", "mkdir -p"],
    ["git commit -m x", "git commit"],
    ["python3 scripts/x.py", "python3 scripts/x.py"],
  ];
  for (const [command, prefix] of rememberable) {
    const decision = decideApproval(command, { ...ask, allow: [] });
    assert.equal(decision.kind, "ask", command);
    assert.equal(decision.kind === "ask" ? decision.remember : "", `Always allow ${prefix}`, command);
  }
});
