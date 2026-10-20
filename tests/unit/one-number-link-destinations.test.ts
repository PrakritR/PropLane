import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/test-workspaces/index.server", () => ({
  resolveTestWorkspaceClassification: vi.fn(async () => ({ kind: "normal" })),
  lookupRecordTestWorkspaceId: vi.fn(async () => null),
}));

import {
  propertyBelongsToWorkspace,
  portalSignInHref,
  residentPhoneMatches,
  resolveLinkDestination,
  resolveWorkspaceForProperty,
  workOrderJobClosed,
} from "@/lib/one-number/link-destinations.server";
import type { PhoneBoundLink } from "@/lib/one-number/links.server";
import { linksFakeDb } from "../helpers/links-fake-db";

const WS = "ws-a";
const OTHER_WS = "ws-b";
const PHONE = "2065550142";

const link = (over: Partial<PhoneBoundLink>): PhoneBoundLink => ({
  id: "link-1", phoneKey: PHONE, workspaceId: WS, purpose: "gallery", targetType: "listing", targetId: "prop-1",
  requiresOtp: false, expiresAt: null, usedAt: null, revokedAt: null, openCount: 0, createdBy: null, ...over,
});

const charge = (over: Record<string, unknown> = {}) => ({
  id: "chg-1", residentUserId: "res-1", residentEmail: "Res@Example.com", propertyId: "prop-1", title: "October rent",
  amountLabel: "$1,200.00", balanceLabel: "$1,200.00", propertyLabel: "5259 Brooklyn", status: "pending", ...over,
});

function world(extra: Record<string, Record<string, unknown>[]> = {}) {
  return linksFakeDb({
    portal_workspaces: [{ id: WS, owner_user_id: "owner-a", is_default: true }, { id: OTHER_WS, owner_user_id: "owner-b", is_default: true }],
    manager_property_records: [
      { id: "prop-1", workspace_id: WS, manager_user_id: "owner-a" },
      { id: "prop-b", workspace_id: OTHER_WS, manager_user_id: "owner-b" },
      { id: "prop-loose", workspace_id: null, manager_user_id: "owner-a" },
    ],
    profiles: [{ id: "res-1", phone: "(206) 555-0142" }],
    portal_household_charge_records: [{ id: "chg-1", status: "pending", row_data: charge() }],
    ...extra,
  });
}

describe("workspace membership", () => {
  it("a house names its workspace; a house with none belongs to its manager's default", async () => {
    const { db } = world();
    expect(await propertyBelongsToWorkspace(db, "prop-1", WS)).toBe(true);
    expect(await propertyBelongsToWorkspace(db, "prop-1", OTHER_WS)).toBe(false);
    expect(await propertyBelongsToWorkspace(db, "prop-loose", WS)).toBe(true);
    expect(await propertyBelongsToWorkspace(db, "prop-loose", OTHER_WS)).toBe(false);
    expect(await propertyBelongsToWorkspace(db, "missing", WS)).toBe(false);
    expect(await propertyBelongsToWorkspace(db, "prop-1", null)).toBe(false);
    expect(await resolveWorkspaceForProperty(db, "prop-1", "owner-a")).toBe(WS);
    expect(await resolveWorkspaceForProperty(db, "prop-loose", "owner-a")).toBe(WS);
    expect(await resolveWorkspaceForProperty(db, null, "owner-b")).toBe(OTHER_WS);
  });
});

describe("no-code destinations", () => {
  it("gallery goes to the public listing, tour to the tour page, application to the prefilled form", async () => {
    const { db } = world();
    expect(await resolveLinkDestination(db, link({ purpose: "gallery" }))).toEqual({ kind: "redirect", href: "/rent/listings/prop-1" });
    expect(await resolveLinkDestination(db, link({ purpose: "tour" }))).toEqual({ kind: "redirect", href: "/rent/tours-contact?propertyId=prop-1" });
    const apply = await resolveLinkDestination(db, link({ purpose: "application", requiresOtp: true }));
    expect(apply.kind).toBe("redirect");
    if (apply.kind === "redirect") {
      expect(apply.href).toContain("/rent/apply");
      expect(apply.href).toContain("propertyId=prop-1");
      expect(apply.href).toContain(`phone=${PHONE}`);
    }
  });

  it("a link for another workspace's house resolves to nothing", async () => {
    const { db } = world();
    for (const purpose of ["gallery", "tour", "application"] as const) {
      expect(await resolveLinkDestination(db, link({ purpose, targetId: "prop-b" }))).toEqual({ kind: "gone" });
    }
    expect(await resolveLinkDestination(db, link({ targetType: "charge" }))).toEqual({ kind: "gone" });
  });
});

