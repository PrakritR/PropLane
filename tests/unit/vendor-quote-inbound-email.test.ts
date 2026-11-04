import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadCapability: vi.fn(),
  notify: vi.fn(),
  fetchBody: vi.fn(),
  htmlToText: vi.fn(),
}));

vi.mock("@/lib/vendor-quote-contact.server", () => ({
  loadVendorQuoteInboundReplyCapability: mocks.loadCapability,
}));
vi.mock("@/lib/vendor-quote-notification.server", () => ({ notifyVendorQuoteResponse: mocks.notify }));
vi.mock("@/lib/inbound-email/inbound-email.server", () => ({
  fetchResendReceivedEmailBodyWithRetry: mocks.fetchBody,
  htmlToText: mocks.htmlToText,
}));

import { ingestVendorQuoteInboundEmail } from "@/lib/vendor-quote-inbound-email.server";

const token = "a".repeat(52);
const capability = { capabilityId: "cap-1", candidateId: "candidate-1", managerUserId: "manager-1" };
const parsed = (overrides: Partial<{
  emailId: string;
  fromEmail: string;
  fromName: string;
  toEmails: string[];
  subject: string;
  receivedAt: string;
  text?: string;
  html?: string;
}> = {}) => ({
  emailId: "email-123",
  fromEmail: "vendor@example.test",
  fromName: "Vendor",
  toEmails: [`vq+${token}@reply.example.test`],
  subject: "Re: Service quote",
  receivedAt: "2026-10-18T14:00:00.000Z",
  ...overrides,
});

function makeDb() {
  const finalEq = vi.fn().mockResolvedValue({ error: null });
  const firstEq = vi.fn().mockReturnValue({ eq: finalEq });
  const update = vi.fn().mockReturnValue({ eq: firstEq });
  const from = vi.fn().mockReturnValue({ update });
  return { db: { from }, from, update, firstEq, finalEq };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("RESEND_REPLY_DOMAIN", "reply.example.test");
  mocks.loadCapability.mockResolvedValue(capability);
  mocks.notify.mockResolvedValue(undefined);
  mocks.fetchBody.mockResolvedValue({ kind: "body", text: "Fetched quote reply" });
  mocks.htmlToText.mockReturnValue("HTML quote reply");
});

