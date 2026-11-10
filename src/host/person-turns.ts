/**
 * Which turns a person opened, for a tool that must tell a person's turn and its continuation
 * after an approval (same turn id, synthetic wake) from a teammate's wake, a schedule or a
 * webhook, none of which carries a person's identity on a single-operator console either.
 * In memory: after a restart a continuation is not recognised and the person asks again.
 */
const LIMIT = 2000;
const opened = new Set<string>();

export function notePersonTurn(turnId: string): void {
  opened.delete(turnId); opened.add(turnId);
  if (opened.size > LIMIT) opened.delete(opened.values().next().value as string);
}

export function personOpenedTurn(turnId: string | undefined): boolean {
  return turnId !== undefined && opened.has(turnId);
}
