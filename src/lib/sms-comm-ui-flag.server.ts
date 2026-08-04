/**
 * SMS Communication UI feature flag.
 *
 * Gates ONLY the Communication UI — the compose "via SMS" channel, SMS
 * conversation rows, and the SMS thread panel. It must NEVER gate transport:
 * every SMS webhook, both production SMS agents (vendor one-job +
 * prospect/leasing), and phone provisioning stay live and untouched
 * regardless of this value.
 *
 * Server-resolved on purpose: it is read at request time in the section
 * renderer and threaded to the client components as a prop, so flipping the
 * Vercel env takes effect with no client rebuild. It is deliberately NOT a
 * `NEXT_PUBLIC_` var (those bake into the client bundle at build time and
 * would need a redeploy to flip).
 *
 * Default ON since the two-way messaging spine shipped (the SMS surface is
 * where a manager reads and answers texts in the portal; hiding it dead-ends
 * inbox replies to texters). Set `SMS_COMM_UI_ENABLED=0` to hide it again.
 *
 * ⚠️ Correctness: while this is OFF, inbound-SMS notices must still be VISIBLE.
 * They are NOT suppressed — they fall through into the person's conversation in
 * the unified email/conversation list instead of being routed to the hidden SMS
 * panel. See `filterEmailInboxThreads(threads, { keepSmsLike: !smsUiEnabled })`
 * in `src/lib/communication-inbox-filters.ts`. When SMS is enabled, those
 * same notices tag into the same per-person thread.
 */
export function isSmsCommUiEnabled(): boolean {
  const flag = process.env.SMS_COMM_UI_ENABLED?.trim().toLowerCase();
  if (flag === "0" || flag === "false") return false;
  return true;
}