describe("portal destinations", () => {
  it("lease, move-in and payouts continue through sign-in; the page never reaches into the record", async () => {
    const { db } = world();
    expect(await resolveLinkDestination(db, link({ purpose: "lease", targetType: "resident", targetId: "res-1" }))).toEqual({
      kind: "portal", href: portalSignInHref("/resident/lease"),
    });
    expect(await resolveLinkDestination(db, link({ purpose: "move_in", targetType: "resident", targetId: "res-1" }))).toEqual({
      kind: "portal", href: "/auth/sign-in?next=%2Fresident%2Fmove-in",
    });
    expect(await resolveLinkDestination(db, link({ purpose: "payouts", targetType: "vendor", targetId: "v" }))).toMatchObject({
      kind: "portal", href: "/auth/sign-in?next=%2Fvendor%2Ffinancials%2Fpayouts",
    });
  });
});

describe("rent destination", () => {
  const rent = (over: Partial<PhoneBoundLink> = {}) => link({ purpose: "rent", targetType: "charge", targetId: "chg-1", requiresOtp: true, ...over });

  it("shows the live charge to the resident whose phone this is", async () => {
    const { db } = world();
    const result = await resolveLinkDestination(db, rent());
    expect(result).toMatchObject({
      kind: "rent", chargeIds: ["chg-1"], residentUserId: "res-1", residentEmail: "res@example.com",
      charges: [{ id: "chg-1", title: "October rent", amountLabel: "$1,200.00", propertyLabel: "5259 Brooklyn" }],
    });
  });

  it("refuses when the phone is not the resident's, or the account has none on file", async () => {
    expect(await resolveLinkDestination(world().db, rent({ phoneKey: "2065550199" }))).toEqual({ kind: "gone" });
    const noPhone = world({ profiles: [{ id: "res-1", phone: null }] });
    expect(await resolveLinkDestination(noPhone.db, rent())).toEqual({ kind: "gone" });
    expect(await residentPhoneMatches(world().db, "res-1", PHONE)).toBe(true);
    expect(await residentPhoneMatches(world().db, "nobody", PHONE)).toBe(false);
  });

  it("refuses a charge from another workspace or another resident's batch", async () => {
    const { db } = world({
      portal_household_charge_records: [
        { id: "chg-1", status: "pending", row_data: charge() },
        { id: "chg-b", status: "pending", row_data: charge({ id: "chg-b", propertyId: "prop-b" }) },
        { id: "chg-other", status: "pending", row_data: charge({ id: "chg-other", residentUserId: "res-2" }) },
      ],
    });
    expect(await resolveLinkDestination(db, rent({ targetId: "chg-b" }))).toEqual({ kind: "gone" });
    expect(await resolveLinkDestination(db, rent({ targetId: "chg-1,chg-other" }))).toEqual({ kind: "gone" });
    expect(await resolveLinkDestination(db, rent({ targetId: "missing" }))).toEqual({ kind: "gone" });
  });

  it("a paid charge reads as paid, a clearing one as processing, a cancelled one as gone", async () => {
    // A bank debit in `processing` can still FAIL and become payable again, so it is not a receipt and the page
    // must not burn the link for it — this is the only link the resident has.
    const forStatus = (status: string) =>
      world({ portal_household_charge_records: [{ id: "chg-1", status, row_data: charge({ status }) }] });
    expect(await resolveLinkDestination(forStatus("paid").db, rent())).toEqual({ kind: "paid" });
    expect(await resolveLinkDestination(forStatus("processing").db, rent())).toEqual({ kind: "processing" });
    expect(await resolveLinkDestination(forStatus("cancelled").db, rent())).toEqual({ kind: "gone" });
  });

  it("a cart with one settled and one clearing charge still has nothing to pay, and still keeps the link", async () => {
    const { db } = world({
      portal_household_charge_records: [
        { id: "chg-1", status: "paid", row_data: charge({ status: "paid" }) },
        { id: "chg-2", status: "processing", row_data: charge({ id: "chg-2", status: "processing" }) },
      ],
    });
    expect(await resolveLinkDestination(db, rent({ targetId: "chg-1,chg-2" }))).toEqual({ kind: "processing" });
  });

  it("offers only the charges still owed when some are paid", async () => {
    const { db } = world({
      portal_household_charge_records: [
        { id: "chg-1", status: "paid", row_data: charge({ status: "paid" }) },
        { id: "chg-2", status: "pending", row_data: charge({ id: "chg-2", title: "Parking" }) },
      ],
    });
    const result = await resolveLinkDestination(db, rent({ targetId: "chg-1,chg-2" }));
    expect(result).toMatchObject({ kind: "rent", chargeIds: ["chg-2"] });
  });
});

