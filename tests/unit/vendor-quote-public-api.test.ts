import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  conflict: class extends Error {},
  exchange: vi.fn(),
  load: vi.fn(),
  submit: vi.fn(),
  decline: vi.fn(),
  stop: vi.fn(),
  sms: vi.fn(),
  notify: vi.fn(),
}));

vi.mock("@/lib/vendor-quote-contact.server", () => ({
  VendorQuoteConflictError: mocks.conflict,
  assertVendorQuoteSessionBinding: vi.fn().mockResolvedValue(undefined),
  exchangeVendorQuoteCapability: mocks.exchange,
  loadVendorQuoteSession: mocks.load,
  submitVendorQuoteResponse: mocks.submit,
  declineVendorQuote: mocks.decline,
  stopVendorQuoteEmail: mocks.stop,
  requestVendorQuoteSmsChallenge: mocks.sms,
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({}) }));
vi.mock("@/lib/vendor-quote-notification.server", () => ({ notifyVendorQuoteResponse: mocks.notify }));

import { POST as exchange } from "@/app/api/public/vendor-quote/exchange/route";
import { GET as session } from "@/app/api/public/vendor-quote/session/route";
import { POST as respond } from "@/app/api/public/vendor-quote/response/route";
import { POST as withdraw } from "@/app/api/public/vendor-quote/withdrawal/route";
import { POST as smsChallenge } from "@/app/api/public/vendor-quote/sms-challenge/route";

const projection = {
  reference: "SR-2048",
  category: "Plumbing",
  city: "Seattle",
  senderName: "PropLane",
  senderEmail: "service@example.test",
  expiresAt: "2026-10-20T12:00:00.000Z",
  currentVersion: 3,
  quote: null,
  windows: [],
  canStopEmail: true,
  smsConsent: "not_requested" as const,
};

