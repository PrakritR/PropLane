import { beforeEach, describe, expect, it, vi } from "vitest";

const readSmsSuppressionState = vi.fn(async () => ({ ok: true as const, optedOut: false }));
const readScopedSmsConsentState = vi.fn(async () => ({ ok: true as const, state: "none" as const }));
const recordScopedSmsConsent = vi.fn(async () => ({ ok: true as const }));

vi.mock("@/lib/sms-consent", () => ({
  normalizeConsentPhone: (value: string) => {
    const digits = value.replace(/\D/g, "");
    return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  },
  readSmsSuppressionState: (...args: unknown[]) => readSmsSuppressionState(...(args as [])),
  readScopedSmsConsentState: (...args: unknown[]) => readScopedSmsConsentState(...(args as [])),
  recordScopedSmsConsent: (...args: unknown[]) => recordScopedSmsConsent(...(args as [])),
}));

import { resolveTourSmsEligibility } from "@/lib/sms/tour-sms-eligibility.server";

const managerUserId = "manager-1";
const phone = "+12065550100";
const service = "MGXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";

function makeDb(
  grant:
    | Record<string, unknown>
    | null
    | ((filters: Array<[string, string]>) => Record<string, unknown> | null) = null,
  error: { message: string } | null = null,
) {
  const filters: Array<[string, string]> = [];
  const db = {
    from: () => {
      const queryFilters: Array<[string, string]> = [];
      const chain = {
        select: () => chain,
        eq: (column: string, value: string) => {
          const filter: [string, string] = [column, value];
          filters.push(filter);
          queryFilters.push(filter);
          return chain;
        },
        order: () => chain,
        limit: async () => {
          const resolvedGrant = typeof grant === "function" ? grant(queryFilters) : grant;
          const scopeColumns = ["manager_user_id", "messaging_service_sid", "conversation_key"];
          const foreignScope = scopeColumns.some((column) => {
            const value = resolvedGrant?.[column];
            const filter = queryFilters.find(([name]) => name === column)?.[1];
            return value !== undefined && value !== filter;
          });
          return { data: resolvedGrant && !foreignScope ? [resolvedGrant] : [], error };
        },
      };
      return chain;
    },
  };
  return { db: db as never, filters };
}

