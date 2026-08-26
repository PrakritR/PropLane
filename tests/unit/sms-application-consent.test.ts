import { describe, expect, it } from "vitest";
import {
  ensureApplicationScopedSmsConsent,
  revokeApplicationScopedSmsConsentOnWithdrawal,
} from "@/lib/sms/application-consent.server";
import { createMemoryDb } from "./support/memory-supabase";

const SCOPE = {
  managerUserId: "11111111-1111-4111-8111-111111111111",
  recipientPhone: "+12065552222",
  recipientEmail: "resident@example.com",
  recipientUserId: "22222222-2222-4222-8222-222222222222",
  purpose: "manager_conversation",
  sendClass: "transactional" as const,
  conversationKey: "11111111-1111-4111-8111-111111111111:resident:22222222-2222-4222-8222-222222222222",
  messagingServiceSid: "MG11111111111111111111111111111111",
};

function applicationRow(phone = "+12065552222") {
  return {
    id: "app-1",
    manager_user_id: SCOPE.managerUserId,
    resident_email: SCOPE.recipientEmail,
    row_data: {
      id: "app-1",
      application: {
        phone,
        smsConsent: true,
        smsConsentAt: "2026-07-28T12:00:00.000Z",
        smsConsentWordingVersion: "2026-07-28.1",
      },
    },
  };
}

describe("ensureApplicationScopedSmsConsent", () => {
  it("materializes a purpose-specific grant from server-owned application evidence", async () => {
    const db = createMemoryDb({
      sms_consent_events: [],
      manager_application_records: [applicationRow()],
      profiles: [],
    });

    await expect(ensureApplicationScopedSmsConsent(db as never, SCOPE)).resolves.toEqual({
      ok: true,
      granted: true,
    });
    expect(db.__tables.sms_consent_events).toEqual([
      expect.objectContaining({
        recipient_phone_key: "2065552222",
        manager_user_id: SCOPE.managerUserId,
        messaging_service_sid: SCOPE.messagingServiceSid,
        purpose: SCOPE.purpose,
        event_type: "granted",
        source: "rental_application",
        occurred_at: "2026-07-28T12:00:00.000Z",
      }),
    ]);
  });

  it("never overwrites a later revoke with historical application evidence", async () => {
    const revoked = {
      recipient_phone_key: "2065552222",
      manager_user_id: SCOPE.managerUserId,
      messaging_service_sid: SCOPE.messagingServiceSid,
      purpose: SCOPE.purpose,
      send_class: SCOPE.sendClass,
      conversation_key: SCOPE.conversationKey,
      event_type: "revoked",
      occurred_at: "2026-08-01T12:00:00.000Z",
      created_at: "2026-08-01T12:00:00.000Z",
    };
    const db = createMemoryDb({
      sms_consent_events: [revoked],
      manager_application_records: [applicationRow()],
    });

    await expect(ensureApplicationScopedSmsConsent(db as never, SCOPE)).resolves.toEqual({
      ok: true,
      granted: false,
    });
    expect(db.__tables.sms_consent_events).toHaveLength(1);
  });

  it("fails closed when the consented application phone does not match the recipient", async () => {
    const db = createMemoryDb({
      sms_consent_events: [],
      manager_application_records: [applicationRow("+12065553333")],
    });

    await expect(ensureApplicationScopedSmsConsent(db as never, SCOPE)).resolves.toEqual({
      ok: true,
      granted: false,
    });
    expect(db.__tables.sms_consent_events).toHaveLength(0);
  });
});

function consentEvent(overrides: Record<string, unknown> = {}) {
  return {
    recipient_phone_key: "2065552222",
    manager_user_id: SCOPE.managerUserId,
    messaging_service_sid: SCOPE.messagingServiceSid,
    campaign_sid: "CM11111111111111111111111111111111",
    purpose: SCOPE.purpose,
    send_class: SCOPE.sendClass,
    conversation_key: SCOPE.conversationKey,
    event_type: "granted",
    source: "rental_application",
    wording_version: "2026-07-28.1",
    evidence: { applicationId: "app-1" },
    occurred_at: "2026-07-28T12:00:00.000Z",
    created_at: "2026-07-28T12:00:00.000Z",
    ...overrides,
  };
}

const PREVIOUS_ROW = applicationRow().row_data;
const WITHDRAWN_ROW = {
  ...PREVIOUS_ROW,
  application: { ...PREVIOUS_ROW.application, smsConsent: false },
};

function withdrawnApplicationRecord() {
  return {
    ...applicationRow(),
    row_data: WITHDRAWN_ROW,
  };
}

