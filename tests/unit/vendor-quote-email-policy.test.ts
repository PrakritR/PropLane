import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));

import { isEligibleVendorQuoteEmailEvidence, isResendSenderDomainReady, sendAuthorizedVendorQuoteEmail } from "@/lib/vendor-quote-email.server";

const now = Date.parse("2026-10-18T12:00:00.000Z");
const evidence = (patch: Record<string, unknown> = {}) => ({
  email: "quotes@plumber.example", source: "published_quote_invitation", sourceUrl: "https://plumber.example/quote",
  invitationText: "Email quotes@plumber.example for a service quote.", recordedAt: "2026-10-17T12:00:00.000Z",
  scope: "service_quote", version: 1, followUpAllowed: false, ...patch,
});

afterEach(() => vi.unstubAllGlobals());

describe("vendor quote email policy", () => {
  it("accepts a fresh own-domain invitation scoped to a quote", () => {
    expect(isEligibleVendorQuoteEmailEvidence("quotes@plumber.example", evidence(), now)).toBe(true);
  });

  it.each([
    ["directory address", evidence({ sourceUrl: "https://directory.example/vendor", invitationText: "Email quotes@plumber.example for a service quote." })],
    ["generic contact copy", evidence({ invitationText: "Contact quotes@plumber.example for more information." })],
    ["cross-domain address", evidence({ email: "quotes@other.example" })],
    ["follow-up consent", evidence({ followUpAllowed: true })],
    ["old evidence", evidence({ recordedAt: "2026-09-01T00:00:00.000Z" })],
    ["non-HTTPS source", evidence({ sourceUrl: "http://plumber.example/quote" })],
  ])("rejects %s", (_name, row) => {
    expect(isEligibleVendorQuoteEmailEvidence("quotes@plumber.example", row, now)).toBe(false);
  });

  it("requires the exact email domain to be verified in the configured Resend account", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [
      { name: "other.example", status: "verified" },
      { name: "plumber.example", status: "pending" },
    ] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await isResendSenderDomainReady("team@plumber.example", "key")).toBe(false);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: [{ name: "plumber.example", status: "verified" }] }), { status: 200 }));
    expect(await isResendSenderDomainReady("team@plumber.example", "key")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails closed when domain readiness cannot be read", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
    expect(await isResendSenderDomainReady("team@plumber.example", "key")).toBe(false);
    expect(await isResendSenderDomainReady("team@plumber.example", "")).toBe(false);
  });

  it("authorizes immediately before send and records accepted provider evidence", async () => {
    const calls: string[] = [];
    const db = { rpc: vi.fn(async (name: string) => {
      calls.push(name);
      return name === "authorize_vendor_quote_email_outbox" ? { data: true, error: null } : { data: true, error: null };
    }) } as never;
    const sender = { mode: "software", managerUserId: "m", displayName: "A", legalName: "A", email: "manager@axis.example", workPhone: null, messagingServiceSid: null, workspaceId: "w", version: 1 } as const;
    const result = await sendAuthorizedVendorQuoteEmail(db, {
      outboxId: "o", deliveryLeaseToken: "lease", capabilityId: "cap", managerUserId: "m", workOrderId: "service", sender,
      apiKey: "key", idempotencyKey: "stable", payload: { from: "A <manager@axis.example>", to: ["vendor@example.com"], subject: "Quote", text: "Quote?", reply_to: "reply@example.com" },
      effectSummary: "Quote", metadata: {},
    }, {
      resolveIdentity: vi.fn(async () => sender as never),
      domainReady: vi.fn(async () => true),
      send: vi.fn(async () => new Response(JSON.stringify({ id: "resend-id" }), { status: 200 })),
    });
    expect(result).toMatchObject({ ok: true, state: "accepted", providerMessageId: "resend-id", capabilityId: "cap" });
    expect(calls).toEqual(["authorize_vendor_quote_email_outbox", "finish_vendor_quote_email_outbox"]);
  });

  it("marks a malformed successful provider reply unknown because acceptance is ambiguous", async () => {
    const rpc = vi.fn(async (name: string) => name === "authorize_vendor_quote_email_outbox" ? { data: true, error: null } : { data: true, error: null });
    const db = { rpc } as never;
    const sender = { mode: "software", managerUserId: "m", displayName: "A", legalName: "A", email: "manager@axis.example", workPhone: null, messagingServiceSid: null, workspaceId: "w", version: 1 } as const;
    const result = await sendAuthorizedVendorQuoteEmail(db, {
      outboxId: "o", deliveryLeaseToken: "lease", capabilityId: "cap", managerUserId: "m", workOrderId: "service", sender,
      apiKey: "key", idempotencyKey: "stable", payload: { from: "A <manager@axis.example>", to: ["vendor@example.com"], subject: "Quote", text: "Quote?", reply_to: "reply@example.com" },
      effectSummary: "Quote", metadata: {},
    }, {
      resolveIdentity: vi.fn(async () => sender as never), domainReady: vi.fn(async () => true),
      send: vi.fn(async () => new Response("not json", { status: 200 })),
    });
    expect(result).toMatchObject({ ok: false, state: "unknown" });
    expect(rpc.mock.calls[1]?.[1]).toMatchObject({ p_state: "unknown", p_error_code: "resend_200" });
  });
});
