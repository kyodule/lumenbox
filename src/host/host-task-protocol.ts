/** LUMENBOX-FORK: our narrow protocol; Codex RPC never crosses the Mac boundary. */
export const HOST_TASK_PROTOCOL = 1;
export const HOST_TASK_TTL_MS = 2 * 60 * 60_000;
export const HOST_TASK_START_MS = 30_000;
export const HOST_TASK_OUTPUT_BYTES = 120_000; // JSON escaping can expand one byte to six.
export const HOST_TASK_WIRE_BYTES = 800_000;
export const HOST_TASK_COMMAND_MS = 300_000;
export const HOST_TASK_CANCELLATION = "managed-processes";
export const HOST_TASK_CANCELLATION_NOTICE = "Stopping blocks new commands and attempts to terminate managed commands; the receipt reports whether cleanup was confirmed. Detached processes or work handed to other applications may remain. Completed changes are retained, not rolled back. Never resume or replay automatically; continuing requires a new task approval.";
export const HOST_TASK_STOP_NOTICE = `Authorization is revoked. ${HOST_TASK_CANCELLATION_NOTICE}`;
export interface HostTaskCleanup {
  managedProcesses: "stopped" | "unconfirmed";
  detachedProcesses: "may-remain";
  detail?: string;
}
export const unconfirmedCleanup = (): HostTaskCleanup => ({ managedProcesses: "unconfirmed", detachedProcesses: "may-remain" });

export interface HostTaskCapabilities {
  protocol: 1;
  deviceId: string;
  policyVersion: string;
  roots: string[];
  runtime: string;
  cancellation: typeof HOST_TASK_CANCELLATION;
  toolchainReadPaths: string[];
}
export interface HostTaskOwner { principalId: string; agentId: string; conversation: string }
export interface HostTaskGrant extends HostTaskOwner {
  taskId: string;
  grantId: string;
  deviceId: string;
  policyVersion: string;
  purpose: string;
  root: string;
  access: "read" | "write";
  expiresAt: number;
  network: false;
  cancellation: typeof HOST_TASK_CANCELLATION;
}
export type HostTaskAction = "start" | "run" | "finish" | "cancel" | "status";
export interface HostTaskJob {
  protocol: 1;
  id: string;
  sessionId: string;
  action: HostTaskAction;
  grant: HostTaskGrant;
  startBefore: number;
  command?: string;
  timeoutMs?: number;
}
export interface HostTaskResult {
  state: "active" | "completed" | "cancelled" | "failed" | "unknown";
  workspace?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  truncated?: boolean;
  error?: string;
  authorization?: "active" | "revoked";
  cleanup?: HostTaskCleanup;
  notice?: string;
}
export interface HostTaskAnswer {
  id: string;
  sessionId: string;
  deviceId: string;
  grantId: string;
  event: "started" | "result";
  result?: HostTaskResult;
}
export const hostTaskId = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]{8,80}$/.test(value);
export function capabilitiesOf(raw: unknown): HostTaskCapabilities | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const c = raw as HostTaskCapabilities;
  if (c.protocol !== HOST_TASK_PROTOCOL || c.cancellation !== HOST_TASK_CANCELLATION || !hostTaskId(c.deviceId) || !hostTaskId(c.policyVersion) ||
      typeof c.runtime !== "string" || c.runtime.length > 100 || !Array.isArray(c.roots) || c.roots.length < 1 || c.roots.length > 8 ||
      !Array.isArray(c.toolchainReadPaths) || c.toolchainReadPaths.length > 64 ||
      [...c.roots, ...c.toolchainReadPaths].some(root => typeof root !== "string" || !root.startsWith("/") || root.length > 500 || [...root].some(c => c.charCodeAt(0) < 32))) return undefined;
  return { protocol: HOST_TASK_PROTOCOL, deviceId: c.deviceId, policyVersion: c.policyVersion, roots: [...c.roots], runtime: c.runtime,
    cancellation: HOST_TASK_CANCELLATION, toolchainReadPaths: [...c.toolchainReadPaths] };
}