describe("revokeApplicationScopedSmsConsentOnWithdrawal", () => {
  it("appends revokes for each currently granted application scope without widening manager, service, or conversation scope", async () => {
    const secondConversation = `${SCOPE.managerUserId}:applicant:app-1`;
    const db = createMemoryDb({
      manager_application_records: [withdrawnApplicationRecord()],
      sms_consent_events: [
        consentEvent(),
        consentEvent({
          messaging_service_sid: "MG22222222222222222222222222222222",
          campaign_sid: "CM22222222222222222222222222222222",
          purpose: "weekly_rent_reminder",
          send_class: "automated",
          conversation_key: secondConversation,
        }),
        consentEvent({ manager_user_id: "33333333-3333-4333-8333-333333333333" }),
        consentEvent({
          conversation_key: `${SCOPE.managerUserId}:resident:other`,
          evidence: { applicationId: "app-2" },
        }),
      ],
    });

    await expect(
      revokeApplicationScopedSmsConsentOnWithdrawal(db as never, {
        applicationId: "app-1",
        managerUserId: SCOPE.managerUserId,
        previousRow: PREVIOUS_ROW,
        nextRow: WITHDRAWN_ROW,
      }),
    ).resolves.toEqual({ ok: true, revokedScopes: 2 });

    const revokes = db.__tables.sms_consent_events.filter((row) => row.event_type === "revoked");
    expect(revokes).toEqual([
      expect.objectContaining({
        manager_user_id: SCOPE.managerUserId,
        messaging_service_sid: SCOPE.messagingServiceSid,
        campaign_sid: "CM11111111111111111111111111111111",
        purpose: SCOPE.purpose,
        conversation_key: SCOPE.conversationKey,
        source: "rental_application_withdrawal",
        evidence: { applicationId: "app-1" },
      }),
      expect.objectContaining({
        manager_user_id: SCOPE.managerUserId,
        messaging_service_sid: "MG22222222222222222222222222222222",
        campaign_sid: "CM22222222222222222222222222222222",
        purpose: "weekly_rent_reminder",
        conversation_key: secondConversation,
      }),
    ]);
  });

  it("does not duplicate a revoke or cancel a newer grant from another application", async () => {
    const db = createMemoryDb({
      manager_application_records: [withdrawnApplicationRecord()],
      sms_consent_events: [
        consentEvent(),
        consentEvent({
          event_type: "revoked",
          source: "rental_application_withdrawal",
          occurred_at: "2026-08-01T12:00:00.000Z",
          created_at: "2026-08-01T12:00:00.000Z",
        }),
        consentEvent({
          evidence: { applicationId: "app-2" },
          occurred_at: "2026-08-02T12:00:00.000Z",
          created_at: "2026-08-02T12:00:00.000Z",
        }),
      ],
    });

    await expect(
      revokeApplicationScopedSmsConsentOnWithdrawal(db as never, {
        applicationId: "app-1",
        managerUserId: SCOPE.managerUserId,
        previousRow: PREVIOUS_ROW,
        nextRow: WITHDRAWN_ROW,
      }),
    ).resolves.toEqual({ ok: true, revokedScopes: 0 });
    expect(db.__tables.sms_consent_events).toHaveLength(3);
  });

  it("does nothing unless stored consent transitions from true to explicit false", async () => {
    const db = createMemoryDb({ sms_consent_events: [consentEvent()] });

    await expect(
      revokeApplicationScopedSmsConsentOnWithdrawal(db as never, {
        applicationId: "app-1",
        managerUserId: SCOPE.managerUserId,
        previousRow: PREVIOUS_ROW,
        nextRow: {
          ...WITHDRAWN_ROW,
          application: { ...WITHDRAWN_ROW.application, smsConsent: undefined },
        },
      }),
    ).resolves.toEqual({ ok: true, revokedScopes: 0 });
    expect(db.__tables.sms_consent_events).toHaveLength(1);
  });

  it("does not revoke when a stale draft's false value was rejected by persistence", async () => {
    const db = createMemoryDb({
      manager_application_records: [applicationRow()],
      sms_consent_events: [consentEvent()],
    });

    await expect(
      revokeApplicationScopedSmsConsentOnWithdrawal(db as never, {
        applicationId: "app-1",
        managerUserId: SCOPE.managerUserId,
        previousRow: PREVIOUS_ROW,
        nextRow: WITHDRAWN_ROW,
      }),
    ).resolves.toEqual({ ok: true, revokedScopes: 0 });
    expect(db.__tables.sms_consent_events).toHaveLength(1);
  });
});
