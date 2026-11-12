import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  user: { id: "res-1", email: "jane@example.com" } as { id: string; email: string } | null,
  ctx: vi.fn(),
  view: vi.fn(),
  precheck: vi.fn(),
  run: vi.fn(),
  create: vi.fn(),
  skipsCharge: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: h.user } }) } }) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({}) }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: async () => ({ ok: true }), clientIpFrom: () => "1.2.3.4" }));
vi.mock("@/lib/app-url", () => ({ resolveAppOrigin: () => "https://proplane.ai" }));
vi.mock("@/lib/test-workspaces/effects.server", () => ({ assertTestWorkspaceProviderEffectAllowed: async () => undefined }));
vi.mock("@/lib/screening/applicant-screening-access.server", () => ({ loadApplicantScreeningContext: h.ctx }));
vi.mock("@/lib/screening/applicant-offer.server", () => ({ resolveApplicantScreeningView: h.view }));
vi.mock("@/lib/checkr/background-check", () => ({ precheckBackgroundCheckOrder: h.precheck, runBackgroundCheck: h.run }));
vi.mock("@/lib/checkr/config", async (orig) => ({ ...(await orig<typeof import("@/lib/checkr/config")>()), checkrSkipsManagerCardCharge: h.skipsCharge }));
vi.mock("@/lib/stripe", () => ({ getStripe: () => ({ checkout: { sessions: { create: h.create } } }) }));

import { POST } from "@/app/api/screening/applicant-checkout/route";
import { FCRA_DISCLOSURE_VERSION, applicantScreeningQuote } from "@/lib/screening/applicant-screening";

const post = (body: unknown) => POST(new Request("https://proplane.ai/api/screening/applicant-checkout", { method: "POST", body: JSON.stringify(body) }));
const offerView = (includeIdCheck: boolean) => ({ offer: { kind: "offer", quote: applicantScreeningQuote({ includeIdCheck }), idCheck: includeIdCheck, backgroundCheck: true }, check: null });
const good = { applicationId: "app-1", authorize: true, disclosureVersion: FCRA_DISCLOSURE_VERSION, returnPath: "/resident/applications" };

beforeEach(() => {
  h.user = { id: "res-1", email: "jane@example.com" };
  h.ctx.mockReset().mockResolvedValue({ ok: true, managerUserId: "mgr-1", propertyId: "prop-1", row: {} });
  h.view.mockReset().mockResolvedValue(offerView(true));
  h.precheck.mockReset().mockResolvedValue({ ok: true, row: {} });
  h.run.mockReset();
  h.skipsCharge.mockReset().mockReturnValue(false);
  h.create.mockReset().mockResolvedValue({ id: "cs_1", client_secret: "secret_1" });
});

describe("POST /api/screening/applicant-checkout", () => {
  it("creates an embedded Stripe session for Starter + ID at the server's total, with the FCRA authorization and payer in metadata", async () => {
    const res = await post(good);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ clientSecret: "secret_1", totalCents: 2794, totalLabel: "$27.94" });
    const args = h.create.mock.calls[0][0];
    expect(args.ui_mode).toBe("embedded_page");
    expect(args.line_items.map((l: { price_data: { unit_amount: number } }) => l.price_data.unit_amount)).toEqual([2499, 295]);
    expect(args.metadata).toMatchObject({
      purpose: "application_screening",
      application_id: "app-1",
      manager_user_id: "mgr-1",
      package_slug: "starter",
      add_on_products: "identity_verification",
      payer: "applicant",
      payer_user_id: "res-1",
      fcra_disclosure_version: FCRA_DISCLOSURE_VERSION,
    });
    expect(args.metadata.fcra_authorized_at).toBeTruthy();
    expect(args.payment_intent_data.metadata).toEqual(args.metadata);
    expect(args.return_url).toContain("https://proplane.ai/resident/applications?screening=return&session_id={CHECKOUT_SESSION_ID}");
    expect(h.precheck).toHaveBeenCalledWith(expect.objectContaining({ payer: "applicant", managerUserId: "mgr-1" }));
  });

  it("charges Starter alone when the listing did not turn the ID check on", async () => {
    h.view.mockResolvedValue(offerView(false));
    const res = await post(good);
    expect((await res.json()).totalCents).toBe(2499);
    expect(h.create.mock.calls[0][0].line_items).toHaveLength(1);
  });

  it("never trusts an amount or package from the body", async () => {
    await post({ ...good, amount: 1, totalCents: 1, packageSlug: "complete", addOnProducts: [] });
    expect(h.create.mock.calls[0][0].metadata.package_slug).toBe("starter");
    expect(h.create.mock.calls[0][0].line_items[0].price_data.unit_amount).toBe(2499);
  });

  it("refuses without authorization or with another disclosure version, before any Stripe call", async () => {
    for (const body of [{ ...good, authorize: false }, { ...good, authorize: undefined }, { ...good, disclosureVersion: "old" }]) {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("authorization_required");
    }
    expect(h.create).not.toHaveBeenCalled();
  });

  it("fails closed with 'ID check unavailable' and creates no session", async () => {
    h.view.mockResolvedValue({ offer: { kind: "id_unavailable" }, check: null });
    const res = await post(good);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "ID check unavailable.", code: "ID_CHECK_UNAVAILABLE" });
    expect(h.create).not.toHaveBeenCalled();
  });

  it("refuses when nothing is offered, when a check exists, when signed out, and for someone else's application", async () => {
    h.view.mockResolvedValueOnce({ offer: { kind: "none" }, check: null });
    expect((await post(good)).status).toBe(403);
    h.view.mockResolvedValueOnce({ offer: { kind: "none" }, check: { status: "pending", idVerified: false } });
    expect((await post(good)).status).toBe(409);
    h.ctx.mockResolvedValueOnce({ ok: false, status: 404, error: "Application not found." });
    expect((await post(good)).status).toBe(404);
    h.user = null;
    expect((await post(good)).status).toBe(401);
    expect(h.create).not.toHaveBeenCalled();
  });

  it("rejects an open-redirect style returnPath", async () => {
    expect((await post({ ...good, returnPath: "//evil.example" })).status).toBe(400);
    expect((await post({ ...good, returnPath: "https://evil.example" })).status).toBe(400);
  });
});
