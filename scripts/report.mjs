#!/usr/bin/env node
/**
 * Turns one follow-upstream run into one issue per upstream version: opened as "需要处理",
 * renamed "候选就绪" once a run passes, every run a comment. Exits 1 unless the candidate is
 * ready, so a run that needs a person is also red on the Actions page.
 *
 * DRY_RUN=1 prints the title and body instead of writing.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const env = process.env;
const REPO = env.REPO ?? "kyodule/lumenbox";
const UPSTREAM = env.UPSTREAM ?? "fakechris/lumenbox";
const OWNER = env.OWNER ?? REPO.split("/")[0];
const LABEL = "follow-upstream";
const needs = JSON.parse(env.NEEDS ?? "{}");
const job = name => needs[name] ?? { result: "skipped", outputs: {} };
const plan = job("plan");
const p = plan.outputs ?? {};
const rebase = job("rebase");
const r = rebase.outputs ?? {};
const tag = p.tag ?? "";
const mode = p.mode ?? "";
const candidateDir = env.CANDIDATE_DIR ?? "candidate";
const gh = (...args) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const conflict = mode === "rebase" && rebase.result === "success" && r.result === "conflict";
const ready =
  plan.result === "success" &&
  p.skip !== "true" &&
  ["check", "image", "dmg"].every(name => job(name).result === "success") &&
  (mode === "check" || (r.result === "ok" && job("publish").result === "success"));

let title;
if (plan.result !== "success") title = tag ? `跟进上游 ${tag}：需要处理` : "跟进上游：运行失败";
else if (p.skip === "true") title = "跟进上游：main 同步失败";
else title = `跟进上游 ${tag}：${ready ? "候选就绪" : "需要处理"}`;

const mark = result => ({ success: "通过", failure: "失败", cancelled: "取消", skipped: "跳过" })[result] ?? result;
const lines = [`@${OWNER}`, ""];
if (tag) lines.push(`- 上游版本：[${tag}](https://github.com/${UPSTREAM}/releases/tag/${tag})`);
if (mode) lines.push(`- 方式：${mode === "rebase" ? `从 \`${p.base_branch}\` rebase` : `检查已推送的 \`ours/${tag}\``}`);
lines.push(`- main 同步：${p.sync === "ok" ? "成功" : p.sync === "failed" ? "**失败**" : p.sync || "未执行"}${p.sync_detail ? `（${p.sync_detail}）` : ""}`);
lines.push(`- 运行记录：${env.RUN_URL ?? ""}`, "");
if (plan.result !== "success") lines.push(`**plan 失败**：${p.reason || "见运行记录"}`, "");
if (p.skip !== "true" && plan.result === "success") {
  lines.push("| 步骤 | 结果 |", "|---|---|");
  if (mode === "rebase") lines.push(`| rebase | ${conflict ? "**冲突**" : mark(rebase.result)} |`);
  lines.push(`| 上游 CI 检查（typecheck、lint、arch、test、build、release-check） | ${mark(job("check").result)} |`);
  lines.push(`| amd64 镜像构建 | ${mark(job("image").result)} |`);
  lines.push(`| DMG 文件比对 | ${mark(job("dmg").result)} |`);
  if (mode === "rebase") lines.push(`| 推送 \`ours/${tag}\` | ${mark(job("publish").result)} |`);
  lines.push("");
}
if (conflict) {
  lines.push(`**rebase 冲突**：停在 \`${r.stopped_at}\`，冲突文件：${r.conflicts}`, "");
  lines.push("在本机解决后推送，再触发一次“只检查”：", "```sh");
  lines.push("git fetch origin && git fetch upstream --tags");
  lines.push(`git switch -c ours/${tag} origin/${p.base_branch}`);
  lines.push(`git rebase --onto ${tag} ${p.base_tag}`);
  lines.push("# 解决冲突，跑 npm run check，然后：");
  lines.push(`git push -u origin ours/${tag}`);
  lines.push(`gh workflow run follow-upstream.yml -R ${REPO} --ref automation -f version=${tag} -f mode=check`);
  lines.push("```", "");
}
if (p.sync === "failed" || job("publish").result === "failure") {
  lines.push("如果日志里是 `refusing to allow a GitHub App to create or update workflow`：上游改了工作流文件，`GITHUB_TOKEN` 推不了。在 Mac 上执行：", "```sh");
  lines.push(`gh repo sync ${REPO} --source ${UPSTREAM} --branch main`);
  lines.push(`gh workflow run follow-upstream.yml -R ${REPO} --ref automation${tag ? ` -f version=${tag}` : ""}`);
  lines.push("```", "");
}
if (ready) {
  lines.push("**部署（确认后在 Mac 上执行）**：", "```sh");
  lines.push(`ops/lumenbox/deploy-vm.sh ${tag}            # VM：备份卷，从 ours/${tag} 构建并换容器`);
  lines.push(`ops/lumenbox/install-remote-app.sh <LumenBox-${tag.slice(1)}-arm64.dmg>   # App：比对后覆盖并签名`);
  lines.push("```", "");
  lines.push(`我们的改动：https://github.com/${REPO}/compare/${p.tag_sha}...ours/${tag}`, "");
}
const rangeDiff = join(candidateDir, "range-diff.txt");
if (existsSync(rangeDiff)) {
  const text = readFileSync(rangeDiff, "utf8");
  const shown = text.length > 50_000 ? `${text.slice(0, 50_000)}\n…（已截断，全文在运行记录的 candidate 产物里）` : text;
  lines.push("<details><summary>range-diff（上一版的提交 → 这一版）</summary>", "", "```", shown.trimEnd(), "```", "</details>");
}
const body = lines.join("\n");

if (env.DRY_RUN === "1") {
  console.log(`${title}\n\n${body}`);
} else {
  try {
    gh("label", "create", LABEL, "-R", REPO, "--color", "0e8a16", "--description", "follow-upstream 工作流");
  } catch {
    // Already there.
  }
  const file = join(tmpdir(), "follow-upstream-body.md");
  writeFileSync(file, body);
  const open = JSON.parse(gh("issue", "list", "-R", REPO, "--label", LABEL, "--state", "open", "--json", "number,title", "--limit", "100"));
  const key = tag ? `跟进上游 ${tag}：` : title;
  const existing = open.find(issue => issue.title.startsWith(key));
  if (existing) {
    if (existing.title !== title) gh("issue", "edit", String(existing.number), "-R", REPO, "--title", title);
    gh("issue", "comment", String(existing.number), "-R", REPO, "--body-file", file);
    console.log(`commented on #${existing.number}: ${title}`);
  } else {
    console.log(gh("issue", "create", "-R", REPO, "--title", title, "--label", LABEL, "--body-file", file));
  }
}
process.exit(ready ? 0 : 1);
