/**
 * An in-memory stand-in for `@/lib/sms-consent`'s scoped ledger + suppression
 * reads, with the SAME semantics the dispatcher relies on: the latest event for
 * (phone, manager, purpose, send class, conversation key, messaging service) wins,
 * and STOP (suppression) is read separately and is final. Used by the vendor
 * texting tests so consent behaviour is exercised end to end, not asserted on mocks.
 */
export type LedgerEvent = {
  phoneKey: string;
  managerUserId: string;
  purpose: string;
  sendClass: string;
  conversationKey: string | null;
  messagingServiceSid: string | null;
  eventType: "granted" | "revoked";
  source: string;
  evidence: Record<string, unknown>;
  wordingVersion?: string | null;
};

export function createConsentLedger(db?: { __tables: Record<string, Record<string, unknown>[]> }) {
  const events: LedgerEvent[] = [];
  let seq = 0;
  const optedOut = new Set<string>();
  const key = (phone: string) => String(phone).replace(/\D/g, "").slice(-10);
  return {
    events,
    /** STOP on any rail: the number is suppressed everywhere. */
    stop(phone: string) {
      optedOut.add(key(phone));
    },
    start(phone: string) {
      optedOut.delete(key(phone));
    },
    module: {
      normalizeConsentPhone: (phone: string) => key(phone),
      readSmsSuppressionState: async (phone: string) => ({ ok: true as const, optedOut: optedOut.has(key(phone)) }),
      readScopedSmsConsentState: async (
        phone: string,
        scope: { managerUserId: string; purpose: string; sendClass: string; conversationKey?: string | null; messagingServiceSid?: string | null },
      ) => {
        const matching = events.filter(
          (event) =>
            event.phoneKey === key(phone) &&
            event.managerUserId === scope.managerUserId &&
            event.purpose === scope.purpose &&
            event.sendClass === scope.sendClass &&
            (!scope.conversationKey || event.conversationKey === scope.conversationKey) &&
            (!scope.messagingServiceSid || event.messagingServiceSid === scope.messagingServiceSid),
        );
        const latest = matching[matching.length - 1];
        return { ok: true as const, state: (latest?.eventType ?? "none") as "none" | "granted" | "revoked" };
      },
      recordScopedSmsConsent: async (
        phone: string,
        scope: {
          managerUserId: string; purpose: string; sendClass: string; conversationKey?: string | null; messagingServiceSid?: string | null;
          eventType: "granted" | "revoked"; source: string; wordingVersion?: string | null; evidence?: Record<string, unknown>;
        },
      ) => {
        // The vendor consent reader also asks the table directly which SOURCE the grant came from.
        if (db) {
          (db.__tables.sms_consent_events ??= []).push({
            recipient_phone_key: key(phone),
            manager_user_id: scope.managerUserId,
            purpose: scope.purpose,
            conversation_key: scope.conversationKey ?? null,
            event_type: scope.eventType,
            source: scope.source,
            occurred_at: new Date(Date.UTC(2026, 9, 6, 12, 0, ++seq)).toISOString(),
          });
        }
        events.push({
          phoneKey: key(phone),
          managerUserId: scope.managerUserId,
          purpose: scope.purpose,
          sendClass: scope.sendClass,
          conversationKey: scope.conversationKey ?? null,
          messagingServiceSid: scope.messagingServiceSid ?? null,
          eventType: scope.eventType,
          source: scope.source,
          evidence: scope.evidence ?? {},
          wordingVersion: scope.wordingVersion ?? null,
        });
        return { ok: true as const };
      },
    },
  };
}
