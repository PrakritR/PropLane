import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type Row } from "../helpers/fake-table-db";

const h = vi.hoisted(() => ({
  user: { id: "mgr-1" } as { id: string } | null,
  vendorAccess: { ok: false, status: 401 } as { ok: true; actor: { userId: string } } | { ok: false; status: number },
  sendResult: { ok: true } as { ok: boolean; error?: string },
  send: vi.fn(),
  db: null as unknown,
}));

vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: h.user } }) } }) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => h.db }));
vi.mock("@/lib/test-workspaces/index.server", () => ({
  resolveTestWorkspaceClassification: vi.fn(async () => ({ kind: "normal" })),
  lookupRecordTestWorkspaceId: vi.fn(async () => null),
  resolveAuthenticatedBusinessAccess: vi.fn(async () => ({ kind: "normal" })),
}));
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));
vi.mock("@/lib/app-url", () => ({ resolveEmailLinkBaseUrl: () => "https://proplane.test" }));
vi.mock("@/lib/twilio-provisioning", () => ({ resolveManagerWorkNumber: vi.fn(async () => "+12065550100") }));
vi.mock("@/lib/proplane-sms-transport.server", () => ({
  sendFromManagerWorkNumber: (args: unknown) => {
    h.send(args);
    return Promise.resolve(h.sendResult);
  },
}));
vi.mock("@/lib/auth/vendor-api-access", () => ({ requireVendorApiAccess: async () => h.vendorAccess }));

import { POST as sendRoute } from "@/app/api/portal/service-share-link/send/route";
import { GET as publicRoute } from "@/app/api/public/service-link/[token]/route";
import { GET as boardGet, POST as boardPost } from "@/app/api/vendor/work-board/route";
import { POST as redeemRoute } from "@/app/api/vendor/service-link/redeem/route";
import { POST as publishRoute } from "@/app/api/portal/service-publish/route";

function seed(): Record<string, Row[]> {
  return {
    portal_work_order_records: [
      {
        id: "wo-1",
        manager_user_id: "mgr-1",
        vendor_user_id: null,
        test_workspace_id: null,
        row_data: {
          id: "wo-1",
          title: "Kitchen sink leak",
          description: "Slow leak.",
          category: "plumbing",
          propertyName: "Alder House",
          propertyAddress: "1420 Alder St, Seattle, WA 98115",
          unit: "4B",
          status: "Open",
          bucket: "pending",
          preferredArrival: "weekdays",
        },
      },
    ],
    profiles: [{ id: "mgr-1", full_name: "Alder Property Co" }],
    service_share_links: [],
    vendor_business_profiles: [],
    manager_vendor_records: [],
    work_order_vendor_offers: [],
    work_order_bids: [],
  };
}

const json = (body: unknown, url = "http://localhost/x") =>
  new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeEach(() => {
  h.db = createFakeDb(seed());
  h.user = { id: "mgr-1" };
  h.sendResult = { ok: true };
  h.send.mockReset();
  h.vendorAccess = { ok: false, status: 401 };
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("SERVICE_LINK_SMS_SANDBOX", "");
});

const table = (name: string) => (h.db as { tables: Record<string, Row[]> }).tables[name]!;
const sendBody = { workOrderId: "wo-1", phone: "(425) 224-0508", recipientName: "Dima Handyman", sharePhotos: false, attestWorksWithVendor: true };

describe("POST /api/portal/service-share-link/send", () => {
  it("401 signed out, 403 for a service the caller does not own, and nothing is minted", async () => {
    h.user = null;
    expect((await sendRoute(json(sendBody))).status).toBe(401);
    h.user = { id: "someone-else" };
    expect((await sendRoute(json(sendBody))).status).toBe(403);
    expect(table("service_share_links")).toHaveLength(0);
    expect(h.send).not.toHaveBeenCalled();
  });

  it("requires a valid phone and the 'I work with this vendor' attestation", async () => {
    expect((await sendRoute(json({ ...sendBody, phone: "nope" }))).status).toBe(400);
    expect((await sendRoute(json({ ...sendBody, attestWorksWithVendor: false }))).status).toBe(400);
    expect(table("service_share_links")).toHaveLength(0);
    expect(h.send).not.toHaveBeenCalled();
  });

  it("mints a hashed link, texts it from the work number, and the text carries no address", async () => {
    const res = await sendRoute(json(sendBody));
    expect(res.status).toBe(200);
    expect(h.send).toHaveBeenCalledTimes(1);
    const sent = h.send.mock.calls[0]![0] as { to: string; text: string; managerUserId: string; fromNumber: string };
    expect(sent).toMatchObject({ to: "+14252240508", managerUserId: "mgr-1", fromNumber: "+12065550100" });
    expect(sent.text).toMatch(/^Hi Dima - Alder Property Co has a plumbing job in Seattle/);
    expect(sent.text).toMatch(/https:\/\/proplane\.test\/s\/[A-Za-z0-9_-]{32} - Reply STOP/);
    expect(sent.text).not.toMatch(/1420|Alder St|98115|4B/);
    const token = /\/s\/([A-Za-z0-9_-]{32})/.exec(sent.text)![1]!;
    const stored = table("service_share_links")[0]!;
    expect(stored.token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(stored.texted_at).toBeTruthy();
    expect(stored.recipient_phone).toBe("+14252240508");
  });

  it("revokes the link when the text could not be sent, and says so plainly for an opted-out number", async () => {
    h.sendResult = { ok: false, error: "recipient_opted_out" };
    const res = await sendRoute(json(sendBody));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/opted out/);
    expect(table("service_share_links")[0]!.revoked_at).toBeTruthy();
  });

  it("refuses a service that already has a vendor", async () => {
    table("portal_work_order_records")[0]!.vendor_user_id = "hired";
    expect((await sendRoute(json(sendBody))).status).toBe(409);
    expect(h.send).not.toHaveBeenCalled();
  });

  it("revoke kills the live links", async () => {
    await sendRoute(json(sendBody));
    const res = await sendRoute(json({ workOrderId: "wo-1", revoke: true }));
    expect(((await res.json()) as { revoked: number }).revoked).toBe(1);
  });

  it("the daily per-manager cap stops further texts", async () => {
    h.user = { id: "mgr-cap" };
    table("portal_work_order_records")[0]!.manager_user_id = "mgr-cap";
    // Each send uses a fresh link; the cap is per manager per day, not per service.
    let status = 200;
    for (let i = 0; i < 26 && status === 200; i += 1) {
      // keep the per-service live-link cap from tripping first
      table("service_share_links").length = 0;
      status = (await sendRoute(json(sendBody))).status;
    }
    expect(status).toBe(429);
    expect(h.send).toHaveBeenCalledTimes(25);
  });

  it("sandbox mode (dev + flag) captures instead of delivering and says what it would have sent", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SERVICE_LINK_SMS_SANDBOX", "1");
    const res = await sendRoute(json(sendBody));
    const body = (await res.json()) as { sandbox?: { to: string; text: string } };
    expect(res.status).toBe(200);
    expect(body.sandbox?.to).toBe("+14252240508");
    expect(body.sandbox?.text).toContain("/s/");
  });

  it("the sandbox flag does nothing outside development", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SERVICE_LINK_SMS_SANDBOX", "1");
    const res = await sendRoute(json(sendBody));
    expect(((await res.json()) as { sandbox?: unknown }).sandbox).toBeUndefined();
  });
});

