import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeOwnerDb, type FakeRow } from "../helpers/owner-fake-db";

const MGR = "mgr";
const WS = "ws-1";
const OWNER = "own-1";
const auth = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("@/lib/reports/auth", () => ({ getReportsAuthContext: async () => auth.value }));
vi.mock("@/lib/one-number/link-text.server", () => ({ sendWorkspacePhoneText: vi.fn(async () => true) }));
vi.mock("@/lib/manager-notice-email.server", () => ({ sendManagerNoticeEmail: vi.fn(async () => ({ status: "sent" })) }));
vi.mock("@/lib/owner-management/alerts.server", () => ({ alertManagerOfOwnerEvent: vi.fn(async () => true) }));
vi.mock("@/lib/reports/display-context", () => ({ loadManagerReportDisplayContext: vi.fn(async () => ({ propertyLabel: () => "House" })) }));

import { POST } from "@/app/api/portal/managed-finance/vendor-charge/route";

function setup(extra: Record<string, FakeRow[]> = {}) {
  const f = fakeOwnerDb(
    {
      managed_workspace_fee_policies: [{
        id: "pol-1", workspace_id: WS, owner_user_id: OWNER, status: "active", signed_at: "2026-01-01T00:00:00Z", owner_share_bps: 9000,
        applies_to: "rent", leasing_fee_bps: 0, min_fee_cents: 0, reserve_target_cents: 0, repair_approval_threshold_cents: 25_000,
        effective_from: "2026-01-01", accepted_via: "owner_signature", terms_sha256: "h", created_at: "2026-01-01",
      }],
      portal_workspaces: [{ id: WS, owner_user_id: MGR }],
      profiles: [{ id: "ven-1", full_name: "Mike", email: "m@x.test" }, { id: "rando", full_name: "Rando", email: "r@x.test" }, { id: MGR, full_name: "Mgr", email: "g@x.test" }],
      profile_roles: [{ user_id: "ven-1", role: "vendor" }, { user_id: "ven-2", role: "vendor" }, { user_id: MGR, role: "vendor" }, { user_id: "rando", role: "resident" }],
      manager_vendor_records: [{ id: "mv-1", manager_user_id: MGR, vendor_user_id: "ven-1" }, { id: "mv-9", manager_user_id: MGR, vendor_user_id: MGR }],
      owner_expenses: [],
      ...extra,
    },
    { rpc: { post_party_journal: () => ({ created: true, journal_id: "j-1" }) } },
  );
  auth.value = { role: "manager", userId: MGR, db: f.db };
  return f;
}

const call = (body: Record<string, unknown>) =>
  POST(new Request("http://x.test/api", { method: "POST", body: JSON.stringify({ workspaceId: WS, vendorUserId: "ven-1", amountCents: 10_000, title: "Cleaning", chargeKey: "key-12345678", ...body }) }));

beforeEach(() => { auth.value = null; });

describe("POST /api/portal/managed-finance/vendor-charge", () => {
  it("posts a charge for a vendor linked to the workspace", async () => {
    setup();
    const res = await call({});
    expect(res.status).toBe(200);
  });
  it("refuses a person who does not hold the vendor role (profile_roles)", async () => {
    const f = setup();
    const res = await call({ vendorUserId: "rando" });
    expect(res.status).toBe(403);
    expect(f.rpcCalls).toHaveLength(0);
  });
  it("refuses a vendor who is not on this workspace's roster", async () => {
    const f = setup();
    const res = await call({ vendorUserId: "ven-2" });
    expect(res.status).toBe(403);
    expect(f.rpcCalls).toHaveLength(0);
  });
  it("refuses self-dealing even when the caller holds a vendor role and a roster row", async () => {
    const f = setup();
    const res = await call({ vendorUserId: MGR });
    expect(res.status).toBe(403);
    expect(f.rpcCalls).toHaveLength(0);
  });
  it("past the day's auto-approve allowance the charge waits for the owner instead of posting", async () => {
    const f = setup({ owner_expenses: [{ id: "e1", workspace_id: WS, amount_cents: 100_000, decided_via: "auto", decided_at: new Date().toISOString(), status: "posted", source_type: "manual", source_id: "x" }] });
    const res = await call({ amountCents: 5_000 });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "pending_owner" });
    expect(f.rpcCalls).toHaveLength(0);
  });
});
