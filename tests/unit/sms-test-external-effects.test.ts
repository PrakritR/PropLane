import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  twilioSend: vi.fn(),
  clawSend: vi.fn(),
  resolveChannels: vi.fn(),
  managerSms: vi.fn(),
  serviceClient: vi.fn(),
  googleCreate: vi.fn(),
  googleUpdate: vi.fn(),
}));

vi.mock("@/lib/twilio", () => ({
  normalizeE164: (value: string) => value,
  sendSms: mocks.twilioSend,
}));
vi.mock("@/lib/claw-messenger.server", () => ({
  isClawMessengerConfigured: () => false,
  normalizeE164Us: (value: string) => value,
  registerClawMessengerRoute: vi.fn(),
  sendClawMessengerText: mocks.clawSend,
}));
vi.mock("@/lib/claw-leasing-links", () => ({
  clawLeasingAgentPhoneE164: () => null,
  isClawSharedLineBridgeEnabled: () => false,
  managerContactSmsPhoneForPublicCta: () => null,
}));
vi.mock("@/lib/sms-consent", () => ({
  isPhoneOptedOut: vi.fn(async () => false),
  readSmsSuppressionState: vi.fn(),
  readScopedSmsConsentState: vi.fn(),
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: mocks.serviceClient,
}));
vi.mock("@/lib/manager-notification-routing.server", () => ({
  resolveManagerNotificationChannels: mocks.resolveChannels,
  sendManagerNotificationSms: mocks.managerSms,
}));
vi.mock("@/lib/google-calendar/api.server", () => ({
  createGoogleCalendarEvent: mocks.googleCreate,
  updateGoogleCalendarEvent: mocks.googleUpdate,
  deleteGoogleCalendarEvent: vi.fn(),
}));
vi.mock("@/lib/google-calendar/settings", () => ({
  loadGoogleCalendarConnection: vi.fn(() => {
    throw new Error("test calendar sync must not load a connection");
  }),
}));

import { notifyManagerFromAgent } from "@/lib/agent-notify.server";
import { syncPlannedTourToGoogleCalendar } from "@/lib/google-calendar/sync.server";
import { sendPortalConversationEmails } from "@/lib/portal-email-send.server";
import { sendPropLaneSms } from "@/lib/proplane-sms-transport.server";
import { sendPushToUser } from "@/lib/push-notifications.server";
import { enqueueOwnerSms } from "@/lib/sms/owner-sms-dispatcher.server";
import { registerProspectTourReminder } from "@/lib/sms/prospect-tour-reminder.server";
import { runWithSmsTestTransport } from "@/lib/sms/sms-test-transport.server";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.serviceClient.mockImplementation(() => {
    throw new Error("test delivery must not create a service client");
  });
});

describe("SMS test external-effect choke points", () => {
  it("captures direct SMS, queued SMS, manager notice, push, and email without invoking providers or persistence", async () => {
    const db = {
      from: vi.fn(() => {
        throw new Error("test delivery must not write notification rows");
      }),
      rpc: vi.fn(() => {
        throw new Error("test delivery must not call outbox RPCs");
      }),
    };

    const captured = await runWithSmsTestTransport(
      { actorUserId: "actor-1", managerUserId: "manager-1", sessionId: "session-1" },
      async () => {
        const directSms = await sendPropLaneSms({
          to: "",
          text: "Captured direct reply",
          purpose: "manager_conversation",
        });
        const queuedSms = await enqueueOwnerSms({
          managerUserId: "manager-1",
          actorUserId: "actor-1",
          recipientPhone: "",
          body: "Captured queued reply",
          sendClass: "automated",
          purpose: "prospect_tour_followup",
        }, db as never);
        const notice = await notifyManagerFromAgent(db as never, {
          landlordId: "manager-1",
          subject: "Tour requested",
          text: "A prospect requested a tour.",
          category: "leasing",
          notify: { push: true, sms: true },
        });
        const push = await sendPushToUser("manager-1", {
          title: "Tour requested",
          body: "Open PropLane",
        });
        const email = await sendPortalConversationEmails({
          senderUserId: "actor-1",
          toEmails: ["manager@example.com"],
          subject: "Tour requested",
          text: "Text",
          html: "<p>Text</p>",
        });
        const reminder = await registerProspectTourReminder(db as never, {
          burstId: "burst-1",
          burstRevision: 3,
          managerUserId: "manager-1",
          recipientPhoneE164: "",
          candidateContext: [],
          replyBody: "Which time works?",
        });
        const calendar = await syncPlannedTourToGoogleCalendar(db as never, "manager-1", {
          plannedEventId: "tour-1",
          title: "Tour",
          start: "2026-09-20T17:00:00.000Z",
          end: "2026-09-20T17:30:00.000Z",
        });
        return { directSms, queuedSms, notice, push, email, reminder, calendar };
      },
    );

    expect(captured.result.directSms).toMatchObject({
      ok: true,
      channel: "in_app_test",
      outboxStatus: "captured",
    });
    expect(captured.result.queuedSms).toMatchObject({ ok: true, status: "captured" });
    expect(captured.result.notice).toEqual({ delivered: true, suppressed: false });
    expect(captured.result.push).toEqual({ sent: 1 });
    expect(captured.result.email.get("manager@example.com")).toEqual({
      sent: true,
      resendId: "in_app_test",
    });
    expect(captured.result.reminder).toEqual({ registered: true });
    expect(captured.result.calendar).toBeNull();
    expect(captured.effects.map((effect) => effect.kind)).toEqual([
      "sms",
      "sms",
      "manager_notification",
      "push",
      "email",
      "reminder",
      "calendar",
    ]);
    expect(captured.effects.every((effect) => effect.status === "captured")).toBe(true);
    expect(mocks.twilioSend).not.toHaveBeenCalled();
    expect(mocks.clawSend).not.toHaveBeenCalled();
    expect(mocks.resolveChannels).not.toHaveBeenCalled();
    expect(mocks.managerSms).not.toHaveBeenCalled();
    expect(mocks.googleCreate).not.toHaveBeenCalled();
    expect(mocks.googleUpdate).not.toHaveBeenCalled();
    expect(db.from).not.toHaveBeenCalled();
    expect(db.rpc).not.toHaveBeenCalled();
  });
});
