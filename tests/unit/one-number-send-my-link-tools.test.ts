import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ charges: vi.fn(), listing: vi.fn() }));
vi.mock("@/lib/tools/domains/resident/balance", () => ({ loadOwnCharges: mocks.charges }));
vi.mock("@/lib/tools/domains/leasing-sms", () => ({ resolveLiveListingForSms: mocks.listing }));
vi.mock("@/lib/test-workspaces/index.server", () => ({
  resolveTestWorkspaceClassification: vi.fn(async () => ({ kind: "normal" })),
  lookupRecordTestWorkspaceId: vi.fn(async () => null),
}));

import {
  leasingSendMyLinkTool,
  mintLinkForTexter,
  residentSendMyLinkTool,
  vendorSendMyLinkTool,
} from "@/lib/tools/domains/one-number-links";
import { linksFakeDb, type Row } from "../helpers/links-fake-db";

const WS = "ws-a";
const sharedConfig = { singleton: true, line_mode: "shared", shared_number_e164: "+12065550100", shared_pilot_workspace_ids: [] };

function world(mode: "shared" | "per_workspace" = "shared", extra: Record<string, Row[]> = {}) {
  return linksFakeDb({
    sms_runtime_config: [{ ...sharedConfig, line_mode: mode }],
    portal_workspaces: [{ id: WS, owner_user_id: "owner-a", is_default: true }],
    manager_property_records: [{ id: "prop-1", workspace_id: WS, manager_user_id: "owner-a" }],
    profiles: [{ id: "res-1", phone: "(206) 555-0142", phone_verified_at: "2026-09-01T00:00:00Z" }],
    agent_sessions: [{ id: "sess-1", landlord_id: "owner-a", work_order_id: "wo-1", vendor_phone_e164: "+12065550177" }],
    portal_work_order_records: [{ id: "wo-1", manager_user_id: "owner-a", property_id: "prop-1", assigned_property_id: null }],
    ...extra,
  });
}

const residentCtx = (db: never, over: Record<string, unknown> = {}) =>
  ({ kind: "resident", userId: "res-1", email: "r@e.com", managerIds: ["owner-a"], activeManagerId: "owner-a", channel: "sms", phase: "approved", db, ...over }) as never;
const charge = (id: string, status = "pending", propertyId = "prop-1") => ({ id, status, propertyId });

beforeEach(() => {
  mocks.charges.mockReset();
  mocks.listing.mockReset();
});

describe("send_my_link: flag safety", () => {
  it("mints nothing while the workspace is not on the shared line", async () => {
    const { db, rows } = world("per_workspace");
    mocks.charges.mockResolvedValue([charge("c1")]);
    expect(await residentSendMyLinkTool.handler(residentCtx(db), { purpose: "rent" })).toEqual({ ok: false, error: "links_unavailable" });
    expect(rows.phone_bound_links ?? []).toHaveLength(0);
  });

  it("a pilot list that leaves the workspace out also mints nothing", async () => {
    const { db, rows } = world("shared");
    rows.sms_runtime_config![0]!.shared_pilot_workspace_ids = ["some-other-workspace"];
    mocks.charges.mockResolvedValue([charge("c1")]);
    expect(await residentSendMyLinkTool.handler(residentCtx(db), { purpose: "rent" })).toEqual({ ok: false, error: "links_unavailable" });
  });
});

describe("resident send_my_link", () => {
  it("mints a rent link for the texter's verified phone and their open charges", async () => {
    const { db, rows } = world();
    mocks.charges.mockResolvedValue([charge("c1"), charge("c2", "paid"), charge("c3", "failed")]);
    const result = await residentSendMyLinkTool.handler(residentCtx(db), { purpose: "rent" });
    expect(result).toMatchObject({ ok: true, purpose: "rent", requiresCode: true, expires: "10 days" });
    expect(result.ok && result.url).toMatch(/\/l\/[A-Za-z0-9_-]{43}$/);
    expect(rows.phone_bound_links![0]).toMatchObject({
      phone_key: "2065550142", purpose: "rent", target_type: "charge", target_id: "c1,c3", workspace_id: WS, requires_otp: true, created_by: "res-1",
    });
  });

  it("does nothing without a verified phone, off SMS, or with nothing owed", async () => {
    const { db, rows } = world();
    mocks.charges.mockResolvedValue([charge("c1")]);
    rows.profiles![0]!.phone_verified_at = null;
    expect(await residentSendMyLinkTool.handler(residentCtx(db), { purpose: "rent" })).toEqual({ ok: false, error: "nothing_to_link" });
    rows.profiles![0]!.phone_verified_at = "2026-09-01T00:00:00Z";
    expect(await residentSendMyLinkTool.handler(residentCtx(db, { channel: "portal" }), { purpose: "rent" })).toEqual({ ok: false, error: "links_unavailable" });
    mocks.charges.mockResolvedValue([charge("c2", "paid")]);
    expect(await residentSendMyLinkTool.handler(residentCtx(db), { purpose: "rent" })).toEqual({ ok: false, error: "nothing_to_link" });
    expect(rows.phone_bound_links ?? []).toHaveLength(0);
  });

  it("move-in and lease links are bound to the resident, with a code step", async () => {
    const { db, rows } = world();
    for (const purpose of ["move_in", "lease"] as const) {
      expect(await residentSendMyLinkTool.handler(residentCtx(db), { purpose })).toMatchObject({ ok: true, requiresCode: true });
    }
    expect(rows.phone_bound_links!.map((r) => r.purpose).sort()).toEqual(["lease", "move_in"]);
    expect(rows.phone_bound_links![0]).toMatchObject({ target_type: "resident", target_id: "res-1" });
  });

  it("accepts no phone or workspace from the model", () => {
    const parse = (input: unknown) => residentSendMyLinkTool.inputSchema.safeParse(input).success;
    expect(parse({ purpose: "rent" })).toBe(true);
    expect(parse({ purpose: "rent", phone: "2065550100" })).toBe(false);
    expect(parse({ purpose: "rent", workspaceId: WS })).toBe(false);
    expect(parse({ purpose: "payouts" })).toBe(false);
  });
});

