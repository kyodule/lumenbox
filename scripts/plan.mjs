#!/usr/bin/env node
/**
 * Decides what one follow-upstream run does, and does the two writes that need no upstream code:
 * keep this schedule enabled, and fast-forward main to upstream. Everything else only reads.
 *
 * Outputs (GITHUB_OUTPUT): skip, reason, tag, tag_sha, mode, base_branch, base_tag, sync,
 * sync_detail. DRY_RUN=1 performs no write and prints the outputs instead.
 */
import { appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const env = process.env;
const REPO = env.REPO ?? "kyodule/lumenbox";
const UPSTREAM = env.UPSTREAM ?? "fakechris/lumenbox";
const DRY = env.DRY_RUN === "1";
const MIN_AGE_DAYS = 3;
const outputs = {};

const gh = (...args) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const json = (...args) => JSON.parse(gh(...args));
const set = (key, value) => {
  outputs[key] = String(value ?? "");
};
const parse = tag => /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag)?.slice(1).map(Number);
const cmp = (a, b) => {
  const x = parse(a);
  const y = parse(b);
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};
const errorText = error => (error.stderr?.toString() || error.message || String(error)).trim().split("\n").slice(-3).join(" ");

function finish(code) {
  const lines = Object.entries(outputs).map(([key, value]) => `${key}<<__OUT__\n${value}\n__OUT__\n`);
  if (env.GITHUB_OUTPUT && !DRY) appendFileSync(env.GITHUB_OUTPUT, lines.join(""));
  const summary = Object.entries(outputs).map(([key, value]) => `- **${key}**: ${value.replaceAll("\n", " ")}`).join("\n");
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `### plan\n${summary}\n`);
  console.log(summary);
  process.exit(code);
}

function skip(reason) {
  set("skip", "true");
  set("reason", reason);
  finish(0);
}

try {
  // A public repository's schedule is switched off after 60 days without activity. Enabling the
  // workflow again on every run is the same renewal gh-workflow-keepalive makes.
  const workflow = (env.GITHUB_WORKFLOW_REF ?? "").replace(/^[^/]+\/[^/]+\/(.+)@.*$/, "$1").replace(/^\.github\/workflows\//, "");
  if (workflow && !DRY) {
    try {
      gh("api", "-X", "PUT", `repos/${REPO}/actions/workflows/${workflow}/enable`);
    } catch (error) {
      console.log(`could not re-enable ${workflow}: ${errorText(error)}`);
    }
  }

  // GITHUB_TOKEN may not write workflow files, so a week in which upstream changed one fails
  // here; the report says how to sync from a machine whose gh login can.
  if (DRY) {
    set("sync", "dry-run");
  } else {
    try {
      const merged = json("api", "-X", "POST", `repos/${REPO}/merge-upstream`, "-f", "branch=main");
      set("sync", "ok");
      set("sync_detail", `${merged.merge_type ?? ""} ${merged.message ?? ""}`.trim());
    } catch (error) {
      set("sync", "failed");
      set("sync_detail", errorText(error));
    }
  }

  const releases = json("api", `repos/${UPSTREAM}/releases?per_page=50`)
    .filter(release => !release.draft && !release.prerelease && parse(release.tag_name))
    .sort((a, b) => cmp(b.tag_name, a.tag_name));
  const requested = (env.INPUT_VERSION ?? "").trim();
  const mode = env.INPUT_MODE === "check" ? "check" : "rebase";
  let release;
  if (requested !== "") {
    // A version named by hand is taken whatever its age: that is how a security fix goes in early.
    release = releases.find(candidate => candidate.tag_name === requested);
    if (release === undefined) throw new Error(`${requested} is not a published upstream release`);
  } else {
    const cutoff = Date.now() - MIN_AGE_DAYS * 86_400_000;
    const ignoreAge = env.INPUT_IGNORE_AGE === "true";
    release = releases.find(candidate => ignoreAge || Date.parse(candidate.published_at) <= cutoff);
    if (release === undefined) skip(`no upstream release is ${MIN_AGE_DAYS} days old yet`);
  }
  const tag = release.tag_name;
  set("tag", tag);
  set("mode", mode);
  set("tag_sha", gh("api", `repos/${UPSTREAM}/commits/${tag}`, "--jq", ".sha"));

  const ours = gh("api", "--paginate", `repos/${REPO}/branches?per_page=100`, "--jq", ".[].name")
    .split("\n")
    .filter(name => name.startsWith("ours/") && parse(name.slice(5)))
    .map(name => name.slice(5))
    .sort(cmp);

  if (mode === "check") {
    if (!ours.includes(tag)) throw new Error(`mode check needs ours/${tag}, which is not pushed`);
    finish(0);
  }
  if (ours.includes(tag)) skip(`ours/${tag} already exists; run mode check to check it again`);
  const newest = ours.at(-1);
  if (newest !== undefined && cmp(newest, tag) > 0) skip(`ours/${newest} is already past ${tag}`);
  const base = ours.filter(candidate => cmp(candidate, tag) < 0).at(-1);
  if (base === undefined) throw new Error(`no ours/vX.Y.Z branch older than ${tag} to start from`);
  set("base_branch", `ours/${base}`);
  set("base_tag", base);
  finish(0);
} catch (error) {
  set("reason", errorText(error));
  console.error(error);
  finish(1);
}
