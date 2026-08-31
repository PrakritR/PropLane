/**
 * SMS Communication UI feature flag ("hide now / instant-on later").
 *
 * Residents have no textable number until A2P clears, so SMS is not yet a live
 * product surface. This flag gates ONLY the manager Communication UI — the
 * compose "via SMS" channel, SMS conversation rows, and the SMS thread panel.
 * It must NEVER gate transport: every SMS webhook, both production SMS agents
 * (vendor one-job + prospect/leasing), and phone provisioning stay live and
 * untouched regardless of this value.
 *
 * Server-resolved on purpose: it is read at request time in the section
 * renderer and threaded to the client components as a prop, so flipping the
 * Vercel env `SMS_COMM_UI_ENABLED=1` when A2P is approved takes effect with no
 * client rebuild. It is deliberately NOT a `NEXT_PUBLIC_` var (those bake into
 * the client bundle at build time and would need a redeploy to flip).
 *
 * Default OFF.
 *
 * Inbox replies to inbound work-number texts are NOT gated on this flag — they
 * follow the manager's live work-number `canSend` status so a prospect thread
 * stays replyable once the number is operational.
 *
 * ⚠️ Correctness: while this is OFF, inbound-SMS notices must still be VISIBLE.
 * They are NOT suppressed — they fall through into the person's conversation in
 * the unified email/conversation list instead of being routed to the hidden SMS
 * panel. See `filterEmailInboxThreads(threads, { keepSmsLike: !smsUiEnabled })`
 * in `src/lib/communication-inbox-filters.ts`. When SMS is later enabled, those
 * same notices tag into the same per-person thread.
 */
export function isSmsCommUiEnabled(): boolean {
  const flag = process.env.SMS_COMM_UI_ENABLED?.trim().toLowerCase();
  return flag === "1" || flag === "true";
}
