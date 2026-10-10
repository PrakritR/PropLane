import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_MANAGER_AUTOMATION_SETTINGS } from "@/lib/payment-automation-settings";

vi.mock("@/lib/payment-automation-settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/payment-automation-settings")>();
  return { ...actual, loadManagerAutomationSettings: vi.fn() };
});

vi.mock("@/lib/sms/manager-number-provisioning.server", () => ({
  resolveActiveManagerSendNumber: vi.fn(),
  resolveWorkspaceSendLine: vi.fn(),
}));

const sendPropLaneSms = vi.fn(async (_args: Record<string, unknown>) => ({
  ok: true, durablyAccepted: true, outboxStatus: "queued",
}));
vi.mock("@/lib/proplane-sms-transport.server", () => ({
  sendPropLaneSms: (args: Record<string, unknown>) => sendPropLaneSms(args),
}));

vi.mock("@/lib/sms-consent", () => ({
  isPhoneOptedOut: vi.fn().mockResolvedValue(false),
}));

import { loadManagerAutomationSettings } from "@/lib/payment-automation-settings";
import {
  resolveActiveManagerSendNumber,
  resolveWorkspaceSendLine,
} from "@/lib/sms/manager-number-provisioning.server";
import { isPhoneOptedOut } from "@/lib/sms-consent";
import {
  isManagerNotificationSmsAccepted,
  resolveManagerNotificationChannels,
  sendManagerNotificationSms,
} from "@/lib/manager-notification-routing.server";

const db = {} as SupabaseClient;
const profile = {
  phone: "+13175550123",
  phone_verified_at: "2026-09-01T00:00:00.000Z",
  sms_from_number: "+18559168031",
  sms_forward_inbound: true,
};

describe("resolveManagerNotificationChannels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadManagerAutomationSettings).mockResolvedValue(
      DEFAULT_MANAGER_AUTOMATION_SETTINGS,
    );
  });

  it("never texts an unverified personal phone", async () => {
    vi.mocked(loadManagerAutomationSettings).mockResolvedValue({
      ...DEFAULT_MANAGER_AUTOMATION_SETTINGS,
      managerNotificationDestination: "personal_number",
    });
    vi.mocked(resolveActiveManagerSendNumber).mockResolvedValue("+18559168031");

    await expect(
      resolveManagerNotificationChannels(db, "manager-1", "maintenance", {
        ...profile,
        phone_verified_at: null,
      }),
    ).resolves.toMatchObject({ inbox: true, sms: false, fellBackToAssistant: true });
  });

  it("uses Assistant by default", async () => {
    vi.mocked(resolveActiveManagerSendNumber).mockResolvedValue(null);

    await expect(
      resolveManagerNotificationChannels(db, "manager-1", "maintenance", profile),
    ).resolves.toMatchObject({ inbox: true, sms: false, fellBackToAssistant: false });
  });

  it("tolerates a numeric phone from a legacy profile without crashing an escalation", async () => {
    vi.mocked(resolveActiveManagerSendNumber).mockResolvedValue(null);
    await expect(resolveManagerNotificationChannels(db, "manager-1", "leasing", {
      ...profile, phone: 13175550123 as unknown as string,
    })).resolves.toMatchObject({ inbox: true, sms: false });
  });

  it("switches the default route to manager-cell SMS when the work number is active", async () => {
    vi.mocked(loadManagerAutomationSettings).mockResolvedValue({
      ...DEFAULT_MANAGER_AUTOMATION_SETTINGS,
      managerNotificationDestination: "personal_number",
    });
    vi.mocked(resolveActiveManagerSendNumber).mockResolvedValue("+18559168031");

    await expect(
      resolveManagerNotificationChannels(db, "manager-1", "maintenance", profile),
    ).resolves.toMatchObject({ inbox: false, sms: true, fellBackToAssistant: false });
  });

  it("keeps Assistant when the selected topic is not enabled for texting", async () => {
    vi.mocked(loadManagerAutomationSettings).mockResolvedValue({
      ...DEFAULT_MANAGER_AUTOMATION_SETTINGS,
      managerNotificationDestination: "personal_number",
      managerNotificationCategories: {
        ...DEFAULT_MANAGER_AUTOMATION_SETTINGS.managerNotificationCategories,
        maintenance: false,
      },
    });
    vi.mocked(resolveActiveManagerSendNumber).mockResolvedValue("+18559168031");

    await expect(
      resolveManagerNotificationChannels(db, "manager-1", "maintenance", profile),
    ).resolves.toMatchObject({ inbox: true, sms: false, fellBackToAssistant: true });
  });

  it("returns no proactive channels when no updates is selected", async () => {
    vi.mocked(loadManagerAutomationSettings).mockResolvedValue({
      ...DEFAULT_MANAGER_AUTOMATION_SETTINGS,
      managerNotificationDestination: "none",
    });

    await expect(
      resolveManagerNotificationChannels(db, "manager-1", "leasing", profile),
    ).resolves.toMatchObject({ inbox: false, sms: false, fellBackToAssistant: false });
    expect(resolveActiveManagerSendNumber).not.toHaveBeenCalled();
  });
});

