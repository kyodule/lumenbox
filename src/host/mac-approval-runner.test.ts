/**
 * The runner's own protocol (LUMENBOX-FORK), tested through the child process main.cjs starts.
 *
 * The bug this exists for: `decide` returned the prefix as text while main.cjs wanted words, so
 * "always allow" was accepted by both sides and stored by neither. The field names below are the
 * contract between main.cjs and electron/host-exec-runner.ts; a rename has to fail here.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RUNNER = join(ROOT, "electron", "host-exec-runner.ts");

/** One phase of the runner, the way main.cjs runs it: one job in, one JSON answer out. */
function run(job: unknown): { status: number | null; answer: Record<string, unknown> } {
  const out = spawnSync(process.execPath, ["--experimental-transform-types", "--no-warnings", RUNNER], {
    cwd: ROOT,
    input: JSON.stringify(job),
    encoding: "utf8",
    timeout: 60_000,
  });
  return { status: out.status, answer: JSON.parse(out.stdout) as Record<string, unknown> };
}

/** A phase that is expected to succeed; a refusal is the runner's own failing exit. */
function phase(job: unknown): Record<string, unknown> {
  const { status, answer } = run(job);
  assert.equal(status, 0, `the runner failed: ${JSON.stringify(answer)}`);
  return answer;
}

test("decide → remember → decide: the words the dialog offers are the words that are stored, and they work", () => {
  const first = phase({ phase: "decide", command: "mkdir -p /tmp/one", mode: "ask", allow: [] });
  assert.equal(first.kind, "ask");
  assert.deepEqual(first.prefixWords, ["mkdir", "-p"], "the answer carries words, not only the label");
  assert.equal(first.remember, "Always allow mkdir -p");

  const remembered = phase({ phase: "remember", allow: [], prefixWords: first.prefixWords, at: "2026-11-11T00:00:00.000Z" });
  const allow = remembered.allow as { prefix: string[]; at: string }[];
  assert.equal(allow.length, 1);
  assert.deepEqual(allow[0]!.prefix, ["mkdir", "-p"]);
  assert.equal(allow[0]!.at, "2026-11-11T00:00:00.000Z");

  const second = phase({ phase: "decide", command: "mkdir -p /tmp/two", mode: "ask", allow });
  assert.equal(second.kind, "auto", "the next command with those words runs without asking");
});

test("remember without words is refused rather than silently ignored", () => {
  const { status, answer } = run({ phase: "remember", allow: [], prefixWords: [] });
  assert.notEqual(status, 0, "a refused phase exits non-zero, which is how main.cjs notices");
  assert.match(String(answer.refused), /prefixWords is required/);
});

test("remember keeps the list it was given and adds one entry, under the cap", () => {
  const allow = Array.from({ length: 50 }, (_, index) => ({ prefix: ["cmd", String(index)], at: "t" }));
  const answer = phase({ phase: "remember", allow, prefixWords: ["mkdir", "-p"], at: "t2" });
  const next = answer.allow as { prefix: string[] }[];
  assert.equal(next.length, 50, "the cap holds");
  assert.deepEqual(next[49]!.prefix, ["mkdir", "-p"], "the new one is newest");
  assert.deepEqual(next[0]!.prefix, ["cmd", "1"], "the oldest fell off");
});