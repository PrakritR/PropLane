import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const mocks = vi.hoisted(() => ({ config: vi.fn(), optedOut: vi.fn(), shield: vi.fn(), create: vi.fn() }));
vi.mock("@/lib/one-number/config.server", () => ({ loadSharedLineConfig: mocks.config }));
vi.mock("@/lib/sms-consent", () => ({ isPhoneOptedOut: mocks.optedOut }));
vi.mock("@/lib/protected-accounts.server", () => ({ isShieldedRecipient: mocks.shield }));
vi.mock("@/lib/twilio-client.server", () => ({ createTwilioRestClient: () => ({ messages: { create: mocks.create } }) }));
import { sendPlatformLeadText } from "@/lib/one-number/lead-send.server";

const db = {} as SupabaseClient;
const message = { to: "+12065550123", body: "Your requested demo link", now: new Date("2026-10-19T08:00:00Z") };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.config.mockResolvedValue({ mode: "shared", sharedNumber: "+12065550100", messagingServiceSid: null });
  mocks.optedOut.mockResolvedValue(false);
  mocks.shield.mockResolvedValue(false);
  mocks.create.mockResolvedValue({ sid: "SMrequested" });
});

describe("requested informational platform message", () => {
  it("keeps scheduled nudges quiet overnight by default", async () => {
    expect(await sendPlatformLeadText(db, message)).toEqual({ ok: false, reason: "quiet_hours" });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("answers an expressly requested demo link at night", async () => {
    expect(await sendPlatformLeadText(db, { ...message, purpose: "requested_demo_link" })).toEqual({ ok: true, sid: "SMrequested" });
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.create.mock.calls[0][0]).toMatchObject({ to: message.to, from: "+12065550100" });
  });

  it("still refuses a stopped number", async () => {
    mocks.optedOut.mockResolvedValue(true);
    expect(await sendPlatformLeadText(db, { ...message, purpose: "requested_demo_link" })).toEqual({ ok: false, reason: "opted_out" });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("still shields real recipients outside production", async () => {
    mocks.shield.mockResolvedValue(true);
    expect(await sendPlatformLeadText(db, { ...message, purpose: "requested_demo_link" })).toEqual({ ok: false, reason: "shielded" });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it.each([
    [new Error("socket timed out"), "delivery_unknown"],
    [{ status: 503 }, "delivery_unknown"],
    [{ status: 400 }, "provider_error"],
  ])("does not retry or misstate a provider outcome %#", async (error, reason) => {
    mocks.create.mockRejectedValue(error);
    expect(await sendPlatformLeadText(db, { ...message, purpose: "requested_demo_link" })).toEqual({ ok: false, reason });
    expect(mocks.create).toHaveBeenCalledOnce();
  });
});
