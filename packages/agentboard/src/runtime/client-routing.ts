/**
 * Resolve which mux clients a sidebar-initiated switch should move.
 *
 * A sidebar pane lives inside a session; any client viewing that sidebar is by
 * definition attached to that session. So the clients to switch are exactly the
 * ones attached to `fromSession`, resolved against a live client list at switch
 * time. (Storing "the last client that switched to a session" goes stale the
 * moment that client moves on — with two terminals attached, a stored tty
 * routes the switch to the wrong terminal.)
 *
 * Returns the ttys to switch. Empty means the caller should fall back to the
 * mux's default client targeting (most-recently-active).
 */
export function resolveSwitchTargets(
  clients: ReadonlyArray<{ tty: string; sessionName: string }>,
  fromSession: string | undefined | null,
): string[] {
  if (!fromSession) return [];
  return clients.filter((c) => c.sessionName === fromSession).map((c) => c.tty);
}
