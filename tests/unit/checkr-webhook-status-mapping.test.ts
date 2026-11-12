import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const SECRET = "whsec_live";
const h = vi.hoisted(() => ({ fetchReport: vi.fn(), apply: vi.fn() }));

function sign(body: string, secret = SECRET, ts = Math.floor(Date.now() / 1000)) {
  return `t=${ts},v1=${createHmac("sha256", secret).update(`${ts}.${body}`, "utf8").digest("hex")}`;
}

async function loadRoute() {
  vi.resetModules();
  vi.doMock("@/lib/checkr/client", () => ({ fetchBackgroundCheckReport: h.fetchReport }));
  vi.doMock("@/lib/checkr/background-check", () => ({ applyBackgroundCheckReport: h.apply }));
  vi.doMock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({}) }));
  return (await import("@/app/api/webhooks/screening/checkr/route")).POST;
}
const post = (POST: (r: Request) => Promise<Response>, host: string, body: string, header: string | null) =>
  POST(new Request(`https://${host}/api/webhooks/screening/checkr`, { method: "POST", body, headers: header ? { "Tenant-Signature": header } : {} }));

beforeEach(() => {
  process.env.VERCEL = "1";
  process.env.CHECKR_WEBHOOK_SECRET = SECRET;
  h.fetchReport.mockReset();
  h.apply.mockReset();
});
afterEach(() => {
  delete process.env.VERCEL;
  delete process.env.CHECKR_WEBHOOK_SECRET;
  vi.doUnmock("@/lib/checkr/client");
  vi.doUnmock("@/lib/checkr/background-check");
  vi.doUnmock("@/lib/supabase/service");
});

describe("Checkr webhook: signature, hosts, status mapping", () => {
  it("accepts a signed delivery on proplane.ai AND the legacy axis-seattle-housing.com host", async () => {
    const POST = await loadRoute();
    h.fetchReport.mockResolvedValue({ orderId: "ord_1", status: "complete", result: "clear" });
    h.apply.mockResolvedValue({ id: "app_1" });
    const body = JSON.stringify({ type: "report.completed", data: { id: "rp_1", order_id: "ord_1" } });
    for (const host of ["proplane.ai", "www.proplane.ai", "axis-seattle-housing.com", "www.axis-seattle-housing.com"]) {
      const res = await post(POST, host, body, sign(body));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, applicationId: "app_1" });
    }
  });

  it("the legacy-host redirect never touches the webhook (an /api POST is never 308'd)", async () => {
    const { shouldRedirectLegacyHostVisitor } = await import("@/lib/legacy-host-redirect");
    const headers = new Headers({ "sec-fetch-mode": "navigate" });
    for (const method of ["POST", "GET"]) {
      expect(
        shouldRedirectLegacyHostVisitor({ pathname: "/api/webhooks/screening/checkr", method, hostname: "axis-seattle-housing.com", headers, hasNativeMarkerCookie: false }),
      ).toBe(false);
    }
  });

  it("rejects a missing, wrong-secret, tampered or stale signature before touching Checkr", async () => {
    const POST = await loadRoute();
    const body = JSON.stringify({ type: "report.completed", data: { order_id: "ord_1" } });
    expect((await post(POST, "proplane.ai", body, null)).status).toBe(401);
    expect((await post(POST, "proplane.ai", body, sign(body, "other"))).status).toBe(401);
    expect((await post(POST, "proplane.ai", body + " ", sign(body))).status).toBe(401);
    expect((await post(POST, "proplane.ai", body, sign(body, SECRET, Math.floor(Date.now() / 1000) - 3600))).status).toBe(401);
    expect(h.fetchReport).not.toHaveBeenCalled();
    expect(h.apply).not.toHaveBeenCalled();
  });

  it("applies the status Checkr reports (not the payload's) for completion, cancellation and pending", async () => {
    const POST = await loadRoute();
    h.apply.mockResolvedValue({ id: "app_1" });
    const cases: Array<[string, { status: string; result: string | null }]> = [
      ["report.completed", { status: "complete", result: "consider" }],
      ["order.canceled", { status: "canceled", result: null }],
      ["report.updated", { status: "pending", result: null }],
    ];
    for (const [type, report] of cases) {
      h.fetchReport.mockResolvedValueOnce({ orderId: "ord_1", ...report });
      const body = JSON.stringify({ type, data: { order_id: "ord_1", status: "complete", result: "clear" } });
      expect((await post(POST, "proplane.ai", body, sign(body))).status).toBe(200);
      expect(h.apply).toHaveBeenLastCalledWith(expect.anything(), "ord_1", expect.objectContaining(report));
    }
  });

  it("acknowledges and ignores non-order events and unknown orders", async () => {
    const POST = await loadRoute();
    const other = JSON.stringify({ type: "candidate.created", data: { id: "c_1" } });
    expect(await (await post(POST, "proplane.ai", other, sign(other))).json()).toEqual({ ok: true, ignored: true });
    expect(h.fetchReport).not.toHaveBeenCalled();
    h.fetchReport.mockResolvedValue({ orderId: "ord_x", status: "complete", result: "clear" });
    h.apply.mockResolvedValue(null);
    const body = JSON.stringify({ type: "report.completed", data: { order_id: "ord_x" } });
    expect(await (await post(POST, "proplane.ai", body, sign(body))).json()).toEqual({ ok: true, ignored: true });
  });
});

