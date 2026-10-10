import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type Row } from "../helpers/fake-table-db";

vi.mock("@/lib/test-workspaces/index.server", () => ({
  resolveTestWorkspaceClassification: vi.fn(async () => ({ kind: "normal" })),
  lookupRecordTestWorkspaceId: vi.fn(async () => null),
}));
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));

import {
  BOARD_REQUESTS_PER_VENDOR_PER_HOUR,
  MAX_BOARD_REQUESTS_PER_SERVICE,
  listBoardServices,
  publishServiceToBoard,
  redeemServiceShareLink,
  requestBoardJob,
  resolvePublicServiceByToken,
  revealHeldVendorContact,
  serviceLinkPhoneVerificationHook,
  unpublishServiceFromBoard,
} from "@/lib/service-work-board.server";
import { createServiceShareLink } from "@/lib/service-share-links.server";
import { submitWorkOrderBid } from "@/lib/work-order-bids.server";

type Db = Parameters<typeof listBoardServices>[0];
let db: ReturnType<typeof createFakeDb>;
const asDb = () => db as unknown as Db;

const MANAGER = "mgr-1";
const VENDOR = "vendor-1";
const ACTOR = { userId: MANAGER, role: "manager", admin: false };

function service(overrides: Partial<Row> = {}, rowData: Row = {}): Row {
  return {
    id: "wo-1",
    manager_user_id: MANAGER,
    vendor_user_id: null,
    test_workspace_id: null,
    updated_at: "2026-10-06T10:00:00Z",
    row_data: {
      id: "wo-1",
      title: "Kitchen sink leak",
      description: "Slow leak.",
      category: "plumbing",
      propertyName: "Alder House",
      propertyAddress: "1420 Alder St, Seattle, WA 98115",
      unit: "4B",
      residentName: "SECRET RESIDENT",
      status: "Open",
      bucket: "pending",
      ...rowData,
    },
    ...overrides,
  };
}

function vendorProfile(userId: string, overrides: Row = {}): Row {
  return {
    user_id: userId,
    business_name: `Business ${userId}`,
    work_email: `${userId}@vendor.test`,
    work_phone: "+12065550142",
    trades: ["Plumbing"],
    service_area_zips: ["98115"],
    service_radius_miles: 25,
    onboarding_completed_at: "2026-09-01T00:00:00Z",
    directory_listed: true,
    license_number: null,
    ...overrides,
  };
}

beforeEach(() => {
  db = createFakeDb({
    portal_work_order_records: [service()],
    vendor_business_profiles: [vendorProfile(VENDOR), vendorProfile("vendor-2")],
    manager_vendor_records: [],
    work_order_vendor_offers: [],
    work_order_bids: [],
    profiles: [
      { id: MANAGER, full_name: "Alder Property Co", email: "mgr@example.com" },
      { id: VENDOR, full_name: "Vee Vendor", email: "vee@vendor.test", phone: "+12065550199" },
    ],
    service_share_links: [],
  });
});

async function publish(budgetCents: number | null = 25000, sharePhotos = false) {
  const result = await publishServiceToBoard(asDb(), ACTOR, { workOrderId: "wo-1", budgetCents, sharePhotos });
  if (!result.ok) throw new Error(result.error);
  return result.patch;
}

