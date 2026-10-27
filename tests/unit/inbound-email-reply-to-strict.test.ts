import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: vi.fn() }));

import { parseInboundEmailWebhook } from "@/lib/inbound-email/inbound-email.server";

function webhook(data: Record<string, unknown>) {
  return { type: "email.received", data: { email_id: "e1", from: "automated@airbnb.com", to: ["a@prop-lane.space"], subject: "s", ...data } };
}

describe("the inlined reply_to is one strict address", () => {
  it("reads a bare address and a Name <addr>", () => {
    expect(parseInboundEmailWebhook(webhook({ reply_to: "K3F9@reply.airbnb.com" }))?.replyTo).toBe("k3f9@reply.airbnb.com");
    expect(parseInboundEmailWebhook(webhook({ reply_to: ["Jose <k3f9@reply.airbnb.com>"] }))?.replyTo).toBe("k3f9@reply.airbnb.com");
  });

  it("does not read a list, from the payload or (falling through) the header", () => {
    expect(parseInboundEmailWebhook(webhook({ reply_to: "evil@evil.com, x@airbnb.com" }))?.replyTo).toBeUndefined();
    expect(
      parseInboundEmailWebhook(webhook({ reply_to: "evil@evil.com, x@airbnb.com", headers: { "reply-to": "evil@evil.com, x@airbnb.com" } }))?.replyTo,
    ).toBeUndefined();
  });

  it("falls back to a strict Reply-To header when the inlined value is a list", () => {
    expect(
      parseInboundEmailWebhook(webhook({ reply_to: "evil@evil.com, x@airbnb.com", headers: { "reply-to": "Jose <k3f9@reply.airbnb.com>" } }))?.replyTo,
    ).toBe("k3f9@reply.airbnb.com");
  });
});
