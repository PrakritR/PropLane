import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

type Row = Record<string, unknown>;

/** In-memory Supabase double: select/insert/update/delete with eq, neq, is, in, gt, order, limit and `a->>b` paths. */
function makeDb(tables: Record<string, Row[]>) {
  const pick = (row: Row, col: string): unknown => {
    if (col.includes("->>")) {
      const [base, key] = col.split("->>");
      return ((row[base!] ?? {}) as Row)[key!];
    }
    return row[col];
  };
  return {
    tables,
    auth: { admin: {} },
    from(name: string) {
      const rows = (tables[name] ??= []);
      const preds: Array<(r: Row) => boolean> = [];
      let op: "select" | "update" | "delete" = "select";
      let patch: Row = {};
      let lim = Infinity;
      const run = () => {
        const hit = rows.filter((r) => preds.every((p) => p(r))).slice(0, lim);
        if (op === "update") hit.forEach((r) => Object.assign(r, patch));
        if (op === "delete") hit.forEach((r) => rows.splice(rows.indexOf(r), 1));
        return hit;
      };
      const b: Record<string, unknown> = {
        select: () => b,
        update: (v: Row) => ((op = "update"), (patch = v), b),
        delete: () => ((op = "delete"), b),
        insert: async (v: Row | Row[]) => {
          for (const r of Array.isArray(v) ? v : [v]) rows.push({ id: `gen-${rows.length + 1}`, status: "pending", ...r });
          return { data: null, error: null };
        },
        upsert: async (v: Row | Row[]) => {
          for (const r of Array.isArray(v) ? v : [v]) {
            const at = rows.findIndex((x) => x.id !== undefined && x.id === r.id);
            if (at >= 0) Object.assign(rows[at]!, r);
            else rows.push({ ...r });
          }
          return { data: null, error: null };
        },
        eq: (c: string, v: unknown) => (preds.push((r) => pick(r, c) === v), b),
        neq: (c: string, v: unknown) => (preds.push((r) => pick(r, c) !== v), b),
        is: (c: string, v: unknown) => (preds.push((r) => (pick(r, c) ?? null) === v), b),
        in: (c: string, v: unknown[]) => (preds.push((r) => v.includes(pick(r, c))), b),
        // PostgREST `or` filter, limited to the `col.is.null` / `col.eq.value` terms the code uses.
        or: (expr: string) => {
          const terms = expr.split(",").map((t) => {
            const [col, op, ...rest] = t.split(".");
            const val = rest.join(".");
            return (r: Row) => (op === "is" && val === "null" ? (pick(r, col!) ?? null) === null : op === "eq" && String(pick(r, col!)) === val);
          });
          preds.push((r) => terms.some((t) => t(r)));
          return b;
        },
        gt: (c: string, v: string) => (preds.push((r) => String(pick(r, c)) > v), b),
        order: () => b,
        limit: (n: number) => ((lim = n), b),
        maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
        then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: run(), error: null }).then(resolve),
      };
      return b;
    },
  };
}

describe("O2 invite preview reuses the pending token", () => {
  it("previewing twice keeps the first token valid", async () => {
    const { createVendorInviteDraft } = await import("@/lib/vendor-invite.server");
    const db = makeDb({ manager_vendor_records: [{ id: "v1", manager_user_id: "mgrA" }], vendor_invites: [] });
    const opts = { managerUserId: "mgrA", managerName: "A", vendorId: "v1", vendorEmail: "v@x.com", vendorName: "V", origin: "https://x.test" };
    const first = await createVendorInviteDraft(db as never, opts);
    const second = await createVendorInviteDraft(db as never, opts);
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) expect(second.draft.linkUrl).toBe(first.draft.linkUrl);
    expect(db.tables.vendor_invites).toHaveLength(1);
  });

  it("mints a fresh token when the pending one is expired", async () => {
    const { createVendorInviteDraft } = await import("@/lib/vendor-invite.server");
    const db = makeDb({
      manager_vendor_records: [{ id: "v1", manager_user_id: "mgrA" }],
      vendor_invites: [{ id: "old", manager_user_id: "mgrA", vendor_directory_id: "v1", vendor_email: "v@x.com", status: "pending", invite_token: "OLD", expires_at: "2000-01-01T00:00:00Z" }],
    });
    const res = await createVendorInviteDraft(db as never, { managerUserId: "mgrA", managerName: "A", vendorId: "v1", vendorEmail: "v@x.com", vendorName: "V", origin: "https://x.test" });
    expect(res.ok && res.draft.linkUrl.includes("OLD")).toBe(false);
    expect(db.tables.vendor_invites).toHaveLength(1);
  });
});