describe("PRP-473 tour SMS eligibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.TWILIO_MESSAGING_SERVICE_SID = service;
    readSmsSuppressionState.mockResolvedValue({ ok: true, optedOut: false });
    readScopedSmsConsentState.mockResolvedValue({ ok: true, state: "none" });
    recordScopedSmsConsent.mockResolvedValue({ ok: true });
  });

  it("materializes a recipient-initiated manager-conversation grant with its original timestamp", async () => {
    const { db, filters } = makeDb({
      event_type: "granted",
      source: "recipient_initiated_inbound",
      occurred_at: "2026-09-10T07:41:15.000Z",
    });
    const result = await resolveTourSmsEligibility(db, {
      managerUserId,
      guestPhone: phone,
      explicitOptIn: false,
      purpose: "tour_rescheduled",
      inquiryId: "inquiry-1",
    });
    expect(result).toMatchObject({ eligible: true, provenance: "recipient_initiated_inbound" });
    expect(filters).toEqual(expect.arrayContaining([
      ["manager_user_id", managerUserId],
      ["messaging_service_sid", service],
      ["purpose", "manager_conversation"],
      ["send_class", "transactional"],
    ]));
    expect(recordScopedSmsConsent).toHaveBeenCalledWith(
      db,
      phone,
      expect.objectContaining({
        purpose: "tour_rescheduled",
        source: "recipient_initiated_inbound",
        occurredAt: "2026-09-10T07:41:15.000Z",
      }),
    );
  });

  it("uses the shared consent phone key for non-US E.164 evidence", async () => {
    const internationalPhone = "+442079460958";
    const { db, filters } = makeDb({
      event_type: "granted",
      source: "recipient_initiated_inbound",
      occurred_at: "2026-09-10T07:41:15.000Z",
    });
    const result = await resolveTourSmsEligibility(db, {
      managerUserId,
      guestPhone: internationalPhone,
      explicitOptIn: false,
      purpose: "tour_rescheduled",
    });
    expect(result).toMatchObject({ eligible: true, phoneE164: internationalPhone });
    expect(filters).toContainEqual(["recipient_phone_key", "442079460958"]);
  });

  it("does not materialize or send when the current tour purpose is revoked", async () => {
    readScopedSmsConsentState.mockResolvedValueOnce({ ok: true, state: "revoked" });
    const { db } = makeDb({
      event_type: "granted",
      source: "recipient_initiated_inbound",
      occurred_at: "2026-09-10T07:41:15.000Z",
    });
    const result = await resolveTourSmsEligibility(db, {
      managerUserId,
      guestPhone: phone,
      explicitOptIn: true,
      purpose: "tour_rescheduled",
    });
    expect(result).toEqual({ eligible: false, reason: "tour_sms_revoked" });
    expect(recordScopedSmsConsent).not.toHaveBeenCalled();
  });

  it("fails closed on an unreadable scoped conversation ledger", async () => {
    const { db } = makeDb(null, { message: "ledger unavailable" });
    const result = await resolveTourSmsEligibility(db, {
      managerUserId,
      guestPhone: phone,
      explicitOptIn: false,
      purpose: "tour_rescheduled",
    });
    expect(result).toEqual({ eligible: false, reason: "conversation_consent_unreadable" });
    expect(recordScopedSmsConsent).not.toHaveBeenCalled();
  });

  it("rejects malformed scope before touching consent state", async () => {
    delete process.env.TWILIO_MESSAGING_SERVICE_SID;
    const { db } = makeDb();
    const result = await resolveTourSmsEligibility(db, {
      managerUserId,
      guestPhone: "not-a-phone",
      explicitOptIn: true,
      purpose: "tour_rescheduled",
    });
    expect(result).toEqual({ eligible: false, reason: "invalid_sms_scope" });
    expect(readSmsSuppressionState).not.toHaveBeenCalled();
  });

  it("blocks a globally suppressed recipient before any conversation evidence is read", async () => {
    readSmsSuppressionState.mockResolvedValueOnce({ ok: true, optedOut: true });
    const { db } = makeDb({ event_type: "granted", source: "recipient_initiated_inbound" });
    await expect(resolveTourSmsEligibility(db, {
      managerUserId, guestPhone: phone, explicitOptIn: true, purpose: "tour_rescheduled",
    })).resolves.toEqual({ eligible: false, reason: "recipient_opted_out" });
    expect(readScopedSmsConsentState).not.toHaveBeenCalled();
    expect(recordScopedSmsConsent).not.toHaveBeenCalled();
  });

  it("cannot query or materialize conversation evidence when that evidence is disallowed", async () => {
    const { db } = makeDb({ event_type: "granted", source: "recipient_initiated_inbound" });
    const result = await resolveTourSmsEligibility(db, {
      managerUserId, guestPhone: phone, explicitOptIn: false, purpose: "tour_rescheduled",
      allowConversationEvidence: false,
    });
    expect(result).toEqual({ eligible: false, reason: "tour_sms_consent_missing" });
    expect(recordScopedSmsConsent).not.toHaveBeenCalled();
  });

  it("rejects an exact-purpose grant whose source is not trusted recipient initiation", async () => {
    readScopedSmsConsentState.mockResolvedValueOnce({ ok: true, state: "granted" });
    const { db } = makeDb({
      event_type: "granted", source: "resident_form_opt_in", occurred_at: "2026-09-10T07:41:15.000Z",
    });
    await expect(resolveTourSmsEligibility(db, {
      managerUserId, guestPhone: phone, explicitOptIn: false, purpose: "tour_rescheduled",
    })).resolves.toEqual({ eligible: false, reason: "tour_sms_consent_missing" });
    expect(recordScopedSmsConsent).not.toHaveBeenCalled();
  });

  it("rejects a derived tour grant after the source conversation is revoked", async () => {
    readScopedSmsConsentState.mockResolvedValueOnce({ ok: true, state: "granted" });
    const { db } = makeDb((filters) => {
      const purpose = filters.find(([column]) => column === "purpose")?.[1];
      return purpose === "tour_rescheduled"
        ? { event_type: "granted", source: "recipient_initiated_inbound", evidence: { conversationPurpose: "manager_conversation" } }
        : { event_type: "revoked", source: "twilio_stop" };
    });
    await expect(resolveTourSmsEligibility(db, {
      managerUserId,
      guestPhone: phone,
      explicitOptIn: false,
      purpose: "tour_rescheduled",
    })).resolves.toEqual({ eligible: false, reason: "tour_sms_consent_missing" });
    expect(recordScopedSmsConsent).not.toHaveBeenCalled();
  });

  it("rechecks a START-derived conversation grant after the source conversation is revoked", async () => {
    readScopedSmsConsentState.mockResolvedValueOnce({ ok: true, state: "granted" });
    const { db } = makeDb((filters) => {
      const purpose = filters.find(([column]) => column === "purpose")?.[1];
      return purpose === "tour_rescheduled"
        ? { event_type: "granted", source: "twilio_start", evidence: { conversationPurpose: "manager_conversation" } }
        : { event_type: "revoked", source: "twilio_stop" };
    });
    await expect(resolveTourSmsEligibility(db, {
      managerUserId, guestPhone: phone, explicitOptIn: false, purpose: "tour_rescheduled",
    })).resolves.toEqual({ eligible: false, reason: "tour_sms_consent_missing" });
  });

  it("does not mistake an independently restored purpose grant for derived conversation authority", async () => {
    readScopedSmsConsentState.mockResolvedValueOnce({ ok: true, state: "granted" });
    const { db, filters } = makeDb({ event_type: "granted", source: "twilio_start", evidence: {} });
    await expect(resolveTourSmsEligibility(db, {
      managerUserId, guestPhone: phone, explicitOptIn: false, purpose: "tour_rescheduled",
    })).resolves.toMatchObject({ eligible: true, provenance: "twilio_start" });
    expect(filters.filter(([, value]) => value === "manager_conversation")).toHaveLength(0);
  });

  it("requires the exact owner, service, prospect conversation, and role scope", async () => {
    for (const foreign of [
      { manager_user_id: "other-manager" },
      { messaging_service_sid: "MGOTHER" },
      { conversation_key: "manager-1:resident:+12065550100" },
    ]) {
      const { db, filters } = makeDb({
        event_type: "granted", source: "recipient_initiated_inbound", ...foreign,
      });
      const result = await resolveTourSmsEligibility(db, {
        managerUserId, guestPhone: phone, explicitOptIn: false, purpose: "tour_rescheduled",
      });
      expect(result).toEqual({ eligible: false, reason: "tour_sms_consent_missing" });
      expect(filters).toEqual(expect.arrayContaining([
        ["manager_user_id", managerUserId],
        ["messaging_service_sid", service],
        ["conversation_key", "manager-1:prospect:+12065550100"],
      ]));
    }
  });
});