describe("publish / unpublish", () => {
  it("publishes with an opaque ref, opens bidding, and keeps the ref on re-publish", async () => {
    const patch = await publish();
    expect(patch.published).toBe(true);
    expect(patch.publishRef).toMatch(/^pub_[a-f0-9]{32}$/);
    expect(patch.biddingOpen).toBe(true);
    const stored = db.tables.portal_work_order_records![0]!.row_data as Row;
    expect(stored.published).toBe(true);
    expect(stored.publishBudgetCents).toBe(25000);
    expect((await publish()).publishRef).toBe(patch.publishRef);
  });

  it("only the owning manager may publish", async () => {
    const result = await publishServiceToBoard(asDb(), { userId: "other", role: "manager", admin: false }, { workOrderId: "wo-1" });
    expect(result).toMatchObject({ ok: false, status: 403 });
    expect(await publishServiceToBoard(asDb(), { userId: VENDOR, role: "vendor", admin: false }, { workOrderId: "wo-1" })).toMatchObject({ ok: false, status: 403 });
  });

  it("refuses a hired service and one with an approved bid", async () => {
    db.tables.portal_work_order_records![0]!.vendor_user_id = "someone";
    expect(await publishServiceToBoard(asDb(), ACTOR, { workOrderId: "wo-1" })).toMatchObject({ ok: false, status: 409 });
    db.tables.portal_work_order_records![0]!.vendor_user_id = null;
    db.tables.work_order_bids!.push({ id: "b1", work_order_id: "wo-1", status: "accepted" });
    expect(await publishServiceToBoard(asDb(), ACTOR, { workOrderId: "wo-1" })).toMatchObject({ ok: false, status: 409 });
  });

  it("unpublish clears the flag", async () => {
    await publish();
    expect(await unpublishServiceFromBoard(asDb(), ACTOR, { workOrderId: "wo-1" })).toEqual({ ok: true });
    expect((db.tables.portal_work_order_records![0]!.row_data as Row).published).toBe(false);
  });
});

describe("Find work (the board list)", () => {
  it("lists only published services, as the allowlist view with no address or id", async () => {
    db.tables.portal_work_order_records!.push(service({ id: "wo-2" }, { id: "wo-2", title: "Unpublished job" }));
    await publish();
    const result = await listBoardServices(asDb(), VENDOR);
    expect(result.ok && result.services.map((s) => s.title)).toEqual(["Kitchen sink leak"]);
    // The ref is a random hex id by construction (asserted on publish), so it is left out of the
    // leak scan - a chance "1420" inside it is not a leaked address.
    expect(result.ok && result.services[0]?.ref).toMatch(/^pub_[a-f0-9]{32}$/);
    const wire = JSON.stringify(result, (key, value) => (key === "ref" ? undefined : value));
    for (const secret of ["1420", "Alder St", "4B", "SECRET RESIDENT", "wo-1", MANAGER]) expect(wire).not.toContain(secret);
    expect(result.ok && result.services[0]).toMatchObject({ trade: "Plumbing", area: "Seattle", budget: "Up to $250", postedBy: "Alder Property Co" });
  });

  it("hides a service after unpublish and after hire", async () => {
    await publish();
    await unpublishServiceFromBoard(asDb(), ACTOR, { workOrderId: "wo-1" });
    expect(await listBoardServices(asDb(), VENDOR)).toEqual({ ok: true, services: [] });
    await publish();
    expect((await listBoardServices(asDb(), VENDOR)).ok && (await listBoardServices(asDb(), VENDOR) as { services: unknown[] }).services).toHaveLength(1);
    db.tables.portal_work_order_records![0]!.vendor_user_id = "hired-vendor";
    expect(await listBoardServices(asDb(), VENDOR)).toEqual({ ok: true, services: [] });
  });

  it("filters by trade and by service area", async () => {
    await publish();
    db.tables.vendor_business_profiles![1]!.trades = ["Electrical"];
    expect(await listBoardServices(asDb(), "vendor-2")).toEqual({ ok: true, services: [] });
    db.tables.vendor_business_profiles![1]!.trades = ["Plumbing"];
    db.tables.vendor_business_profiles![1]!.service_area_zips = ["33101"];
    expect(await listBoardServices(asDb(), "vendor-2")).toEqual({ ok: true, services: [] });
    const filtered = await listBoardServices(asDb(), VENDOR, { trade: "electrical" });
    expect(filtered).toEqual({ ok: true, services: [] });
  });

  it("an un-onboarded vendor (no service area or not finished) sees nothing", async () => {
    await publish();
    db.tables.vendor_business_profiles![1]!.service_area_zips = [];
    expect(await listBoardServices(asDb(), "vendor-2")).toEqual({ ok: true, services: [] });
    db.tables.vendor_business_profiles![1]!.service_area_zips = ["98115"];
    db.tables.vendor_business_profiles![1]!.onboarding_completed_at = null;
    expect(await listBoardServices(asDb(), "vendor-2")).toEqual({ ok: true, services: [] });
  });

  it("license and insurance are NOT required (Decide #2)", async () => {
    await publish();
    const result = await listBoardServices(asDb(), VENDOR);
    expect(result.ok && result.services).toHaveLength(1);
  });

  it("a service the vendor already holds an offer on is theirs under Open, not on the board", async () => {
    const patch = await publish();
    const requested = await requestBoardJob(asDb(), { userId: VENDOR, role: "vendor" }, { ref: patch.publishRef! });
    expect(requested.ok).toBe(true);
    expect(await listBoardServices(asDb(), VENDOR)).toEqual({ ok: true, services: [] });
  });
});