describe("J2 linking back-fills only the inviting manager's records", () => {
  it("gives an assigned-before-signup service to the vendor, for that manager only", async () => {
    const { linkDirectoryRowToVendor } = await import("@/lib/auth/provision-vendor-account");
    const db = makeDb({
      manager_vendor_records: [{ id: "v1", manager_user_id: "mgrA", vendor_user_id: null }],
      work_order_vendor_offers: [],
      portal_work_order_records: [
        { id: "wo-a", manager_user_id: "mgrA", vendor_user_id: null, row_data: { vendorId: "v1" } },
        { id: "wo-self", manager_user_id: "mgrA", vendor_user_id: null, row_data: { vendorId: "v1", selfAssigned: true } },
        { id: "wo-b", manager_user_id: "mgrB", vendor_user_id: null, row_data: { vendorId: "v1" } },
        { id: "wo-other", manager_user_id: "mgrA", vendor_user_id: null, row_data: { vendorId: "v2" } },
      ],
    });
    await linkDirectoryRowToVendor(db as never, { directoryId: "v1", managerUserId: "mgrA", vendorUserId: "vend" });
    const byId = Object.fromEntries(db.tables.portal_work_order_records!.map((r) => [r.id as string, r.vendor_user_id]));
    expect(byId).toEqual({ "wo-a": "vend", "wo-self": null, "wo-b": null, "wo-other": null });
    expect(db.tables.manager_vendor_records![0]!.vendor_user_id).toBe("vend");
  });
});

describe("O1 a vendor link claims the manager's row", () => {
  const args = (db: unknown, assigned: string | null, owner = "mgrA") => ({
    db: db as never,
    link: { id: "l1", owner_user_id: owner, label: "Plumber", assigned_property_ids: [], assigned_room_id: null, vendor_directory_id: assigned },
    redeemerUserId: "vend",
    alreadyRedeemed: false,
    spendUse: async () => ({ ok: true as const }),
    releaseSpentUse: async () => {},
  });
  const seed = () =>
    makeDb({
      profiles: [{ id: "vend", email: "v@x.com", full_name: "Vee", role: "vendor" }],
      profile_roles: [],
      manager_invite_link_redemptions: [],
      manager_vendor_records: [
        { id: "rowA", manager_user_id: "mgrA", vendor_user_id: null, row_data: { id: "rowA", name: "Pat Plumbing", trade: "Plumbing", phone: "555", email: "" } },
        { id: "rowB", manager_user_id: "mgrB", vendor_user_id: null, row_data: { id: "rowB", name: "B's guy" } },
      ],
      work_order_vendor_offers: [],
      portal_work_order_records: [],
    });

  it("Add vendor then redeem leaves exactly one linked row with the manager's details", async () => {
    const { redeemVendorLink } = await import("@/lib/invite-links/invite-links.server");
    const db = seed();
    const res = await redeemVendorLink(args(db, "rowA"));
    expect(res.ok).toBe(true);
    const mine = db.tables.manager_vendor_records!.filter((r) => r.manager_user_id === "mgrA");
    expect(mine).toHaveLength(1);
    expect(mine[0]!.vendor_user_id).toBe("vend");
    expect((mine[0]!.row_data as Row).name).toBe("Pat Plumbing");
    expect((mine[0]!.row_data as Row).phone).toBe("555");
  });

  it("a link for manager A cannot link manager B's row", async () => {
    const { redeemVendorLink } = await import("@/lib/invite-links/invite-links.server");
    const db = seed();
    const res = await redeemVendorLink(args(db, "rowB", "mgrA"));
    expect(res.ok).toBe(false);
    expect(db.tables.manager_vendor_records!.find((r) => r.id === "rowB")!.vendor_user_id).toBeNull();
  });

  it("refuses a row another account already holds", async () => {
    const { redeemVendorLink } = await import("@/lib/invite-links/invite-links.server");
    const db = seed();
    db.tables.manager_vendor_records![0]!.vendor_user_id = "someone-else";
    const res = await redeemVendorLink(args(db, "rowA"));
    expect(res.ok).toBe(false);
    expect(db.tables.manager_vendor_records![0]!.vendor_user_id).toBe("someone-else");
  });

  it("a generic link (no target row) still inserts one row", async () => {
    const { redeemVendorLink } = await import("@/lib/invite-links/invite-links.server");
    const db = seed();
    const res = await redeemVendorLink(args(db, null));
    expect(res.ok).toBe(true);
    expect(db.tables.manager_vendor_records!.filter((r) => r.manager_user_id === "mgrA")).toHaveLength(2);
  });
});

