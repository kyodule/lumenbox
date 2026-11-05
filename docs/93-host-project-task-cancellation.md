<!-- doc: 93-host-project-task-cancellation
     title: Host project tasks — authorization and cancellation are separate
     family: decision
     status: current
     updated: 2026-11-05
-->
# Host project tasks — authorization and cancellation are separate

## Unspecified items and the defaults chosen

The operator explicitly approved native Mac command execution with one task approval,
immediate revocation of permission to start commands, cleanup of managed processes, and
the possibility that detached processes continue. This supersedes the all-descendants
release condition in docs/92. It does not weaken the filesystem or network boundary.

Other approved defaults remain: one person and one Mac, two-hour grants, five minutes per
command, a locally selected project copy, no network access, no automatic source writeback,
300 MB / 30,000 snapshot files, and bounded output and receipts. Legacy RunOnHost keeps its
separate approval. The runtime is an operator-installed binary pinned by version and hash;
it is not bundled, downloaded automatically or registered with a cloud executor service.

Implementation defaults: system command paths plus locally configured read-only toolchain
paths; Node's versioned installation and its resolved dylib directories are the first
qualified extra toolchain. A read-only task-local Node launcher selects those libraries
and an empty OpenSSL configuration, without exposing the package manager's entire prefix,
personal shell configuration, credentials or global OpenSSL configuration. Node native
add-ons and other toolchains require their own local paths and verification.

## Decision and alternatives

| Option | Trade-off | Decision |
| --- | --- | --- |
| Mac commands with task authorization and managed-process cancellation | Native tools and continuous work; detached processes may remain | Chosen explicitly by the operator |
| Mac deterministic file operations, arbitrary execution in VM | Easier process containment; changes platform and data movement | Rejected for the requested local execution experience |
| Mac commands with guaranteed termination of every descendant | Stronger lifecycle guarantee; the tested runtime does not provide it | Not required by the operator; no speculative alternative executor added |

This is fast-moving execution tooling. The evidence is the 2026-11-05 local installation,
its command/exec interface and real Mac canaries, not model memory or another product's
claims. Counterevidence is retained: the detached daemon probe still survives ordinary
cleanup. Node initially failed with exit 127, then 134 at dyld, then at the global OpenSSL
configuration. Explicit toolchain paths and the launcher pass the offline Node test.

## Contract

- Permission is revoked before waiting for process termination. Cancel, finish, expiry,
  disconnect, App stop and policy change prevent new commands. Cancellation must not
  depend on a valid current policy file, a working updated runtime or remaining work quota.
- The adapter requests command-session termination and kills its own executor group.
  A receipt reports `authorization` separately from `cleanup.managedProcesses`.
  `stopped` needs a confirmed command completion or successful termination request plus
  confirmed group exit. Errors, timeouts, missing receipts or missing cleanup data are
  `unconfirmed`. `cleanup.detachedProcesses` always says `may-remain`.
- A stopped task retains its project copy and receipts. Stopping does not undo file
  writes. There is no claim that the copy cannot change after a detached process survives.
- Reconnection transfers receipts only. It never replays commands or resumes an old grant.
  Late successful command results record completed work but cannot restore authorization.
  Continuing requires a new task approval. There is no automatic RunOnHost fallback.
- Task status remains available for known tasks after the Mac disconnects, with process
  cleanup reported as unconfirmed when no valid terminal receipt arrived.

## Given / When / Then acceptance

| Given | When | Then |
| --- | --- | --- |
| One approved project task | Thirty different commands across turns | One task approval; operator deny/ask rules still precede the grant |
| A running managed child | User cancels while a new command arrives | Grant revoked immediately, new command refused, managed child ends |
| A broken/changed local configuration | User cancels the current task | Cleanup still runs against the already validated task |
| Lost or rejected termination RPC | Executor exits | Receipt never implies confirmed command cleanup from executor exit alone |
| An expired/disconnected task | Cancel or a late result arrives | No new execution, progress can be recorded, old grant stays revoked |
| A detached daemon | Managed cleanup completes | Known limitation is reported; no claim of complete descendant termination |
| A read-only toolchain and a writable project copy | Node executes offline tests | Tests run; toolchain writes, source writes, outside reads and command network stay denied |
| Completed writes and an uncertain command | Stop, restart or reconnect | Completed copy retained, receipts recover, command is not replayed |

## Operation, recovery and reversibility

Local policy is `~/.agentbox/host-tasks.json`, independent of remote job input. Setup:

```
node --experimental-transform-types scripts/host-task-config.mjs <new-policy.json> <codex-binary> <project> <node-binary>
node --experimental-transform-types scripts/qualify-host-task.mjs <codex-binary> <report.json>
```

The setup script refuses an existing file. The Mac App can subsequently select project
roots, and watching local policy changes revokes the existing connection. Neither the
server nor a model can add toolchain permissions. A runtime update invalidates the pinned
hash and requires requalification, rather than silently using a changed executor.

On cancellation inspect the task status, workspace, recent job receipts and local
`host-task-data/<taskId>/control/stopped.json`. `unconfirmed` means the managed command
may still run; `may-remain` means detached work has not been ruled out. Inspect candidate
processes before manually ending them: do not kill by a stale PID or command-name pattern.
Review retained outputs before requesting a new task; unknown results are never permission
to rerun the command. No rollback or automatic checkpoint restore is promised.

Disable by setting local `enabled:false` or Mac execution Off. This revokes dispatch and
attempts managed cleanup under the same contract. App/server releases can be reverted to
the previous fork build. The permission/transport modules are reusable if a future local
executor provides a stronger contract. Revisit on a runtime upgrade or observed managed
cleanup failure, not merely because a known detached daemon survives.

Non-goals: GUI/TCC control, command networking, complete DLP, all-descendant containment,
automatic source writeback, dependency installation, complete output pagination, disk
cleanup UI, or historical task queries across a VM restart. The first toolchain test does
not certify every existing project's dependency tree or native add-on.

## Verification record

The revised Mac harness passed all 24 required checks; the detached daemon survived and
was recorded separately as an accepted limitation, then killed by the harness. It is not
counted as a successful strong-cancellation check. Hermetic focused tests also exercise a
fake termination-RPC failure and require an unconfirmed receipt. `npm run check` passed
2,826 tests plus typecheck, lint and architecture checks; builds pass. The real Electron
worker and authenticated loopback transport passed 16 runs, four concurrent, including
Node execution, cancellation and reconnect refusal. An earlier run under concurrent full
suite load returned `unconfirmed` instead of the test's expected `stopped`; this remains
recorded as a possible unconfirmed cleanup outcome, never as proof of complete cleanup.
Packaged-App and VM deployment verification are recorded separately when actually performed.
