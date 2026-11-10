import type Anthropic from "@anthropic-ai/sdk";
import { DesktopHostRunner } from "./host-runner.ts";
import type { ToolContext, ToolOutcome } from "./tools.ts";
import type { PolicyGate } from "./policy.ts";
import type { DesktopHostTasks } from "./host-tasks.ts";
import { HOST_TASK_CANCELLATION_NOTICE } from "./host-task-protocol.ts";
import { personOpenedTurn } from "./person-turns.ts";

/** The principal of a single-operator console, whose turns carry no signed-in identity. */
export const CONSOLE_OPERATOR = "console-operator";

export const HOST_TASK_TOOL: Anthropic.Tool = {
  name: "HostTask",
  description: "Work on a project on the person's Mac with one task approval. First use list to see locally allowed projects. " +
    "Start names an exact project, purpose, and read/write access. The person approves a project COPY for up to two hours; network is disabled. " +
    "Results go to this server and model. Scope, secrets, Git metadata, symlinks and IPC are restricted by the Mac. " +
    "Use the returned taskId for multiple run commands (POSIX shell, no login profile). Commands are serial and max 5 minutes. " +
    "Edits remain in the returned local workspace; finish revokes access and retains it for review, without applying edits to the source. " +
    "Cancel immediately revokes permission for new commands and terminates managed command sessions. Detached processes or work handed to other apps may remain; inspect cleanup in the receipt. " +
    "Stopping does not roll back completed changes. Status returns job receipts; never resume or replay unknown jobs automatically. Continuing needs a new task approval. Do not use RunOnHost as an automatic fallback. " +
    "No delegation. Operator deny/ask rules still apply.",
  input_schema: { type: "object", properties: {
    action: { type: "string", enum: ["list", "start", "run", "finish", "cancel", "status"] },
    root: { type: "string" }, purpose: { type: "string" }, access: { type: "string", enum: ["read", "write"] },
    taskId: { type: "string" }, command: { type: "string" },
  }, required: ["action"], additionalProperties: false },
};
const bound = new WeakMap<PolicyGate, Set<DesktopHostTasks>>();
export async function hostTaskTool(input: Record<string, unknown>, context: ToolContext): Promise<ToolOutcome> {
  try {
    const policy = context.policy, runner = context.hostRunner;
    if (!policy || !(runner instanceof DesktopHostRunner)) throw new Error("Host tasks require the authenticated desktop runner and policy gate");
    if (!context.conversation || context.conversation.startsWith("fork/")) throw new Error("Host tasks require a person's conversation; delegation is not supported");
    // A signed-in caller is that person; otherwise only a turn a person opened (or its continuation) acts as the console's operator.
    const principalId = context.caller?.userId ?? (personOpenedTurn(context.turnId) ? CONSOLE_OPERATOR : undefined);
    if (!principalId) throw new Error("Host tasks run only in a turn a person opened; a teammate's, a schedule's or a webhook's wake cannot start or use one");
    const tasks = runner.tasks;
    let set = bound.get(policy); if (!set) { set = new Set(); bound.set(policy, set); }
    if (!set.has(tasks)) { policy.onStop(id => tasks.stopAgent(id)); set.add(tasks); }
    const owner = { principalId, agentId: context.agent.id, conversation: context.conversation };
    const base = { kind: "tool" as const, agentId: owner.agentId, agentName: context.agent.profile.name, principalId: owner.principalId,
      principalName: context.callerName, turnId: context.turnId, tool: "HostTask" };
    const action = input.action;
    if (!["list", "start", "run", "status", "finish", "cancel"].includes(String(action))) throw new Error("Unknown HostTask action");
    const task = action === "list" ? undefined : action === "start" ? tasks.propose(owner, input) : tasks.get(owner, input.taskId);
    // The nonce, identity, ceiling and deadline are trusted facts. No model-supplied grant is accepted.
    const approvedInput: Record<string, unknown> = action === "start" ? { action, ...task!.grant,
      editing: "isolated project copy; source unchanged; excluded credentials, Git metadata and links", data: "results to your server and configured model",
      toolchainReadPaths: tasks.capabilities?.toolchainReadPaths, stopping: HOST_TASK_CANCELLATION_NOTICE } : input;
    const decision = policy.check({ ...base, input: approvedInput, ...(action === "start" ? {
      irreversible: "Authorize this Mac project task until its deadline", onceOnly: true as const,
    } : {}) });
    if (!decision.allow) return { text: decision.reason, isError: true, ...(decision.approval ? { approval: { id: decision.approval.id } } : {}) };
    if (action === "list") return { text: JSON.stringify(tasks.capabilities ?? { unavailable: "Mac task execution is disconnected or unconfigured" }) };
    if (action === "status") return { text: JSON.stringify(tasks.status(task!)) };
    if (action === "run") policy.markHostRead(owner.agentId); // Persist before any private result can enter context.
    const result = action === "start" ? await tasks.start(task!) : action === "run" ? await tasks.run(task!, input.command) : await tasks.end(task!, action as "finish" | "cancel");
    return { text: JSON.stringify({ taskId: task!.grant.taskId, ...result }), ...(result.state === "failed" || result.state === "unknown" ? { isError: true } : {}) };
  } catch (error) { return { text: `HostTask refused: ${error instanceof Error ? error.message : String(error)}`, isError: true }; }
}
