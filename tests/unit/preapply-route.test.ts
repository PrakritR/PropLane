import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  user: { id: "res-1", email: "jane@example.com" } as { id: string; email: string } | null,
  ctx: vi.fn(),
  view: vi.fn(),
  place: vi.fn(),
  create: vi.fn(),
  skipsCharge: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: h.user } }) } }) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({}) }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: async () => ({ ok: true }), clientIpFrom: () => "1.2.3.4" }));
vi.mock("@/lib/app-url", () => ({ resolveAppOrigin: () => "https://proplane.ai" }));
vi.mock("@/lib/test-workspaces/effects.server", () => ({ assertTestWorkspaceProviderEffectAllowed: async () => undefined }));
vi.mock("@/lib/screening/preapply.server", () => ({
  loadPreApplyContext: h.ctx,
  resolvePreApplyView: h.view,
  placePreApplyOrder: h.place,
}));
vi.mock("@/lib/checkr/config", async (orig) => ({ ...(await orig<typeof import("@/lib/checkr/config")>()), checkrSkipsManagerCardCharge: h.skipsCharge }));
vi.mock("@/lib/stripe", () => ({ getStripe: () => ({ checkout: { sessions: { create: h.create } } }) }));

import { GET } from "@/app/api/screening/preapply/route";
import { POST } from "@/app/api/screening/preapply/checkout/route";
import { FCRA_DISCLOSURE_VERSION } from "@/lib/screening/applicant-screening";
import { evaluatePreApply, resolvePreApplyPlan } from "@/lib/screening/preapply";

const env = { idEnabled: true, idProvider: "checkr" as const, backgroundConfigured: true };
function resolved(settings: { idCheck: boolean; backgroundCheck: boolean }, check: unknown = null, orderAllowed = true) {
  const plan = resolvePreApplyPlan({ settings: { ...settings, idUnlock: "clear" }, env });
  return { ok: true, view: { state: evaluatePreApply({ plan, check: check as never, personaVerified: false }), plan, record: null, orderAllowed } };
}
const post = (body: unknown) => POST(new Request("https://proplane.ai/api/screening/preapply/checkout", { method: "POST", body: JSON.stringify(body) }));
const good = { propertyId: "prop-1", authorize: true, disclosureVersion: FCRA_DISCLOSURE_VERSION, returnPath: "/resident/applications/apply?propertyId=prop-1" };

beforeEach(() => {
  h.user = { id: "res-1", email: "jane@example.com" };
  h.ctx.mockReset().mockResolvedValue({ ok: true, userId: "res-1", email: "jane@example.com", propertyId: "prop-1", managerUserId: "mgr-1" });
  h.view.mockReset().mockResolvedValue(resolved({ idCheck: true, backgroundCheck: true }));
  h.place.mockReset().mockResolvedValue({ ok: true });
  h.skipsCharge.mockReset().mockReturnValue(false);
  h.create.mockReset().mockResolvedValue({ id: "cs_1", client_secret: "secret_1" });
});

describe("GET /api/screening/preapply", () => {
  it("returns the steps, the next step and the exact total, plus the disclosure to authorize", async () => {
    const res = await GET(new Request("https://proplane.ai/api/screening/preapply?propertyId=prop-1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ required: true, satisfied: false, next: "verify_id", provider: "checkr" });
    expect(body.steps.map((s: { id: string }) => s.id)).toEqual(["verify_id", "background_check"]);
    expect(body.quote).toMatchObject({ totalCents: 2794 });
    expect(body.disclosure.version).toBe(FCRA_DISCLOSURE_VERSION);
  });

  it("is signed-in only and needs a property", async () => {
    expect((await GET(new Request("https://proplane.ai/api/screening/preapply"))).status).toBe(400);
    h.user = null;
    expect((await GET(new Request("https://proplane.ai/api/screening/preapply?propertyId=p"))).status).toBe(401);
  });
});

describe("POST /api/screening/preapply/checkout", () => {
  it("creates an embedded session for Starter + ID at the server's total, tagged preapply with the FCRA authorization", async () => {
    const res = await post(good);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ clientSecret: "secret_1", totalCents: 2794 });
    const args = h.create.mock.calls[0][0];
    expect(args.line_items.map((l: { price_data: { unit_amount: number } }) => l.price_data.unit_amount)).toEqual([2499, 295]);
    expect(args.metadata).toMatchObject({
      purpose: "application_screening",
      preapply: "1",
      property_id: "prop-1",
      manager_user_id: "mgr-1",
      payer: "applicant",
      payer_user_id: "res-1",
      add_on_products: "identity_verification",
      fcra_disclosure_version: FCRA_DISCLOSURE_VERSION,
    });
    expect(args.metadata.application_id).toBeUndefined();
    expect(args.client_reference_id).toBe("res-1");
    expect(args.return_url).toContain("preapply=return&session_id={CHECKOUT_SESSION_ID}");
  });

  it("charges Starter alone for a background-check-only listing and never trusts a body amount", async () => {
    h.view.mockResolvedValue(resolved({ idCheck: false, backgroundCheck: true }));
    await post({ ...good, amount: 1, totalCents: 1, packageSlug: "complete" });
    expect(h.create.mock.calls[0][0].line_items).toHaveLength(1);
    expect(h.create.mock.calls[0][0].metadata.package_slug).toBe("starter");
  });

  it("refuses without authorization or with another disclosure version, before any Stripe call", async () => {
    for (const body of [{ ...good, authorize: false }, { ...good, authorize: undefined }, { ...good, disclosureVersion: "old" }]) {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "authorization_required" });
    }
    expect(h.create).not.toHaveBeenCalled();
  });

  it("refuses when the listing requires nothing, when it is already covered, and when the ID check is unavailable", async () => {
    h.view.mockResolvedValue(resolved({ idCheck: false, backgroundCheck: false }));
    expect((await post(good)).status).toBe(403);
    h.view.mockResolvedValue(resolved({ idCheck: true, backgroundCheck: true }, null, false));
    const covered = await post(good);
    expect(covered.status).toBe(409);
    expect(await covered.json()).toMatchObject({ code: "already_screened" });
    const plan = resolvePreApplyPlan({ settings: { idCheck: true, backgroundCheck: false, idUnlock: "clear" }, env: { ...env, idProvider: null } });
    h.view.mockResolvedValue({ ok: true, view: { state: evaluatePreApply({ plan, check: null, personaVerified: false }), plan, record: null, orderAllowed: false } });
    const unavailable = await post(good);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({ code: "ID_CHECK_UNAVAILABLE" });
    expect(h.create).not.toHaveBeenCalled();
  });

  it("validates the return path and the session, and surfaces a context refusal", async () => {
    expect((await post({ ...good, returnPath: "//evil.example" })).status).toBe(400);
    expect((await post({ ...good, propertyId: "" })).status).toBe(400);
    h.ctx.mockResolvedValue({ ok: false, status: 403, error: "Forbidden." });
    expect((await post(good)).status).toBe(403);
    h.user = null;
    expect((await post(good)).status).toBe(401);
  });

  it("simulate-only environments place the order directly with nothing to charge", async () => {
    h.skipsCharge.mockReturnValue(true);
    const res = await post(good);
    expect(await res.json()).toMatchObject({ ok: true, ran: true });
    expect(h.place).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ userId: "res-1", propertyId: "prop-1", managerUserId: "mgr-1", addOnProducts: ["identity_verification"] }));
    expect(h.create).not.toHaveBeenCalled();
  });
});
