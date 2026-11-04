// Platform lead texts ride the one provider call (sendSms) from the shared number, behind quiet hours.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  config: { mode: "shared", sharedNumber: "+12065550100", messagingServiceSid: "MGSHARED", pilotWorkspaceIds: [] } as Record<string, unknown>,
  configReadable: true,
  sendSms: vi.fn(),
  suppression: vi.fn(),
  create: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/one-number/config.server", () => ({
  loadSharedLineConfig: async () => mocks.config,
  loadSharedLineConfigStrict: async () => mocks.configReadable ? { ok: true, config: mocks.config } : { ok: false },
}));
vi.mock("@/lib/sms-consent", () => ({ readSmsSuppressionState: mocks.suppression }));
vi.mock("@/lib/twilio", () => ({ sendSms: mocks.sendSms }));
vi.mock("@/lib/twilio-client.server", () => ({ createTwilioRestClient: () => ({ messages: { create: mocks.create } }) }));

import { sendPlatformLeadText } from "@/lib/one-number/lead-send.server";

// 1pm Pacific on a Sunday; 3am Pacific the next day.
const DAY = new Date("2026-10-18T20:00:00Z");
const NIGHT = new Date("2026-10-19T10:00:00Z");
const db = {} as never;

describe("sendPlatformLeadText", () => {
  beforeEach(() => {
    mocks.config = { mode: "shared", sharedNumber: "+12065550100", messagingServiceSid: "MGSHARED", pilotWorkspaceIds: [] };
    mocks.configReadable = true;
    mocks.suppression.mockReset();
    mocks.sendSms.mockReset().mockResolvedValue({ sent: true, sid: "SM1", providerAttempted: true });
    mocks.create.mockReset();
    mocks.suppression.mockResolvedValue({ ok: true, optedOut: false });
  });

  it("sends through sendSms from the shared number on the shared Messaging Service, never a direct provider call", async () => {
    const result = await sendPlatformLeadText(db, { to: "(206) 555-0142", body: "Hi", now: DAY });
    expect(result).toEqual({ ok: true, sid: "SM1" });
    expect(mocks.sendSms).toHaveBeenCalledWith("+12065550142", "Hi", "+12065550100", {
      purpose: "platform_lead",
      messagingServiceSid: "MGSHARED",
    });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("passes at most one photo as media", async () => {
    await sendPlatformLeadText(db, { to: "+12065550142", body: "Hi", mediaUrls: ["https://a/1.jpg", "https://a/2.jpg"], now: DAY });
    expect(mocks.sendSms.mock.calls[0][3]).toMatchObject({ mediaUrls: ["https://a/1.jpg"] });
  });

  it("refuses outside shared mode, with no number, a bad phone, or in quiet hours, and never sends", async () => {
    mocks.config = { ...mocks.config, mode: "per_workspace" };
    expect(await sendPlatformLeadText(db, { to: "+12065550142", body: "Hi", now: DAY })).toEqual({ ok: false, reason: "not_shared_mode" });
    mocks.config = { ...mocks.config, mode: "shared", sharedNumber: null };
    expect(await sendPlatformLeadText(db, { to: "+12065550142", body: "Hi", now: DAY })).toEqual({ ok: false, reason: "no_shared_number" });
    mocks.config = { ...mocks.config, sharedNumber: "+12065550100" };
    expect(await sendPlatformLeadText(db, { to: "nope", body: "Hi", now: DAY })).toEqual({ ok: false, reason: "invalid_to" });
    expect(await sendPlatformLeadText(db, { to: "+12065550142", body: "Hi", now: NIGHT })).toEqual({ ok: false, reason: "quiet_hours" });
    expect(mocks.sendSms).not.toHaveBeenCalled();
  });

  it("maps the gate refusals sendSms owns onto the result reasons", async () => {
    mocks.sendSms.mockResolvedValueOnce({ sent: false, error: "recipient_opted_out" });
    expect(await sendPlatformLeadText(db, { to: "+12065550142", body: "Hi", now: DAY })).toEqual({ ok: false, reason: "opted_out" });
    mocks.sendSms.mockResolvedValueOnce({ sent: false, error: "protected_account_shielded" });
    expect(await sendPlatformLeadText(db, { to: "+12065550142", body: "Hi", now: DAY })).toEqual({ ok: false, reason: "shielded" });
    mocks.sendSms.mockResolvedValueOnce({ sent: false, error: "boom" });
    expect(await sendPlatformLeadText(db, { to: "+12065550142", body: "Hi", now: DAY })).toEqual({ ok: false, reason: "provider_error" });
    mocks.sendSms.mockRejectedValueOnce(new Error("down"));
    expect(await sendPlatformLeadText(db, { to: "+12065550142", body: "Hi", now: DAY })).toEqual({ ok: false, reason: "delivery_unknown" });
  });

  it("preserves requested transactional delivery through the consolidated transport at night", async () => {
    expect(await sendPlatformLeadText(db, {
      to: "+12065550142", body: "Requested link", now: NIGHT, purpose: "requested_demo_link",
    })).toEqual({ ok: true, sid: "SM1" });
    expect(mocks.sendSms).toHaveBeenCalledOnce();
    expect(mocks.sendSms.mock.calls[0][3]).toMatchObject({ purpose: "platform_lead" });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("reports provider attempts with no confirmed SID as uncertain and never retries", async () => {
    mocks.sendSms.mockResolvedValue({ sent: false, providerAttempted: true, error: "Timed out" });
    expect(await sendPlatformLeadText(db, { to: "+12065550142", body: "Hi", now: DAY }))
      .toEqual({ ok: false, reason: "delivery_unknown" });
    expect(mocks.sendSms).toHaveBeenCalledOnce();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("answers an inbound message overnight without changing the automated default", async () => {
    expect(await sendPlatformLeadText(db, { to: "+12065550142", body: "Hello", now: NIGHT, inboundReply: true }))
      .toEqual({ ok: true, sid: "SM1" });
    expect(mocks.sendSms).toHaveBeenCalledOnce();
    expect(await sendPlatformLeadText(db, { to: "+12065550142", body: "Nudge", now: NIGHT }))
      .toEqual({ ok: false, reason: "quiet_hours" });
    expect(mocks.sendSms).toHaveBeenCalledOnce();
  });

  it("fails closed on unreadable suppression and honors STOP after preparation", async () => {
    const input = { to: "+12065550142", body: "Prepared", now: DAY, inboundReply: true, expectedFrom: "+12065550100" };
    mocks.suppression.mockResolvedValueOnce({ ok: false });
    expect(await sendPlatformLeadText(db, input)).toEqual({ ok: false, reason: "provider_error" });
    mocks.suppression.mockResolvedValueOnce({ ok: true, optedOut: true });
    expect(await sendPlatformLeadText(db, input)).toEqual({ ok: false, reason: "opted_out" });
    expect(mocks.sendSms).not.toHaveBeenCalled();
  });
  it("retries an unreadable pinned configuration with the original prepared bytes", async () => {
    const input = { to: "+12065550142", body: "Prepared\nexactly", mediaUrls: ["https://a/1.jpg"], now: DAY, inboundReply: true, expectedFrom: "+12065550100" };
    mocks.configReadable = false;
    expect(await sendPlatformLeadText(db, input)).toEqual({ ok: false, reason: "config_unavailable" });
    expect(mocks.suppression).not.toHaveBeenCalled();
    expect(mocks.sendSms).not.toHaveBeenCalled();
    mocks.configReadable = true;
    expect(await sendPlatformLeadText(db, input)).toEqual({ ok: true, sid: "SM1" });
    expect(mocks.sendSms).toHaveBeenCalledOnce();
    expect(mocks.sendSms).toHaveBeenCalledWith("+12065550142", "Prepared\nexactly", "+12065550100", {
      purpose: "platform_lead", messagingServiceSid: "MGSHARED", mediaUrls: ["https://a/1.jpg"],
    });
  });

  it("refuses a proven changed mode for a pinned reply", async () => {
    mocks.config = { ...mocks.config, mode: "per_workspace" };
    expect(await sendPlatformLeadText(db, { to: "+12065550142", body: "Prepared", now: DAY, expectedFrom: "+12065550100" }))
      .toEqual({ ok: false, reason: "not_shared_mode" });
    expect(mocks.sendSms).not.toHaveBeenCalled();
  });

  it("refuses a changed prepared sender before provider submission", async () => {
    expect(await sendPlatformLeadText(db, { to: "+12065550142", body: "Prepared", now: DAY, expectedFrom: "+12065550199" }))
      .toEqual({ ok: false, reason: "no_shared_number" });
    expect(mocks.sendSms).not.toHaveBeenCalled();
  });

});
