import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const mocks = vi.hoisted(() => ({ config: vi.fn(), sendSms: vi.fn() }));
vi.mock("@/lib/one-number/config.server", () => ({ loadSharedLineConfig: mocks.config }));
vi.mock("@/lib/twilio", () => ({ sendSms: mocks.sendSms }));
import { sendPlatformLeadText } from "@/lib/one-number/lead-send.server";

const db = {} as SupabaseClient;
const message = { to: "+12065550123", body: "Your requested demo link", now: new Date("2026-10-19T08:00:00Z") };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.config.mockResolvedValue({ mode: "shared", sharedNumber: "+12065550100", messagingServiceSid: null });
  mocks.sendSms.mockResolvedValue({ sent: true, sid: "SMrequested", providerAttempted: true });
});

describe("requested informational platform message", () => {
  it("keeps scheduled nudges quiet overnight by default", async () => {
    expect(await sendPlatformLeadText(db, message)).toEqual({ ok: false, reason: "quiet_hours" });
    expect(mocks.sendSms).not.toHaveBeenCalled();
  });

  it("answers an expressly requested demo link at night", async () => {
    expect(await sendPlatformLeadText(db, { ...message, purpose: "requested_demo_link" })).toEqual({ ok: true, sid: "SMrequested" });
    expect(mocks.sendSms).toHaveBeenCalledOnce();
    expect(mocks.sendSms).toHaveBeenCalledWith(message.to, message.body, "+12065550100", { purpose: "platform_lead", messagingServiceSid: null });
  });

  it("still refuses a stopped number", async () => {
    mocks.sendSms.mockResolvedValue({ sent: false, error: "recipient_opted_out", providerAttempted: false });
    expect(await sendPlatformLeadText(db, { ...message, purpose: "requested_demo_link" })).toEqual({ ok: false, reason: "opted_out" });
    expect(mocks.sendSms).toHaveBeenCalledOnce();
  });

  it("still shields real recipients outside production", async () => {
    mocks.sendSms.mockResolvedValue({ sent: false, error: "protected_account_shielded", providerAttempted: false });
    expect(await sendPlatformLeadText(db, { ...message, purpose: "requested_demo_link" })).toEqual({ ok: false, reason: "shielded" });
    expect(mocks.sendSms).toHaveBeenCalledOnce();
  });

  it.each([
    [{ sent: false, providerAttempted: true, error: "socket timed out" }, "delivery_unknown"],
    [{ sent: false, providerAttempted: true, error: "Service unavailable" }, "delivery_unknown"],
    [{ sent: false, providerAttempted: true, error: "Bad Request" }, "delivery_unknown"],
    [{ sent: false, providerAttempted: false, error: "not configured" }, "provider_error"],
    [{ sent: true, providerAttempted: true }, "delivery_unknown"],
  ])("does not retry or misstate a consolidated transport outcome %#", async (result, reason) => {
    mocks.sendSms.mockResolvedValue(result);
    expect(await sendPlatformLeadText(db, { ...message, purpose: "requested_demo_link" })).toEqual({ ok: false, reason });
    expect(mocks.sendSms).toHaveBeenCalledOnce();
  });
});