describe("leasing send_my_link", () => {
  const prospectCtx = (db: never, over: Record<string, unknown> = {}) =>
    ({ landlordId: "owner-a", userId: "owner-a", email: "", roles: [], isAdmin: false, db, leasingScope: { sessionId: "s", prospectPhoneE164: "+12065550155", channel: "sms" }, ...over }) as never;

  it("mints gallery, tour and application links for the prospect's own phone", async () => {
    const { db, rows } = world();
    mocks.listing.mockResolvedValue("prop-1");
    for (const purpose of ["gallery", "tour", "application"] as const) {
      const result = await leasingSendMyLinkTool.handler(prospectCtx(db), { purpose, propertyId: "prop-1" });
      expect(result).toMatchObject({ ok: true, purpose, requiresCode: purpose === "application" });
    }
    expect(rows.phone_bound_links!.every((r) => r.phone_key === "2065550155" && r.target_id === "prop-1" && r.workspace_id === WS)).toBe(true);
  });

  it("refuses a listing the agent could not resolve, and a non-SMS or unscoped context", async () => {
    const { db, rows } = world();
    mocks.listing.mockResolvedValue(null);
    expect(await leasingSendMyLinkTool.handler(prospectCtx(db), { purpose: "gallery", propertyId: "prop-9" })).toEqual({ ok: false, error: "not_found" });
    mocks.listing.mockResolvedValue("prop-1");
    expect(await leasingSendMyLinkTool.handler(prospectCtx(db, { leasingScope: { sessionId: "s", prospectPhoneE164: "+12065550155", channel: "email" } }), { purpose: "gallery", propertyId: "prop-1" })).toEqual({ ok: false, error: "links_unavailable" });
    expect(await leasingSendMyLinkTool.handler(prospectCtx(db, { leasingScope: undefined }), { purpose: "gallery", propertyId: "prop-1" })).toEqual({ ok: false, error: "links_unavailable" });
    expect(rows.phone_bound_links ?? []).toHaveLength(0);
  });

  it("takes no phone from the model", () => {
    expect(leasingSendMyLinkTool.inputSchema.safeParse({ purpose: "gallery", propertyId: "p", phone: "2065550100" }).success).toBe(false);
  });
});

describe("vendor send_my_link", () => {
  const vendorCtx = (db: never, over: Record<string, unknown> = {}) =>
    ({ landlordId: "owner-a", userId: "v", email: "", roles: [], isAdmin: false, db, vendorScope: { sessionId: "sess-1", vendorDirectoryId: "vd", vendorUserId: null, workOrderId: "wo-1" }, ...over }) as never;

  it("mints a no-code job link for the session's own phone and work order", async () => {
    const { db, rows } = world();
    const result = await vendorSendMyLinkTool.handler(vendorCtx(db), { purpose: "job" });
    expect(result).toMatchObject({ ok: true, purpose: "job", requiresCode: false, expires: "until the job closes" });
    expect(rows.phone_bound_links![0]).toMatchObject({ phone_key: "2065550177", purpose: "job", target_type: "work_order", target_id: "wo-1", expires_at: null, requires_otp: false });
  });

  it("refuses a session that is not this landlord's or this job's", async () => {
    const { db, rows } = world();
    rows.agent_sessions![0]!.landlord_id = "someone-else";
    expect(await vendorSendMyLinkTool.handler(vendorCtx(db), { purpose: "job" })).toEqual({ ok: false, error: "nothing_to_link" });
    rows.agent_sessions![0]!.landlord_id = "owner-a";
    rows.agent_sessions![0]!.work_order_id = "wo-2";
    expect(await vendorSendMyLinkTool.handler(vendorCtx(db), { purpose: "job" })).toEqual({ ok: false, error: "nothing_to_link" });
    expect(await vendorSendMyLinkTool.handler(vendorCtx(db, { vendorScope: undefined }), { purpose: "job" })).toEqual({ ok: false, error: "links_unavailable" });
    expect(rows.phone_bound_links ?? []).toHaveLength(0);
  });
});

describe("mintLinkForTexter", () => {
  it("maps a per-phone mint cap to rate_limited", async () => {
    const { db } = world();
    let last;
    for (let i = 0; i < 22; i += 1) {
      last = await mintLinkForTexter(db, { workspaceId: WS, phone: "2065550166", purpose: "gallery", targetType: "listing", targetId: `p${i}`, createdBy: null });
    }
    expect(last).toEqual({ ok: false, error: "rate_limited" });
  });
});