describe("requesting a board job", () => {
  it("creates a held roster row and a sent offer, and opens nothing else", async () => {
    const patch = await publish();
    const result = await requestBoardJob(asDb(), { userId: VENDOR, role: "vendor" }, { ref: patch.publishRef!, choice: "estimate" });
    expect(result).toEqual({ ok: true, workOrderId: "wo-1", choice: "estimate" });
    const roster = db.tables.manager_vendor_records![0]!;
    expect(roster).toMatchObject({ manager_user_id: MANAGER, vendor_user_id: VENDOR });
    expect(roster.row_data).toMatchObject({ origin: "work_board", contactHeldUntilBid: true, phone: "", email: "" });
    expect(db.tables.work_order_vendor_offers![0]).toMatchObject({ work_order_id: "wo-1", vendor_user_id: VENDOR, status: "sent" });
    expect(db.tables.work_order_bids).toHaveLength(0);
  });

  it("is idempotent for the same vendor", async () => {
    const patch = await publish();
    await requestBoardJob(asDb(), { userId: VENDOR, role: "vendor" }, { ref: patch.publishRef! });
    await requestBoardJob(asDb(), { userId: VENDOR, role: "vendor" }, { ref: patch.publishRef! });
    expect(db.tables.work_order_vendor_offers).toHaveLength(1);
    expect(db.tables.manager_vendor_records).toHaveLength(1);
  });

  it("refuses a ref that is not published / unknown / malformed / not a vendor", async () => {
    const patch = await publish();
    const vendor = { userId: VENDOR, role: "vendor" };
    expect(await requestBoardJob(asDb(), vendor, { ref: "wo-1" })).toMatchObject({ ok: false, status: 404 });
    expect(await requestBoardJob(asDb(), vendor, { ref: `pub_${"b".repeat(32)}` })).toMatchObject({ ok: false, status: 404 });
    expect(await requestBoardJob(asDb(), { userId: MANAGER, role: "manager" }, { ref: patch.publishRef! })).toMatchObject({ ok: false, status: 403 });
    await unpublishServiceFromBoard(asDb(), ACTOR, { workOrderId: "wo-1" });
    expect(await requestBoardJob(asDb(), vendor, { ref: patch.publishRef! })).toMatchObject({ ok: false, status: 404 });
  });

  it("refuses an out-of-area / wrong-trade vendor even with a valid ref", async () => {
    const patch = await publish();
    db.tables.vendor_business_profiles![1]!.trades = ["Electrical"];
    expect(await requestBoardJob(asDb(), { userId: "vendor-2", role: "vendor" }, { ref: patch.publishRef! })).toMatchObject({ ok: false, status: 404 });
  });

  it("refuses a vendor who is not onboarded", async () => {
    const patch = await publish();
    db.tables.vendor_business_profiles![1]!.onboarding_completed_at = null;
    expect(await requestBoardJob(asDb(), { userId: "vendor-2", role: "vendor" }, { ref: patch.publishRef! })).toMatchObject({ ok: false, status: 403 });
  });

  it("will not let a vendor re-request after the manager removed their request", async () => {
    const patch = await publish();
    await requestBoardJob(asDb(), { userId: VENDOR, role: "vendor" }, { ref: patch.publishRef! });
    db.tables.work_order_vendor_offers![0]!.status = "withdrawn";
    expect(await requestBoardJob(asDb(), { userId: VENDOR, role: "vendor" }, { ref: patch.publishRef! })).toMatchObject({ ok: false, status: 403 });
  });

  it("caps requests per service", async () => {
    const patch = await publish();
    for (let i = 0; i < MAX_BOARD_REQUESTS_PER_SERVICE; i += 1) {
      db.tables.work_order_vendor_offers!.push({ id: `o${i}`, work_order_id: "wo-1", vendor_directory_id: `d${i}`, status: "sent" });
    }
    expect(await requestBoardJob(asDb(), { userId: VENDOR, role: "vendor" }, { ref: patch.publishRef! })).toMatchObject({ ok: false, status: 409 });
  });

  it("rate-limits one vendor across services", async () => {
    const patch = await publish();
    const vendorId = `vendor-rl-${Math.random()}`;
    db.tables.vendor_business_profiles!.push(vendorProfile(vendorId));
    let last: { ok: boolean; status?: number } = { ok: true };
    for (let i = 0; i <= BOARD_REQUESTS_PER_VENDOR_PER_HOUR; i += 1) {
      last = await requestBoardJob(asDb(), { userId: vendorId, role: "vendor" }, { ref: patch.publishRef! });
    }
    expect(last).toMatchObject({ ok: false, status: 429 });
  });
});

