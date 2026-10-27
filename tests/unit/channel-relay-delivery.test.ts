import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ postResendEmail: vi.fn(), allowed: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/resend-delivery.server", () => ({ postResendEmail: mocks.postResendEmail }));
vi.mock("@/lib/manager-communication-access.server", () => ({ assertManagerCommunicationAllowed: mocks.allowed }));

import { deliverManagerEmailReply } from "@/lib/agent/manager-email-agent.server";

const base = {
  managerUserId: "mgr-1",
  subject: "Re: New message from Jose Alaniz",
  text: "Thanks Jose, see you soon.",
  fromAddress: "assist-ambika@prop-lane.space",
  replyTo: "assist-ambika@prop-lane.space",
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.RESEND_API_KEY = "re_test";
  mocks.allowed.mockResolvedValue({ allowed: true });
  mocks.postResendEmail.mockResolvedValue({ ok: true, json: async () => ({}) });
});

describe("a channel reply goes only to the site's relay address, only for an authenticated message", () => {
  it("sends to the parsed relay address from the work email", async () => {
    const result = await deliverManagerEmailReply({ ...base, toEmail: "k3f9a1c2d4@reply.airbnb.com", channel: { site: "airbnb", authenticated: true } });
    expect(result).toEqual({ ok: true });
    const payload = mocks.postResendEmail.mock.calls[0]![0].payload;
    expect(payload.to).toEqual(["k3f9a1c2d4@reply.airbnb.com"]);
    expect(payload.from).toContain("assist-ambika@prop-lane.space");
  });

  it("refuses an unauthenticated channel message", async () => {
    const result = await deliverManagerEmailReply({ ...base, toEmail: "k3f9a1c2d4@reply.airbnb.com", channel: { site: "airbnb", authenticated: false } });
    expect(result.ok).toBe(false);
    expect(mocks.postResendEmail).not.toHaveBeenCalled();
  });

  it("refuses any address that is not on the site's own domain, even for an authenticated message", async () => {
    for (const to of ["attacker@evil.test", "guest@gmail.com", "x@reply.airbnb.com.evil.test"]) {
      const result = await deliverManagerEmailReply({ ...base, toEmail: to, channel: { site: "airbnb", authenticated: true } });
      expect(result.ok).toBe(false);
    }
    expect(mocks.postResendEmail).not.toHaveBeenCalled();
  });

  it("a non-channel reply is unchanged", async () => {
    const result = await deliverManagerEmailReply({ ...base, toEmail: "someone@example.com" });
    expect(result.ok).toBe(true);
  });
});