describe("isManagerNotificationSmsAccepted", () => {
  it("treats a durable queued handoff as accepted", () => {
    expect(isManagerNotificationSmsAccepted({ ok: false, durablyAccepted: true, outboxStatus: "queued" })).toBe(true);
  });

  it("never accepts an unknown or terminal failed outbox state", () => {
    expect(isManagerNotificationSmsAccepted({ ok: true, durablyAccepted: true, outboxStatus: "unknown" })).toBe(false);
    expect(isManagerNotificationSmsAccepted({ ok: true, durablyAccepted: true, outboxStatus: "failed" })).toBe(false);
  });
});

describe("a notice texted from the workspace OWNER's line", () => {
  const OWNER = "owner-1";
  const MATE = "mate-1";
  const profileDb = (row: Record<string, unknown>) =>
    ({
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }) }),
    }) as unknown as SupabaseClient;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isPhoneOptedOut).mockResolvedValue(false);
    vi.mocked(loadManagerAutomationSettings).mockResolvedValue(DEFAULT_MANAGER_AUTOMATION_SETTINGS);
    vi.mocked(resolveActiveManagerSendNumber).mockResolvedValue("+15005550001");
    vi.mocked(resolveWorkspaceSendLine).mockResolvedValue({ phoneNumber: "+15005550001", numberId: "line-1" });
  });

  it("asks about the OWNER's workspace line, not the teammate's, and reports the destination and topic for the email leg", async () => {
    const channels = await resolveManagerNotificationChannels(
      db, MATE, "payment_reminders", profile, undefined, undefined, { ownerUserId: OWNER, workspaceId: "ws-1" },
    );
    expect(resolveActiveManagerSendNumber).toHaveBeenCalledWith(db, OWNER, "ws-1");
    expect(channels).toMatchObject({ sms: true, email: true, destination: "both", categoryEnabled: true });
  });

  it("a teammate's text: PropLane: prefix, the owner's pinned line, billed to the owner, consent read for the teammate", async () => {
    const result = await sendManagerNotificationSms(
      profileDb({ ...profile }),
      {
        managerUserId: MATE, category: "payment_reminders", subject: "Rent · Payment update",
        text: "$1,000.00 was received", purpose: "manager_agent_notification_payment_reminders",
        dedupeKey: "notice:k:mate-1", sendFrom: { ownerUserId: OWNER, workspaceId: "ws-1" },
      },
    );
    expect(result).toEqual({ sent: true });
    const sent = sendPropLaneSms.mock.calls[0]![0] as Record<string, unknown> & { log: Record<string, unknown> };
    expect(String(sent.text)).toMatch(/^PropLane: /);
    expect(sent).toMatchObject({
      to: profile.phone,
      selectedWorkLineId: "line-1",
      actorUserId: MATE,
      recipientUserId: MATE,
      purpose: "manager_agent_notification_payment_reminders",
      dedupeKey: "notice:k:mate-1",
    });
    expect(sent.log.managerUserId).toBe(OWNER); // the owner's wallet, never the teammate's
    expect(resolveWorkspaceSendLine).toHaveBeenCalledWith(expect.anything(), OWNER, "ws-1");
  });

  it("an unverified, STOPped or forwarding-off phone gets no text", async () => {
    const send = (row: Record<string, unknown>) =>
      sendManagerNotificationSms(profileDb(row), {
        managerUserId: MATE, category: "payment_reminders", subject: "s", text: "t",
        purpose: "manager_agent_notification_payment_reminders", sendFrom: { ownerUserId: OWNER, workspaceId: "ws-1" },
      });
    expect(await send({ ...profile, phone_verified_at: null })).toEqual({ sent: false });
    expect(await send({ ...profile, sms_forward_inbound: false })).toEqual({ sent: false });
    vi.mocked(isPhoneOptedOut).mockResolvedValue(true);
    expect(await send({ ...profile })).toEqual({ sent: false });
    expect(sendPropLaneSms).not.toHaveBeenCalled();
  });

  it("no sendable workspace line, no text", async () => {
    vi.mocked(resolveActiveManagerSendNumber).mockResolvedValue(null);
    vi.mocked(resolveWorkspaceSendLine).mockResolvedValue(null);
    const result = await sendManagerNotificationSms(profileDb({ ...profile }), {
      managerUserId: MATE, category: "payment_reminders", subject: "s", text: "t",
      purpose: "manager_agent_notification_payment_reminders", sendFrom: { ownerUserId: OWNER, workspaceId: "ws-1" },
    });
    expect(result).toEqual({ sent: false });
    expect(sendPropLaneSms).not.toHaveBeenCalled();
  });

  it("a caller with no sendFrom is unchanged: own line, own wallet, no prefix, no pin", async () => {
    await sendManagerNotificationSms(profileDb({ ...profile }), {
      managerUserId: OWNER, category: "payment_reminders", subject: "Subject", text: "Body",
      purpose: "manager_agent_notification_payment_reminders",
    });
    const sent = sendPropLaneSms.mock.calls[0]![0] as Record<string, unknown> & { log: Record<string, unknown> };
    expect(sent.text).toBe("Subject\nBody");
    expect(sent.selectedWorkLineId).toBeUndefined();
    expect(sent.actorUserId).toBeUndefined();
    expect(sent.log.managerUserId).toBe(OWNER);
  });
});