describe("vendor quote inbound email ingestion", () => {
  it("ignores addresses outside the configured domain and mail without a quote capability address", async () => {
    const { db } = makeDb();
    const wrongDomain = await ingestVendorQuoteInboundEmail(db as never, parsed({ toEmails: [`vq+${token}@other.example.test`] }), {});
    const unrelated = await ingestVendorQuoteInboundEmail(db as never, parsed({ toEmails: ["support@reply.example.test"] }), {});

    expect(wrongDomain).toEqual({ handled: false });
    expect(unrelated).toEqual({ handled: false });
    expect(mocks.loadCapability).not.toHaveBeenCalled();
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("passes the exact token and From address to capability validation", async () => {
    const { db } = makeDb();
    const result = await ingestVendorQuoteInboundEmail(db as never, parsed({ text: "Price is $425." }), { type: "email.received" });

    expect(result).toEqual({ handled: true });
    expect(mocks.loadCapability).toHaveBeenCalledWith(db, { token, fromEmail: "vendor@example.test" });
    expect(mocks.notify).toHaveBeenCalledWith(db, {
      capabilityId: "cap-1",
      sourceMessageId: "vendor-quote-email:email-123",
      body: "Price is $425.",
      channel: "email",
    });
  });

  it.each([
    ["missing From", ""],
    ["a different From address", "impostor@example.test"],
  ])("handles recognized mail with %s when the capability validator rejects it", async (_label, fromEmail) => {
    const { db } = makeDb();
    mocks.loadCapability.mockResolvedValueOnce(null);
    const result = await ingestVendorQuoteInboundEmail(db as never, parsed({ fromEmail, text: "A fabricated reply." }), {});

    expect(result).toEqual({ handled: true });
    expect(mocks.loadCapability).toHaveBeenCalledWith(db, { token, fromEmail });
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("consumes a recognized but invalid token without falling through to generic email handling", async () => {
    const { db } = makeDb();
    mocks.loadCapability.mockResolvedValueOnce(null);
    const result = await ingestVendorQuoteInboundEmail(db as never, parsed({ text: "Do not route me elsewhere." }), {});

    expect(result).toEqual({ handled: true });
    expect(mocks.notify).not.toHaveBeenCalled();
    expect(db.from).not.toHaveBeenCalled();
  });

  it("fetches a missing body, strips quoted history, and persists the new reply", async () => {
    const { db } = makeDb();
    mocks.fetchBody.mockResolvedValueOnce({
      kind: "body",
      text: "Please schedule this for Friday.\n\nOn Tue, Oct 13, 2026 Vendor <vendor@example.test> wrote:\n> Old quote",
    });
    const result = await ingestVendorQuoteInboundEmail(db as never, parsed(), { type: "email.received" });

    expect(result).toEqual({ handled: true });
    expect(mocks.fetchBody).toHaveBeenCalledWith("email-123");
    expect(mocks.notify).toHaveBeenCalledWith(db, expect.objectContaining({
      sourceMessageId: "vendor-quote-email:email-123",
      body: "Please schedule this for Friday.",
      channel: "email",
    }));
    expect(db.from).toHaveBeenCalledWith("vendor_sourcing_candidates");
  });

  it("uses an inline HTML body without fetching it from the provider", async () => {
    const { db } = makeDb();
    const result = await ingestVendorQuoteInboundEmail(db as never, parsed({ html: "<p>HTML body</p>" }), {});

    expect(result).toEqual({ handled: true });
    expect(mocks.htmlToText).toHaveBeenCalledWith("<p>HTML body</p>");
    expect(mocks.fetchBody).not.toHaveBeenCalled();
    expect(mocks.notify).toHaveBeenCalledWith(db, expect.objectContaining({ body: "HTML quote reply" }));
  });

  it("throws when the provider body fetch cannot complete so the signed event can retry", async () => {
    const { db } = makeDb();
    mocks.fetchBody.mockResolvedValueOnce({ kind: "unavailable" });

    await expect(ingestVendorQuoteInboundEmail(db as never, parsed(), {})).rejects.toThrow("provider retry required");
    expect(mocks.notify).not.toHaveBeenCalled();
    expect(db.from).not.toHaveBeenCalled();
  });

  it("skips quoted-only replies and automatic replies", async () => {
    const { db } = makeDb();
    const quotedOnly = await ingestVendorQuoteInboundEmail(db as never, parsed({ text: "> Previous message only" }), {});
    const autoreplySubject = await ingestVendorQuoteInboundEmail(db as never, parsed({ subject: "Automatic reply: away" }), {});
    const autoreplyHeader = await ingestVendorQuoteInboundEmail(db as never, parsed({ text: "Thanks" }), {
      data: { headers: { "Auto-Submitted": "auto-replied" } },
    });

    expect(quotedOnly).toEqual({ handled: true });
    expect(autoreplySubject).toEqual({ handled: true });
    expect(autoreplyHeader).toEqual({ handled: true });
    expect(mocks.notify).not.toHaveBeenCalled();
    expect(db.from).not.toHaveBeenCalled();
  });

  it("saves a native email reply once with a stable provider event id", async () => {
    const { db, update, firstEq, finalEq } = makeDb();
    const result = await ingestVendorQuoteInboundEmail(db as never, parsed({ text: "We can arrive at 9 AM." }), {});

    expect(result).toEqual({ handled: true });
    expect(mocks.notify).toHaveBeenCalledTimes(1);
    expect(mocks.notify).toHaveBeenCalledWith(db, expect.objectContaining({ sourceMessageId: "vendor-quote-email:email-123" }));
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ status: "responding" }));
    expect(firstEq).toHaveBeenCalledWith("id", "candidate-1");
    expect(finalEq).toHaveBeenCalledWith("manager_user_id", "manager-1");
  });
});