const roleMocks = vi.hoisted(() => ({ requireVendorApiAccess: vi.fn() }));
describe("R1 /api/vendor/profile authorizes through profile_roles", () => {
  beforeEach(() => vi.resetModules());

  async function load() {
    vi.doMock("@/lib/auth/vendor-api-access", () => ({ requireVendorApiAccess: roleMocks.requireVendorApiAccess }));
    vi.doMock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => makeDb({ profiles: [{ id: "u1" }] }) }));
    vi.doMock("@/lib/vendor-own-record", () => ({ resolveOwnVendorRecord: async () => null }));
    vi.doMock("@/lib/analytics/posthog", () => ({ track: () => {} }));
    vi.doMock("@/lib/one-number/config.server", () => ({ loadSharedLineConfigStrict: async () => ({}) }));
    return import("@/app/api/vendor/profile/route");
  }

  it("a resident+vendor account gets 200", async () => {
    roleMocks.requireVendorApiAccess.mockResolvedValue({ ok: true, actor: { userId: "u1", roles: ["resident", "vendor"] } });
    const { GET } = await load();
    expect((await GET()).status).toBe(200);
  });

  it("an account with no vendor role gets 403", async () => {
    roleMocks.requireVendorApiAccess.mockResolvedValue({ ok: false, status: 403 });
    const { GET } = await load();
    expect((await GET()).status).toBe(403);
  });
});

const oauth = vi.hoisted(() => ({ provision: vi.fn(), claim: vi.fn(), release: vi.fn(), find: vi.fn() }));
describe("O2 OAuth path claims the invite", () => {
  beforeEach(() => {
    vi.resetModules();
    oauth.claim.mockReset();
    oauth.release.mockReset();
    oauth.provision.mockReset();
    oauth.find.mockResolvedValue({ id: "inv", manager_user_id: "mgrA", vendor_directory_id: "v1", vendor_email: "v@x.com", vendor_name: "V" });
  });
  async function load() {
    vi.doMock("@/lib/auth/account-recovery.server", () => ({ recoverySetupRedirect: async () => null }));
    vi.doMock("@/lib/analytics/posthog", () => ({ track: () => {} }));
    vi.doMock("@/lib/auth/provision-vendor-account", () => ({
      claimVendorInvite: oauth.claim,
      releaseVendorInvite: oauth.release,
      findPendingVendorInviteByToken: oauth.find,
      provisionVendorAccountByEmail: oauth.provision,
      vendorUnlinkedNotice: () => null,
    }));
    vi.doMock("@/lib/supabase/server", () => ({
      createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "u1", email: "v@x.com", user_metadata: {} } } }) } }),
    }));
    vi.doMock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({}) }));
    return import("@/app/api/auth/register-vendor-oauth/route");
  }
  const req = () => new Request("http://x.test", { method: "POST", body: JSON.stringify({ token: "tok" }) });

  it("claims before provisioning", async () => {
    oauth.claim.mockResolvedValue(true);
    oauth.provision.mockResolvedValue({ ok: true, axisId: "a", linkedManagerId: "mgrA", unlinkedReason: null });
    const { POST } = await load();
    expect((await POST(req())).status).toBe(200);
    expect(oauth.claim).toHaveBeenCalledWith(expect.anything(), "inv", "u1");
    expect(oauth.release).not.toHaveBeenCalled();
  });

  it("releases the invite when provisioning fails", async () => {
    oauth.claim.mockResolvedValue(true);
    oauth.provision.mockResolvedValue({ ok: false, status: 500, error: "boom" });
    const { POST } = await load();
    expect((await POST(req())).status).toBe(500);
    expect(oauth.release).toHaveBeenCalledWith(expect.anything(), "inv");
  });

  it("refuses a second redemption", async () => {
    oauth.claim.mockResolvedValue(false);
    const { POST } = await load();
    expect((await POST(req())).status).toBe(409);
    expect(oauth.provision).not.toHaveBeenCalled();
  });
});