describe("contact is held until the vendor bids (Decide #3)", () => {
  it("the manager's roster row has no phone or email until a bid is submitted", async () => {
    const patch = await publish();
    await requestBoardJob(asDb(), { userId: VENDOR, role: "vendor" }, { ref: patch.publishRef! });
    expect(db.tables.manager_vendor_records![0]!.row_data).toMatchObject({ phone: "", email: "", contactHeldUntilBid: true });

    // An estimate / message is not a bid: still held.
    await revealHeldVendorContact(asDb(), { vendorUserId: "someone-else", managerUserId: MANAGER });
    expect(db.tables.manager_vendor_records![0]!.row_data).toMatchObject({ contactHeldUntilBid: true });

    const bid = await submitWorkOrderBid(
      asDb(),
      { userId: VENDOR, email: "vee@vendor.test", fullName: "Vee", admin: false, role: "vendor" },
      { workOrderId: "wo-1", amountCents: 18000, materialsCents: 0, proposedTime: "2026-10-09T17:00:00Z" },
    );
    expect(bid).toEqual({ ok: true });
    expect(db.tables.manager_vendor_records![0]!.row_data).toMatchObject({
      phone: "+12065550142",
      email: "vendor-1@vendor.test",
      contactHeldUntilBid: false,
    });
  });

  it("an approved-vendor roster row that was never held is untouched", async () => {
    db.tables.manager_vendor_records!.push({ id: "d1", manager_user_id: MANAGER, vendor_user_id: VENDOR, row_data: { name: "Mine", phone: "555", email: "m@x.test" } });
    await revealHeldVendorContact(asDb(), { vendorUserId: VENDOR, managerUserId: MANAGER });
    expect(db.tables.manager_vendor_records![0]!.row_data).toEqual({ name: "Mine", phone: "555", email: "m@x.test" });
  });
});