describe("GET /api/public/service-link/[token]", () => {
  const ctx = (token: string) => ({ params: Promise.resolve({ token }) });
  const get = (token: string, ip = `10.0.0.${Math.floor(Math.random() * 250)}`) =>
    publicRoute(new Request("http://localhost/x", { headers: { "x-forwarded-for": ip } }), ctx(token));

  it("signed out it returns the allowlisted job - no address, unit, resident or ids - with noindex and no-store", async () => {
    await sendRoute(json(sendBody));
    const token = /\/s\/([A-Za-z0-9_-]{32})/.exec((h.send.mock.calls[0]![0] as { text: string }).text)![1]!;
    const res = await get(token);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-robots-tag")).toMatch(/noindex/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toMatchObject({ state: "open", service: { title: "Kitchen sink leak", trade: "Plumbing", area: "Seattle", postedBy: "Alder Property Co" } });
    expect(JSON.stringify(body)).not.toMatch(/1420|Alder St|98115|4B|wo-1|mgr-1/);
  });

  it("an unknown, expired and revoked token all answer the same 404", async () => {
    const unknown = await get("z".repeat(32));
    await sendRoute(json(sendBody));
    const token = /\/s\/([A-Za-z0-9_-]{32})/.exec((h.send.mock.calls[0]![0] as { text: string }).text)![1]!;
    table("service_share_links")[0]!.expires_at = "2020-01-01T00:00:00Z";
    const expired = await get(token);
    table("service_share_links")[0]!.expires_at = "2099-01-01T00:00:00Z";
    table("service_share_links")[0]!.revoked_at = new Date().toISOString();
    const revoked = await get(token);
    const bodies: unknown[] = [];
    for (const res of [unknown, expired, revoked]) {
      expect(res.status).toBe(404);
      bodies.push(await res.json());
    }
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
  });

  it("throttles one IP", async () => {
    const ip = "198.51.100.9";
    let last = 200;
    for (let i = 0; i < 40 && last !== 429; i += 1) last = (await get(`${"a".repeat(31)}${i % 10}`, ip)).status;
    expect(last).toBe(429);
  });
});

describe("vendor routes are signed-in vendors only", () => {
  it("Find work and requesting a job answer 401 signed out and 403 for a non-vendor", async () => {
    expect((await boardGet(new Request("http://localhost/api/vendor/work-board"))).status).toBe(401);
    expect((await boardPost(json({ ref: `pub_${"a".repeat(32)}` }))).status).toBe(401);
    expect((await redeemRoute(json({ token: "x".repeat(32) }))).status).toBe(401);
    h.vendorAccess = { ok: false, status: 403 };
    expect((await boardGet(new Request("http://localhost/api/vendor/work-board"))).status).toBe(403);
  });

  it("a signed-in vendor with no published services gets an empty board", async () => {
    h.vendorAccess = { ok: true, actor: { userId: "vendor-1" } };
    const res = await boardGet(new Request("http://localhost/api/vendor/work-board"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ services: [] });
  });
});

describe("POST /api/portal/service-publish", () => {
  it("publishes for the owner, refuses a stranger, and unpublishes", async () => {
    const ok = await publishRoute(json({ workOrderId: "wo-1", action: "publish", budgetCents: 25000, sharePhotos: false }));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { patch: { publishRef: string } }).patch.publishRef).toMatch(/^pub_/);
    expect((table("portal_work_order_records")[0]!.row_data as Row).published).toBe(true);
    const off = await publishRoute(json({ workOrderId: "wo-1", action: "unpublish" }));
    expect(off.status).toBe(200);
    expect((table("portal_work_order_records")[0]!.row_data as Row).published).toBe(false);
    h.user = { id: "someone-else" };
    expect((await publishRoute(json({ workOrderId: "wo-1", action: "publish" }))).status).toBe(403);
  });
});
