/**
 * Who a turn acts for when it carries no signed-in identity, for a tool that must tell a person's
 * turn from a teammate's wake, a schedule or a webhook. Two ways a turn is a person's: the person
 * opened it, or it is the wake their approval sends ("[The person allowed it…]"), which acts for
 * whoever the approved call was asked for. In memory: after a restart the person asks again.
 */
export const CONSOLE_OPERATOR = "console-operator";
const LIMIT = 2000;
const actingTurns = new Map<string, string>();
const askedApprovals = new Map<string, string>();

function remember(map: Map<string, string>, key: string, value: string): void {
  map.delete(key); map.set(key, value);
  if (map.size > LIMIT) map.delete(map.keys().next().value as string);
}

/** A person opened this turn; on a single-operator console that person is its operator. */
export function notePersonTurn(turnId: string): void { remember(actingTurns, turnId, CONSOLE_OPERATOR); }
/** The approved call was asked for `principalId`; its approval's wake acts for them. */
export function noteAskedFor(approvalId: string, principalId: string): void { remember(askedApprovals, approvalId, principalId); }
/** This turn opened on the person's answer to `approvalId`. */
export function noteApprovalWake(turnId: string, approvalId: string): void {
  const principal = askedApprovals.get(approvalId);
  if (principal !== undefined) remember(actingTurns, turnId, principal);
}

/** As a turn opens: a person's turn, or a wake that names the approval a person allowed, acts for someone. */
export function noteTurnOpened(turnId: string, personOpened: boolean, inbound: readonly { answeredApproval?: string }[]): void {
  if (personOpened) { notePersonTurn(turnId); return; }
  for (const message of inbound) if (message.answeredApproval !== undefined) noteApprovalWake(turnId, message.answeredApproval);
}
export function actingFor(turnId: string | undefined): string | undefined {
  return turnId === undefined ? undefined : actingTurns.get(turnId);
}
