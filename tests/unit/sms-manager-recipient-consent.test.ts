/**
 * Consent for a text to a MANAGER on the workspace (the owner or a teammate):
 * Assistant notices, Team chat relays and team notices take their consent from
 * the recipient's own verified work phone (`ensureTeamNoticeScopedSmsConsent`),
 * never from a rental application they never filed; everything else is
 * unchanged.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveLine: vi.fn(),
  billing: vi.fn(),
  suppression: vi.fn(),
  applicationConsent: vi.fn(),
  teamConsent: vi.fn(),
}));

vi.mock("@/lib/sms/manager-workspace-role.server", () => ({ resolveOwnerSendNumberRow: mocks.resolveLine }));
vi.mock("@/lib/comms-billing/eligibility.server", () => ({ evaluateManagerCommsBillingGate: mocks.billing }));
vi.mock("@/lib/sms-consent", () => ({
  readSmsSuppressionState: mocks.suppression,
  readScopedSmsConsentState: vi.fn(),
}));
vi.mock("@/lib/sms/application-consent.server", () => ({ ensureApplicationScopedSmsConsent: mocks.applicationConsent }));
vi.mock("@/lib/sms/team-notice-consent.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sms/team-notice-consent.server")>();
  return { ...actual, ensureTeamNoticeScopedSmsConsent: mocks.teamConsent };
});
vi.mock("@/lib/sms/number-registration-policy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sms/number-registration-policy")>();
  return { ...actual, evaluateManagerSmsNumberSendability: vi.fn(() => ({ sendable: true })), quietHoursBlocks: vi.fn(() => false) };
});

import { enqueueOwnerSms } from "@/lib/sms/owner-sms-dispatcher.server";
import { isManagerRecipientSmsPurpose } from "@/lib/sms/team-notice-consent.server";

function db() {
  const inserted: Array<Record<string, unknown>> = [];
  const from = (table: string) => {
    const q = {
      select() { return q; },
      eq() { return q; },
      maybeSingle: async () => ({ data: table === "sms_runtime_config" ? { mode: "enabled", pilot_manager_user_ids: ["owner-1"] } : null, error: null }),
      insert(payload: Record<string, unknown>) {
        inserted.push(payload);
        return { select: () => ({ single: async () => ({ data: { id: "outbox-1", status: String(payload.status) }, error: null }) }) };
      },
    };
    return q;
  };
  return { db: { from } as never, inserted };
}

const input = (purpose: string) => ({
  managerUserId: "owner-1",
  actorUserId: "mate-1",
  recipientUserId: "mate-1",
  selectedWorkLineId: "line-1",
  recipientPhone: "+12065550101",
  body: "PropLane: $1,000.00 was received",
  sendClass: "transactional" as const,
  purpose,
  counterpartyRole: "manager" as const,
});

beforeEach(() => {
  process.env.SMS_RUNTIME_ENABLED = "1";
  process.env.SMS_OUTBOX_SCHEDULER_READY = "1";
  process.env.TWILIO_MESSAGING_SERVICE_SID = "MG1";
  process.env.TWILIO_CAMPAIGN_SID = "CP1";
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.resolveLine.mockResolvedValue({
    data: {
      manager_user_id: "owner-1", workspace_id: "ws-1", phone_number: "+15005550001", phone_number_sid: "PN1",
      messaging_service_sid: "MG1", campaign_sid: "CP1", provision_state: "active", registration_state: "registered",
    },
    error: null,
  });
  mocks.billing.mockResolvedValue({ allowed: true });
  mocks.suppression.mockResolvedValue({ ok: true, optedOut: false });
  mocks.teamConsent.mockResolvedValue({ ok: true, granted: true });
  mocks.applicationConsent.mockResolvedValue({ ok: true, granted: false });
});

describe("which purposes are manager-recipient texts", () => {
  it("notices, relays and team notices; nothing else", () => {
    expect(isManagerRecipientSmsPurpose("manager_agent_notification_payment_reminders")).toBe(true);
    expect(isManagerRecipientSmsPurpose("manager_agent_notification_messages")).toBe(true);
    expect(isManagerRecipientSmsPurpose("team_chat_relay")).toBe(true);
    expect(isManagerRecipientSmsPurpose("team_notice")).toBe(true);
    expect(isManagerRecipientSmsPurpose("team_inbound_forward")).toBe(true);
    for (const other of ["manager_conversation", "prospect_tour_followup", "legacy_automated_message", "", null, undefined]) {
      expect(isManagerRecipientSmsPurpose(other as string)).toBe(false);
    }
  });
});

describe("the dispatcher's consent check for a manager recipient", () => {
  it.each(["manager_agent_notification_payment_reminders", "team_chat_relay", "team_notice"])(
    "%s reads the recipient's verified-phone consent, billed to the owner, pinned to the workspace line",
    async (purpose) => {
      const fixture = db();
      const result = await enqueueOwnerSms(input(purpose), fixture.db);
      expect(result).toMatchObject({ ok: true, status: "queued" });
      expect(mocks.teamConsent).toHaveBeenCalledTimes(1);
      expect(mocks.teamConsent.mock.calls[0]![1]).toMatchObject({
        managerUserId: "owner-1", recipientUserId: "mate-1", purpose, sendClass: "transactional",
      });
      expect(mocks.applicationConsent).not.toHaveBeenCalled();
      expect(fixture.inserted[0]).toMatchObject({
        manager_user_id: "owner-1", actor_user_id: "mate-1", recipient_user_id: "mate-1",
        selected_work_line_id: "line-1", purpose, counterparty_role: "manager",
      });
    },
  );

  it("an unverified, mismatched or STOPped recipient (consent not granted) is refused, not queued", async () => {
    mocks.teamConsent.mockResolvedValue({ ok: true, granted: false });
    const fixture = db();
    const result = await enqueueOwnerSms(input("manager_agent_notification_messages"), fixture.db);
    expect(result).toMatchObject({ ok: false });
    expect(fixture.inserted).toHaveLength(0);
  });

  it("an unreadable consent ledger fails closed: held (deferred and re-checked at dispatch), never queued to send", async () => {
    mocks.teamConsent.mockResolvedValue({ ok: false, error: "team_consent_unreadable" });
    const result = await enqueueOwnerSms(input("team_chat_relay"), db().db);
    expect(result).toMatchObject({ ok: true, status: "deferred" });
  });

  it("a number STOP at the suppression ledger refuses the text before consent is even read", async () => {
    mocks.suppression.mockResolvedValue({ ok: true, optedOut: true });
    const fixture = db();
    expect(await enqueueOwnerSms(input("team_chat_relay"), fixture.db)).toMatchObject({ ok: false });
    expect(mocks.teamConsent).not.toHaveBeenCalled();
    expect(fixture.inserted).toHaveLength(0);
  });

  it("no credit on the owner's workspace wallet: no text", async () => {
    mocks.billing.mockResolvedValue({ allowed: false, reason: "allowance_exhausted" });
    const result = await enqueueOwnerSms(input("manager_agent_notification_messages"), db().db);
    expect(result).toMatchObject({ ok: false });
  });

  it("any other purpose still takes the application-consent path", async () => {
    await enqueueOwnerSms(input("manager_conversation"), db().db);
    expect(mocks.applicationConsent).toHaveBeenCalledTimes(1);
    expect(mocks.teamConsent).not.toHaveBeenCalled();
  });
});