describe("Checkr order status mapping", () => {
  it("only an explicit complete is complete; unknown stays pending", async () => {
    const { normalizeOrderStatus } = await import("@/lib/checkr/client");
    expect(normalizeOrderStatus("complete")).toBe("complete");
    expect(normalizeOrderStatus("Completed")).toBe("complete");
    expect(normalizeOrderStatus("canceled")).toBe("canceled");
    expect(normalizeOrderStatus("cancelled")).toBe("canceled");
    for (const v of ["pending", "processing", "", undefined, null, 5]) expect(normalizeOrderStatus(v)).toBe("pending");
  });
});

describe("applyBackgroundCheckReport is idempotent", () => {
  const completed = { provider: "checkr", candidateId: "a", reportId: "ord_1", packageSlug: "starter", status: "complete", result: "clear", orderedAt: "t0", completedAt: "t1" };
  const pending = { ...completed, status: "pending", result: null, completedAt: undefined };

  function db(backgroundCheck: Record<string, unknown>) {
    const upserts: Array<Record<string, unknown>> = [];
    const client = {
      from: (table: string) => ({
        select: () => ({
          eq: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: { application_id: "app-1" } }) }),
            maybeSingle: async () => ({ data: { id: "app-1", manager_user_id: "m", row_data: { id: "app-1", managerUserId: "m", email: "a@b.c", backgroundCheck } } }),
          }),
        }),
        upsert: async (row: Record<string, unknown>) => {
          upserts.push({ table, ...row });
          return { error: null };
        },
      }),
    };
    return { client: client as unknown as SupabaseClient, upserts };
  }

  it("completes a pending check once, and redelivery changes nothing", async () => {
    vi.resetModules();
    vi.doMock("@/lib/security/applicant-identity", () => ({ openApplicantRow: (r: unknown) => r, sealApplicantRow: (r: unknown) => r }));
    vi.doMock("@/lib/security/cosigner-repository", () => ({ loadOwnedCosignerRecord: vi.fn(), persistOwnedCosignerRecord: vi.fn() }));
    const { applyBackgroundCheckReport } = await import("@/lib/checkr/background-check");
    const first = db(pending);
    const row = await applyBackgroundCheckReport(first.client, "ord_1", { status: "complete", result: "clear" });
    expect(row?.backgroundCheck?.status).toBe("complete");
    expect(first.upserts.some((u) => u.table === "manager_application_records")).toBe(true);

    const again = db(completed);
    await applyBackgroundCheckReport(again.client, "ord_1", { status: "complete", result: "clear" });
    expect(again.upserts).toHaveLength(0);
    await applyBackgroundCheckReport(again.client, "ord_1", { status: "pending", result: null });
    expect(again.upserts).toHaveLength(0);
    vi.doUnmock("@/lib/security/applicant-identity");
    vi.doUnmock("@/lib/security/cosigner-repository");
  });
});
