import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  client: vi.fn(),
  serviceClient: vi.fn(),
}));

vi.mock("@/lib/twilio-client.server", () => ({ createTwilioRestClient: mocks.client }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: mocks.serviceClient }));
vi.mock("@/lib/sms-consent", () => ({ isPhoneOptedOut: vi.fn(async () => false) }));

import { sendSms } from "@/lib/twilio";
import { enqueueWebhookEvent } from "@/lib/webhooks/deliver.server";
import { runWithSmsTestTransport } from "@/lib/sms/sms-test-transport.server";

describe("low-level authenticated SMS test capture", () => {
  beforeEach(() => vi.clearAllMocks());

  it("captures raw Twilio before a client, consent query, or messages.create can run", async () => {
    const captured = await runWithSmsTestTransport(
      { actorUserId: "actor", managerUserId: "manager", sessionId: "session" },
      () => sendSms("not-a-number", "hello", "also-not-a-number"),
    );
    expect(captured.result).toEqual({ sent: true, sid: "in_app_test" });
    expect(captured.effects).toContainEqual(expect.objectContaining({ kind: "sms", status: "captured" }));
    expect(mocks.client).not.toHaveBeenCalled();
    expect(mocks.serviceClient).not.toHaveBeenCalled();
  });

  it("captures webhook emission before subscription lookup or retry-row creation", async () => {
    const captured = await runWithSmsTestTransport(
      { actorUserId: "actor", managerUserId: "manager", sessionId: "session" },
      () => enqueueWebhookEvent("manager", "work_order.created", { workOrderId: "work-order", status: "created" }),
    );
    expect(captured.result).toEqual({ queued: 0 });
    expect(captured.effects).toContainEqual(expect.objectContaining({ kind: "webhook", status: "captured" }));
    expect(mocks.serviceClient).not.toHaveBeenCalled();
  });
});
