# kyodule/lumenbox

[fakechris/lumenbox](https://github.com/fakechris/lumenbox) 的 fork，加了两样东西：App 的“连接远程服务端”模式，以及让服务端把 RunOnHost 交给 Mac 上的 App 执行。许可证与上游相同（GPL-3.0）。

## 分支

| 分支 | 内容 |
|---|---|
| `main` | 上游 `main` 的镜像，只快进，不放我们的提交 |
| `ours/vX.Y.Z` | 上游 tag `vX.Y.Z` 加上我们的提交。每个上游版本一个，只增不删，旧的用来回滚 |
| `automation`（默认分支） | 本说明、`follow-upstream` 工作流和它的脚本。没有 LumenBox 代码 |

看我们改了什么：`https://github.com/kyodule/lumenbox/compare/vX.Y.Z...ours/vX.Y.Z`（tag 在上游，比较页可能要用 tag 的提交号）。

## 每周做什么（`.github/workflows/follow-upstream.yml`）

每周一北京时间 09:00：

1. 重新启用这个工作流（公开仓库 60 天没有活动，定时任务会被停用）。
2. 把 `main` 快进到上游。
3. 选上游最新的、发布满 3 天的正式版本 vX。已有 `ours/vX` 就安静结束。
4. 把上一个 `ours/*` 上的提交 rebase 到 vX（只跑 git）。
5. 并行检查：上游 CI 的全部步骤（typecheck、lint、arch、test、build、release-check）；amd64 镜像能构建（不推送）；官方 DMG 里被我们替换或依赖的文件与 vX 源码一致。
6. 全部通过就推送 `ours/vX`。结果写进带 `follow-upstream` 标签的 Issue：“候选就绪”或“需要处理”。同一版本只有一个 Issue，之后的运行在里面加评论。

手动触发（Actions → follow-upstream → Run workflow，或 `gh workflow run follow-upstream.yml -R kyodule/lumenbox --ref automation`）：

- `version=vX.Y.Z`：指定版本，不等 3 天。
- `mode=check`：只检查已经推送的 `ours/vX`。rebase 冲突在本机解决、推送后用它。
- `ignore_age=true`：不指定版本，但不等 3 天。

## 权限

- 跑上游代码（npm 安装、测试、构建）的 `check`、`image`、`dmg` 只有只读权限，也不保存 git 凭据。
- 只有 `plan`（同步 `main`、保持定时任务启用）、`publish`（推 `ours/vX`）、`report`（写 Issue）有写权限，它们只跑 git、gh 和本分支的脚本。
- 只用 GitHub 自带的 `GITHUB_TOKEN`，没有别的密钥。它不能推送改了 `.github/workflows/` 的提交：上游改了工作流文件的那周，同步会失败，Issue 里会给出在本机执行的命令。

## 部署

这里只准备候选版本，不部署。部署由人确认后在本机执行（私有运维仓库里的脚本）：服务端镜像从 `ours/vX` 构建；Mac App 用官方签名的 DMG，比对通过后换上 `ours/vX` 的 `electron/main.cjs` 和 `electron/host-exec-runner.ts`，再本机签名。
