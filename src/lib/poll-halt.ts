/**
 * Whether a failed poll response means "stop asking" rather than "try again".
 *
 * A poll that has been refused because the caller is not authenticated will be
 * refused identically on the next tick — the session does not come back on its
 * own. The Communication SMS poll used to treat every failure the same
 * (`if (!res.ok) return;`) and keep its 20s interval running, so one expired
 * session produced a failing request every 20 seconds for as long as the tab
 * stayed open: wasted client work, wasted server work, and console noise that
 * buries real errors. Egress is a stated constraint on the free plan, so this
 * is not only tidiness.
 *
 * Deliberately narrow. A 5xx or a network blip is transient and SHOULD retry —
 * halting on those would turn a momentary server hiccup into a panel that stays
 * stale until the page is reloaded. Only the two "you are not allowed, and
 * asking again will not change that" statuses stop the loop.
 */
export function pollShouldHaltAfterStatus(status: number): boolean {
  return status === 401 || status === 403;
}