describe("a texted link", () => {
  async function mint(phone = "+14252240508", sharePhotos = false) {
    return createServiceShareLink(asDb(), { workOrderId: "wo-1", managerUserId: MANAGER, createdBy: MANAGER, recipientPhone: phone, sharePhotos });
  }

  it("the signed-out page view carries no address, and photos only when the link allows them", async () => {
    (db.tables.portal_work_order_records![0]!.row_data as Row).photoDataUrls = ["https://cdn.example/a.jpg"];
    const { token } = await mint("+14252240508", false);
    const view = await resolvePublicServiceByToken(asDb(), token);
    expect(view?.state).toBe("open");
    expect(JSON.stringify(view)).not.toMatch(/1420|Alder St|98115|4B|SECRET RESIDENT/);
    expect(view?.service.photos).toEqual([]);
    const withPhotos = await resolvePublicServiceByToken(asDb(), (await mint("+14252240508", true)).token);
    expect(withPhotos?.service.photos).toEqual(["https://cdn.example/a.jpg"]);
  });

  it("an unknown token resolves to nothing; a hired service reads as closed", async () => {
    expect(await resolvePublicServiceByToken(asDb(), "z".repeat(32))).toBeNull();
    const { token } = await mint();
    db.tables.portal_work_order_records![0]!.vendor_user_id = "hired";
    expect((await resolvePublicServiceByToken(asDb(), token))?.state).toBe("closed");
  });

  it("sign-up via the token creates the roster row (texted phone held as linkPhone) and a sent offer, and opens bidding", async () => {
    const { token } = await mint("+14252240508");
    const result = await redeemServiceShareLink(asDb(), { userId: VENDOR, role: "vendor" }, { token, choice: "bid" });
    expect(result).toMatchObject({ ok: true, workOrderId: "wo-1", choice: "bid", alreadyHeld: false });
    // The texted number is the manager's typing, and a link can be forwarded:
    // it is shown back as `linkPhone` and is not identity until verified.
    expect(db.tables.manager_vendor_records![0]!.row_data).toMatchObject({
      origin: "service_link",
      phone: "",
      linkPhone: "+14252240508",
      phoneVerified: false,
      email: "",
      contactHeldUntilBid: true,
    });
    expect(db.tables.work_order_vendor_offers![0]).toMatchObject({ work_order_id: "wo-1", vendor_user_id: VENDOR, status: "sent" });
    expect((db.tables.portal_work_order_records![0]!.row_data as Row).biddingOpen).toBe(true);
    expect(db.tables.service_share_links![0]).toMatchObject({ redeemed_by_user_id: VENDOR });
  });

  it("a link creates nothing without a redeem, and never a bid", async () => {
    await mint();
    expect(db.tables.work_order_vendor_offers).toHaveLength(0);
    expect(db.tables.manager_vendor_records).toHaveLength(0);
    expect(db.tables.work_order_bids).toHaveLength(0);
  });

  it("is locked to the first redeemer; the same vendor can open it again", async () => {
    const { token } = await mint();
    await redeemServiceShareLink(asDb(), { userId: VENDOR, role: "vendor" }, { token });
    expect(await redeemServiceShareLink(asDb(), { userId: "vendor-2", role: "vendor" }, { token })).toMatchObject({ ok: false, status: 409 });
    expect(await redeemServiceShareLink(asDb(), { userId: VENDOR, role: "vendor" }, { token })).toMatchObject({ ok: true, alreadyHeld: true });
    expect(db.tables.work_order_vendor_offers).toHaveLength(1);
  });

  it("refuses an expired / revoked / hired link and a non-vendor", async () => {
    const { token } = await mint();
    expect(await redeemServiceShareLink(asDb(), { userId: MANAGER, role: "manager" }, { token })).toMatchObject({ ok: false, status: 403 });
    db.tables.portal_work_order_records![0]!.vendor_user_id = "hired";
    expect(await redeemServiceShareLink(asDb(), { userId: VENDOR, role: "vendor" }, { token })).toMatchObject({ ok: false, status: 410 });
    db.tables.portal_work_order_records![0]!.vendor_user_id = null;
    db.tables.service_share_links![0]!.revoked_at = new Date().toISOString();
    expect(await redeemServiceShareLink(asDb(), { userId: VENDOR, role: "vendor" }, { token })).toMatchObject({ ok: false, status: 404 });
  });

  it("phone verification is a hook point that changes nothing yet", async () => {
    expect(await serviceLinkPhoneVerificationHook(asDb(), { vendorUserId: VENDOR, phone: "+14252240508" })).toEqual({ verified: false });
  });
});