describe("job destination", () => {
  const job = (over: Partial<PhoneBoundLink> = {}) => link({ purpose: "job", targetType: "work_order", targetId: "wo-1", createdBy: "owner-a", ...over });
  const order = (rowData: Record<string, unknown> = {}) => ({
    id: "wo-1", manager_user_id: "owner-a", property_id: "prop-1", assigned_property_id: null, row_data: { bucket: "assigned", ...rowData },
  });

  it("opens the vendor's job view on a hashed service link bound to this phone", async () => {
    const { db, rows } = world({ portal_work_order_records: [order()] });
    const result = await resolveLinkDestination(db, job());
    expect(result.kind).toBe("redirect");
    const href = result.kind === "redirect" ? result.href : "";
    expect(href).toMatch(/^\/s\/[A-Za-z0-9_-]{20,}$/);
    const stored = rows.service_share_links![0]!;
    expect(stored.recipient_phone).toBe("+12065550142");
    expect(stored.work_order_id).toBe("wo-1");
    // The service link is stored by hash: the raw token is not in the table.
    expect(JSON.stringify(rows.service_share_links)).not.toContain(href.slice(3));
  });

  it("opening again replaces the previous service link for this phone instead of stacking", async () => {
    const { db, rows } = world({ portal_work_order_records: [order()] });
    await resolveLinkDestination(db, job());
    await resolveLinkDestination(db, job());
    const live = rows.service_share_links!.filter((r) => !r.revoked_at);
    expect(live).toHaveLength(1);
  });

  it("a closed job closes its links", async () => {
    const closed = world({
      portal_work_order_records: [order({ bucket: "completed" })],
      phone_bound_links: [{ id: "link-1", target_type: "work_order", target_id: "wo-1", purpose: "job", revoked_at: null }],
    });
    expect(await resolveLinkDestination(closed.db, job())).toEqual({ kind: "gone" });
    expect(closed.rows.phone_bound_links![0]!.revoked_at).toBeTruthy();
    expect(workOrderJobClosed({ bucket: "completed" })).toBe(true);
    expect(workOrderJobClosed({ bucket: "assigned", automationStatus: "vendor_marked_done" })).toBe(true);
    expect(workOrderJobClosed({ bucket: "assigned" })).toBe(false);
    expect(workOrderJobClosed(null)).toBe(false);
  });

  it("refuses a job from another workspace or a missing one", async () => {
    const other = world({ portal_work_order_records: [{ ...order(), property_id: "prop-b" }] });
    expect(await resolveLinkDestination(other.db, job())).toEqual({ kind: "gone" });
    expect(await resolveLinkDestination(world().db, job())).toEqual({ kind: "gone" });
    expect(await resolveLinkDestination(world({ portal_work_order_records: [order()] }).db, job({ targetType: "charge" }))).toEqual({ kind: "gone" });
  });
});