function jsonRequest(path: string, body: unknown, options: { origin?: string; cookie?: string } = {}) {
  return new Request(`https://example.test/api/public/vendor-quote/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(options.origin === undefined ? { Origin: "https://example.test" } : { Origin: options.origin }),
      ...(options.cookie ? { Cookie: options.cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.exchange.mockResolvedValue({ sessionToken: "opaque-session-token", expiresAt: "2026-10-19T12:00:00.000Z", projection });
  mocks.load.mockResolvedValue(projection);
  mocks.submit.mockResolvedValue({ projection, followUpReply: "Can you confirm access hours?", question: "Can you confirm access hours?", sourceMessageId: "vendor-quote:capability:3:response", response: {
    laborCents: 12500, materialsCents: 2500, diagnosticFeeCents: 0, scope: "Replace the faucet cartridge.", exclusions: "Wall repair is excluded.", durationMinutes: 90,
    windows: [{ startIso: "2026-10-20T16:00:00.000Z", endIso: "2026-10-20T18:00:00.000Z", timeZone: "America/Los_Angeles" }], question: "Can you confirm access hours?",
  } });
  mocks.decline.mockResolvedValue({ ok: true });
  mocks.stop.mockResolvedValue({ ok: true });
  mocks.sms.mockResolvedValue({ challengeId: "challenge", code: "123456789012", destinationPhone: "+12065550100", expiresAt: "2026-10-18T14:00:00Z" });
});

describe("public vendor quote capability routes", () => {
  it("exchanges a fragment capability for a purpose-scoped HttpOnly cookie without returning the session token", async () => {
    const response = await exchange(jsonRequest("exchange", { token: "A".repeat(43), purpose: "response" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-robots-tag")).toContain("noindex");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("set-cookie")).toContain("vendor_quote_response_session=opaque-session-token");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    const body = await response.json();
    expect(body).toMatchObject({ ok: true, projection: { reference: "SR-2048" } });
    expect(JSON.stringify(body)).not.toContain("opaque-session-token");
    expect(mocks.exchange).toHaveBeenCalledWith({}, { token: "A".repeat(43), purpose: "response" });
  });

  it("rejects cross-origin exchanges before capability lookup", async () => {
    const response = await exchange(jsonRequest("exchange", { token: "A".repeat(43), purpose: "response" }, { origin: "https://attacker.test" }));
    expect(response.status).toBe(403);
    expect(mocks.exchange).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("rejects a forged cross-site fetch even when the Origin header looks same-origin", async () => {
    const response = await exchange(new Request("https://example.test/api/public/vendor-quote/exchange", {
      method: "POST",
      headers: { Origin: "https://example.test", "Sec-Fetch-Site": "cross-site", "Content-Type": "application/json" },
      body: JSON.stringify({ token: "A".repeat(43), purpose: "response" }),
    }));
    expect(response.status).toBe(403);
    expect(mocks.exchange).not.toHaveBeenCalled();
  });

  it("reloads the session with the capability purpose", async () => {
    const request = new NextRequest("https://example.test/api/public/vendor-quote/session", {
      headers: { Cookie: "vendor_quote_withdrawal_session=withdraw-session" },
    });
    const response = await session(request);
    expect(response.status).toBe(200);
    expect(mocks.load).toHaveBeenCalledWith({}, "withdraw-session", "withdrawal");
    expect(await response.json()).toMatchObject({ ok: true, purpose: "withdrawal" });
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(mocks.decline).not.toHaveBeenCalled();
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("returns the same unavailable response when the session loader fails", async () => {
    mocks.load.mockRejectedValueOnce(new Error("database detail must not escape"));
    const request = new NextRequest("https://example.test/api/public/vendor-quote/session", {
      headers: { Cookie: "vendor_quote_response_session=opaque-session" },
    });
    const response = await session(request);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ ok: false });
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("requires same-origin JSON for quote actions and validates exact response fields", async () => {
    const crossSite = await respond(jsonRequest("response", { action: "decline", expectedVersion: 3 }, { origin: "https://attacker.test", cookie: "vendor_quote_response_session=session" }));
    expect(crossSite.status).toBe(403);
    expect(mocks.decline).not.toHaveBeenCalled();

    const invalid = await respond(jsonRequest("response", {
      action: "submit",
      expectedVersion: 3,
      response: { laborCents: -1, materialsCents: null, diagnosticFeeCents: null, scope: "", exclusions: "", durationMinutes: null, windows: [], question: "" },
    }, { cookie: "vendor_quote_response_session=session" }));
    expect(invalid.status).toBe(400);
    expect(mocks.submit).not.toHaveBeenCalled();

    const missingOrigin = await respond(new Request("https://example.test/api/public/vendor-quote/response", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: "vendor_quote_response_session=session" },
      body: JSON.stringify({ action: "decline", expectedVersion: 3 }),
    }));
    expect(missingOrigin.status).toBe(403);
    expect(mocks.decline).not.toHaveBeenCalled();
  });

  it("rejects stale expected versions without notifying the manager", async () => {
    mocks.submit.mockRejectedValueOnce(new mocks.conflict("The quote changed. Refresh and review it before saving again."));
    const response = await respond(jsonRequest("response", {
      action: "submit",
      expectedVersion: 2,
      response: {
        laborCents: 12500, materialsCents: 2500, diagnosticFeeCents: 0, scope: "Replace a faucet.", exclusions: "", durationMinutes: 90,
        windows: [], question: "",
      },
    }, { cookie: "vendor_quote_response_session=session" }));
    expect(response.status).toBe(409);
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("persists an exact quote payload and returns the scoped follow-up reply", async () => {
    const response = await respond(jsonRequest("response", {
      action: "submit",
      expectedVersion: 3,
      response: {
        laborCents: 12500,
        materialsCents: 2500,
        diagnosticFeeCents: 0,
        scope: "Replace the faucet cartridge.",
        exclusions: "Wall repair is excluded.",
        durationMinutes: 90,
        windows: [{ startIso: "2026-10-20T16:00:00.000Z", endIso: "2026-10-20T18:00:00.000Z", timeZone: "America/Los_Angeles" }],
        question: "Can you confirm access hours?",
      },
    }, { cookie: "vendor_quote_response_session=session" }));
    expect(response.status).toBe(200);
    expect(mocks.submit).toHaveBeenCalledWith({}, "session", expect.objectContaining({ expectedVersion: 3 }));
    expect(mocks.notify).toHaveBeenCalledWith({}, expect.objectContaining({
      sessionToken: "session",
      sourceMessageId: "vendor-quote:capability:3:response",
      channel: "portal",
      body: expect.stringContaining("Diagnostic fee: $0.00 USD"),
    }));
    expect(await response.json()).toMatchObject({ ok: true, followUpReply: "Can you confirm access hours?" });
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("requires explicit SMS consent and a response session before creating a challenge", async () => {
    const absentConsent = await smsChallenge(jsonRequest("sms-challenge", { phoneE164: "+12065550123", consented: false }, { cookie: "vendor_quote_response_session=session" }));
    expect(absentConsent.status).toBe(400);
    expect(mocks.sms).not.toHaveBeenCalled();

    const accepted = await smsChallenge(jsonRequest("sms-challenge", { phoneE164: "+12065550123", consented: true }, { cookie: "vendor_quote_response_session=session" }));
    expect(accepted.status).toBe(200);
    expect(mocks.sms).toHaveBeenCalledWith({}, "session", { phoneE164: "+12065550123", consented: true });
    expect(await accepted.json()).toMatchObject({ challenge: { destinationPhone: "+12065550100" } });
  });

  it("uses a withdrawal-purpose session only for stopping quote email", async () => {
    const response = await withdraw(jsonRequest("withdrawal", { action: "stop_email" }, { cookie: "vendor_quote_withdrawal_session=withdraw-session" }));
    expect(response.status).toBe(200);
    expect(mocks.stop).toHaveBeenCalledWith({}, "withdraw-session");
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("does not let a withdrawal session submit or a response session stop email", async () => {
    const responseWithWithdrawal = await respond(jsonRequest("response", { action: "decline", expectedVersion: 3 }, {
      cookie: "vendor_quote_withdrawal_session=withdraw-session",
    }));
    expect(responseWithWithdrawal.status).toBe(404);
    expect(mocks.decline).not.toHaveBeenCalled();

    const stopWithResponse = await withdraw(jsonRequest("withdrawal", { action: "stop_email" }, {
      cookie: "vendor_quote_response_session=response-session",
    }));
    expect(stopWithResponse.status).toBe(404);
    expect(mocks.stop).not.toHaveBeenCalled();
  });

  it("requires a phone number even after consent before issuing an SMS challenge", async () => {
    const response = await smsChallenge(jsonRequest("sms-challenge", { phoneE164: "", consented: true }, {
      cookie: "vendor_quote_response_session=session",
    }));
    expect(response.status).toBe(400);
    expect(mocks.sms).not.toHaveBeenCalled();
  });
});


describe("quote same-origin protection behind the canonical request host", () => {
  it("accepts a real localhost browser when Next binds 0.0.0.0", async () => {
    const response = await exchange(new Request("http://0.0.0.0:3013/api/public/vendor-quote/exchange", {
      method: "POST", headers: { Host: "localhost:3013", Origin: "http://localhost:3013", "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" },
      body: JSON.stringify({ token: "A".repeat(43), purpose: "response" }),
    }));
    expect(response.status).toBe(200);
    expect(mocks.exchange).toHaveBeenCalledOnce();
  });
  it.each([
    { origin: "http://attacker.test", site: "same-origin", type: "application/json" },
    { origin: "http://localhost:3013", site: "cross-site", type: "application/json" },
    { origin: "http://localhost:3013", site: "same-origin", type: "text/plain" },
    { origin: "", site: "same-origin", type: "application/json" },
    { origin: "https://localhost:3013", site: "same-origin", type: "application/json" },
  ])("refuses mismatched browser proof %#", async ({ origin, site, type }) => {
    const response = await exchange(new Request("http://0.0.0.0:3013/api/public/vendor-quote/exchange", {
      method: "POST", headers: { Host: "localhost:3013", Origin: origin, "Sec-Fetch-Site": site, "Content-Type": type },
      body: JSON.stringify({ token: "A".repeat(43), purpose: "response" }),
    }));
    expect(response.status).toBe(403);
    expect(mocks.exchange).not.toHaveBeenCalled();
  });
});
