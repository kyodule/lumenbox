<!-- doc: 92-host-project-task-candidate
     title: Host project tasks — candidate and failed executor qualification
     family: decision
     status: superseded
     superseded-by: 93-host-project-task-cancellation
     why: The operator accepted managed-process cancellation and retained Mac task execution; historical failed qualification remains recorded here.
     updated: 2026-11-05
-->
# Host project tasks — candidate and failed executor qualification

This fork candidate is **not a deployable feature**. The production worker refuses to start
even if local configuration enables it. Legacy RunOnHost remains independently approved.

The candidate changes the authorization unit from a command string to a project task:
principal, agent, conversation, device, local policy digest, random task/grant IDs and a
two-hour deadline. Start requires one non-reusable approval. Subsequent serial commands
remain subject to operator deny/ask rules. Stop, expiry, disconnect and local policy changes
revoke the grant; late receipts cannot restore it. Results are acknowledged and recovered
without replaying commands. No SSH or system service is introduced.

The Mac snapshots a locally selected project. Source files are unchanged; Git metadata,
credential filenames, links and sockets are excluded. Limits: 300 MB / 30,000 files,
five minutes per command, 120,000 output bytes, 800,000 serialized receipt bytes. Snapshots
are retained for review; application back to the source and cleanup UI are not implemented.
The task does not grant network access. Data returned to the VM/model receives durable
source labels. Once approved for use outside the task, it is conservatively considered
shared across agents; this is an approval guard, not comprehensive DLP.

The local adapter uses a pinned runtime and public `app-server` `command/exec` with an
explicit restricted permission profile and an isolated configuration/environment. It
does not expose arbitrary RPC, process/spawn, shellCommand or a model turn. The qualified
candidate version was 0.166.0-alpha.5.1. `:root=deny`, `:minimal=read`, `:tmpdir=deny`,
`:slash_tmp=deny`, explicit project access and task temp write access were required.

## Evidence and release gate

The hermetic suite passes 2,823 tests. Typecheck, lint (existing warnings), architecture
limits, builds and available CLI artifact startup checks pass. No packaged App, production
VM, image availability or notarization was validated by these checks.

`scripts/qualify-host-task.mjs <codex-binary> <report.json>` is an explicit Mac canary harness,
outside the hermetic suite. It exercises 21 checks: 19 pass, two fail:

1. A generated executable forks, calls setsid, closes output descriptors and sleeps.
   command/exec returns exit 0, but the child remains alive with PPID 1 after executor
   termination. Terminating the app-server process group does not capture the child's new
   process group. The harness kills its own surviving fixture. Ordinary child cancellation
   passed, which is insufficient evidence for arbitrary-command revocation.
2. An offline Node test cannot execute: the minimal profile does not include the Homebrew
   executable tree (exit 127). Adding a path to PATH grants no filesystem permission.
   Real project toolchains need separate local, read-only ceilings and qualification.

Filesystem read/write denial, symlink and hardlink escape denial, TCP and Unix-socket
denial, preference-service denial, clean environment, read-only enforcement, bounded Unicode
output, ordinary child cancellation, job deduplication, expired/revoked jobs and receipt
recovery passed. An attempted extra Seatbelt wrapper failed: macOS rejects nested
sandbox_apply. Do not remove the filesystem sandbox to make that wrapper work.

Production `loadTaskPolicy` therefore hard-refuses. Only the canary harness can select
qualification mode through a code argument; no configuration flag or protocol message can
enable it. The task capability must remain unadvertised. No automatic legacy fallback.

## Next decision

The task grant and transport are reusable. A smaller capability can expose deterministic
project file reading/search/editing on the Mac and run arbitrary code/tests in the existing
VM. This changes execution location, data transfer scope and platform semantics and needs
an explicit scope decision. macOS-specific arbitrary execution instead needs a runtime
whose process containment passes the detached-child test. Shell blacklists, PID polling
and PTY close are not substitutes for that evidence.

Independent review found and this candidate corrected: duplicate shutdown racing process
termination, quota-blocked cancellation, once-only approvals losing their scope on restart,
missing receipt recovery, data-source propagation through task assignment, streaming UTF-8
decoding, and late start receipts overwriting cancelled status. A further review is required
before any release; this record does not certify the experimental executor for use.
