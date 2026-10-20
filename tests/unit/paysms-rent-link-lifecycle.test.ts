// A rent link ends when its charges are PAID (webhook confirmation), a lease / move-in link opens a portal
// session for a verified phone instead of a second sign-in, and a changed phone refuses the old link.
import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ mint: vi.fn(), owners: vi.fn() }));
vi.mock("@/lib/auth/phone-auth.server", () => ({ mintPhoneSession: auth.mint, phoneOwners: auth.owners }));
vi.mock("@/lib/auth/sms-proven-session.server", () => ({ smsProvenSessionAllowed: async () => true }));
vi.mock("@/lib/test-workspaces/index.server", () => ({
  resolveTestWorkspaceClassification: vi.fn(async () => ({ kind: "normal" })),
  lookupRecordTestWorkspaceId: vi.fn(async () => null),
}));

import { mintResidentPortalSessionForLink } from "@/lib/one-number/link-portal-session.server";
import { settlePhoneBoundRentLinks } from "@/lib/one-number/links.server";
import { linksFakeDb } from "../helpers/links-fake-db";

const rentLink = (id: string, targetId: string, over: Record<string, unknown> = {}) => ({
  id, purpose: "rent", target_type: "charge", target_id: targetId, phone_key: "2065550142", used_at: null, revoked_at: null, ...over,
});

describe("settlePhoneBoundRentLinks", () => {
  it("ends a link when its only charge is paid", async () => {
    const { db, rows } = linksFakeDb({
      phone_bound_links: [rentLink("l1", "c1")],
      portal_household_charge_records: [{ id: "c1", status: "paid" }],
    });
    expect(await settlePhoneBoundRentLinks(db, ["c1"])).toBe(1);
    expect(rows.phone_bound_links![0]!.used_at).toBeTruthy();
  });

  it("never ends a link on a charge that is only processing, pending or part-paid", async () => {
    for (const status of ["processing", "pending", "partially_paid", "failed"]) {
      const { db, rows } = linksFakeDb({
        phone_bound_links: [rentLink("l1", "c1")],
        portal_household_charge_records: [{ id: "c1", status }],
      });
      expect(await settlePhoneBoundRentLinks(db, ["c1"])).toBe(0);
      expect(rows.phone_bound_links![0]!.used_at).toBeNull();
    }
  });

  it("a link naming several charges ends only when every one is paid", async () => {
    const { db, rows } = linksFakeDb({
      phone_bound_links: [rentLink("l1", "c1,c2")],
      portal_household_charge_records: [{ id: "c1", status: "paid" }, { id: "c2", status: "pending" }],
    });
    expect(await settlePhoneBoundRentLinks(db, ["c1"])).toBe(0);
    rows.portal_household_charge_records![1]!.status = "paid";
    expect(await settlePhoneBoundRentLinks(db, ["c2"])).toBe(1);
    expect(rows.phone_bound_links![0]!.used_at).toBeTruthy();
  });

  it("leaves other purposes, other charges and already-ended links alone", async () => {
    const { db, rows } = linksFakeDb({
      phone_bound_links: [
        rentLink("other-charge", "c9"),
        rentLink("lease", "c1", { purpose: "lease" }),
        rentLink("done", "c1", { used_at: "2026-10-01T00:00:00Z" }),
        rentLink("revoked", "c1", { revoked_at: "2026-10-01T00:00:00Z" }),
        rentLink("prefix", "c10"),
      ],
      portal_household_charge_records: [{ id: "c1", status: "paid" }, { id: "c9", status: "pending" }, { id: "c10", status: "pending" }],
    });
    expect(await settlePhoneBoundRentLinks(db, ["c1"])).toBe(0);
    expect(rows.phone_bound_links!.filter((l) => l.used_at && l.id !== "done")).toHaveLength(0);
  });

  it("is a no-op for nothing to settle or an odd id", async () => {
    const { db } = linksFakeDb({ phone_bound_links: [], portal_household_charge_records: [] });
    expect(await settlePhoneBoundRentLinks(db, [])).toBe(0);
    expect(await settlePhoneBoundRentLinks(db, ["%", "a,b"])).toBe(0);
  });
});

describe("mintResidentPortalSessionForLink", () => {
  const LEASE = { purpose: "lease" as const, targetType: "resident", targetId: "res-1", phoneKey: "2065550142" };
  const world = (over: Record<string, unknown> = {}) => {
    const w = linksFakeDb({
      profiles: [{ id: "res-1", phone: "(206) 555-0142", phone_verified_at: "2026-09-01T00:00:00Z", ...over }],
    });
    (w.db as unknown as { auth: unknown }).auth = {
      admin: { getUserById: vi.fn(async () => ({ data: { user: { id: "res-1", email: "r@example.com" } }, error: null })) },
    };
    return w;
  };

  beforeEach(() => {
    auth.mint.mockReset().mockResolvedValue({ access_token: "a", refresh_token: "r" });
    auth.owners.mockReset().mockResolvedValue(["res-1"]);
  });

  it("opens a session for a lease or move-in link to a resident whose verified phone is the link's", async () => {
    expect(await mintResidentPortalSessionForLink(world().db, LEASE)).toEqual({ access_token: "a", refresh_token: "r" });
    expect(await mintResidentPortalSessionForLink(world().db, { ...LEASE, purpose: "move_in" })).toEqual({ access_token: "a", refresh_token: "r" });
  });

  it("never for money or payouts links, a non-resident target, or a phone the account no longer holds", async () => {
    expect(await mintResidentPortalSessionForLink(world().db, { ...LEASE, purpose: "rent" as never })).toBeNull();
    expect(await mintResidentPortalSessionForLink(world().db, { ...LEASE, purpose: "payouts" as never })).toBeNull();
    expect(await mintResidentPortalSessionForLink(world().db, { ...LEASE, targetType: "vendor" })).toBeNull();
    expect(await mintResidentPortalSessionForLink(world().db, { ...LEASE, phoneKey: "2065550199" })).toBeNull();
    expect(await mintResidentPortalSessionForLink(world({ phone_verified_at: null }).db, LEASE)).toBeNull();
    expect(auth.mint).not.toHaveBeenCalled();
  });

  it("not when the phone belongs to more than one account or to someone else", async () => {
    auth.owners.mockResolvedValue(["res-1", "res-2"]);
    expect(await mintResidentPortalSessionForLink(world().db, LEASE)).toBeNull();
    auth.owners.mockResolvedValue(["res-2"]);
    expect(await mintResidentPortalSessionForLink(world().db, LEASE)).toBeNull();
    expect(auth.mint).not.toHaveBeenCalled();
  });

  it("falls back to the ordinary sign-in on any failure, and for an account with no real email", async () => {
    auth.mint.mockRejectedValue(new Error("down"));
    expect(await mintResidentPortalSessionForLink(world().db, LEASE)).toBeNull();
    auth.mint.mockResolvedValue({ access_token: "a", refresh_token: "r" });
    const w = world();
    (w.db as unknown as { auth: { admin: { getUserById: unknown } } }).auth.admin.getUserById = vi.fn(async () => ({
      data: { user: { id: "res-1", email: "x@phone.proplane.invalid" } }, error: null,
    }));
    expect(await mintResidentPortalSessionForLink(w.db, LEASE)).toBeNull();
  });
});
