// PropLane Jobs: fan-out limits, accept-by-reply idempotency, and the vendor "any work" read.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type Row } from "../helpers/fake-table-db";

const requestBoardJob = vi.fn();
const submitWorkOrderBid = vi.fn();
const resolveBoardEligibility = vi.fn();
const notifyManagerFromAgent = vi.fn();
const readVendorTextConsent = vi.fn();
const rateLimit = vi.fn();

vi.mock("@/lib/service-work-board.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/service-work-board.server")>()),
  requestBoardJob: (...a: unknown[]) => requestBoardJob(...a),
  resolveBoardEligibility: (...a: unknown[]) => resolveBoardEligibility(...a),
}));
vi.mock("@/lib/work-order-bids.server", () => ({ submitWorkOrderBid: (...a: unknown[]) => submitWorkOrderBid(...a) }));
vi.mock("@/lib/agent-notify.server", () => ({ notifyManagerFromAgent: (...a: unknown[]) => notifyManagerFromAgent(...a) }));
vi.mock("@/lib/sms/vendor-conversation-consent.server", () => ({
  VENDOR_CONVERSATION_PURPOSE: "vendor_conversation",
  readVendorTextConsent: (...a: unknown[]) => readVendorTextConsent(...a),
}));
vi.mock("@/lib/service/service-catalog.server", () => ({ readPlatformServiceOwnerId: async () => "svc-owner" }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: (...a: unknown[]) => rateLimit(...a) }));
vi.mock("@/lib/work-order-marketplace-match.server", () => ({
  loadMarketplaceVendorUserIds: vi.fn(),
  resolveWorkOrderPropertyZip: async (_db: unknown, row: { propertyAddress?: string }) => /\b(\d{5})\b/.exec(row.propertyAddress ?? "")?.[1] ?? null,
}));

import { acceptGigOffer, fanOutGigOffers, gigOfferText, handleGigReplyText, MAX_GIG_OFFERS_PER_GIG, MAX_GIG_OFFERS_PER_VENDOR_PER_DAY, openGigLinesFor } from "@/lib/jobs/gig-offers.server";

const NOW = new Date("2026-11-11T20:00:00Z");
const vendorProfile = (id: string, over: Row = {}): Row => ({ id, phone: `+1206555${id.slice(-4).padStart(4, "0")}`, phone_verified_at: "2026-10-01T00:00:00Z", sms_consent_at: "2026-10-01T00:00:00Z", sms_opt_out_at: null, full_name: `Vendor ${id}`, email: `${id}@x.test`, ...over });

let db: ReturnType<typeof createFakeDb>;
function seed(profiles: Row[], offers: Row[] = []) {
  db = createFakeDb({
    gig_posts: [{ id: "gig-1", work_order_id: "wo-1", manager_user_id: "mgr-1", workspace_id: null, kind: "tour_showing", offered_cents: 4000, window_text: "Saturday 2pm", code: "K7Q2", status: "open" }],
    gig_offers: offers,
    profiles,
    portal_work_order_records: [{
      id: "wo-1", manager_user_id: "mgr-1", vendor_user_id: null,
      row_data: { id: "wo-1", title: "Tour showing - Room 3", propertyName: "Alder House", propertyAddress: "1420 Alder St, Seattle, WA 98115", unit: "Room 3", status: "Open", bucket: "open", category: "tours", propertyId: "p1", published: true, publishRef: "pub_" + "a".repeat(32), residentName: "SECRET RESIDENT" },
    }],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  rateLimit.mockResolvedValue({ ok: true });
  readVendorTextConsent.mockResolvedValue({ ok: true, state: "granted", conversationKey: "k", grantedUnder: "k", grantSource: "x" });
  resolveBoardEligibility.mockResolvedValue({ ok: true, profile: {} });
  requestBoardJob.mockResolvedValue({ ok: true, workOrderId: "wo-1", choice: "bid" });
  submitWorkOrderBid.mockResolvedValue({ ok: true });
});

describe("the offer text", () => {
  it("names the kind, the general area, the time, the pay and the code - never an address", () => {
    const text = gigOfferText({ kind: "tour_showing", area: "Seattle, WA", whenText: "Saturday 2pm", offeredCents: 4000, code: "K7Q2" });
    expect(text).toContain("Pays $40");
    expect(text).toContain("YES K7Q2");
    expect(text).toContain("STOP");
    expect(text).not.toMatch(/Alder|1420|Room 3/);
  });
});

describe("fan-out", () => {
  const sends: { to: string; text: string; key: string }[] = [];
  const deps = (ids: string[]) => ({
    now: () => NOW,
    loadVendorUserIds: async () => ids,
    send: async (_db: unknown, i: { toPhone: string; text: string; dedupeKey: string }) => (sends.push({ to: i.toPhone, text: i.text, key: i.dedupeKey }), { ok: true }),
  });
  beforeEach(() => { sends.length = 0; });

  it("texts only verified, consenting, not-stopped vendors and never the manager", async () => {
    seed([vendorProfile("v0001"), vendorProfile("v0002", { sms_consent_at: null }), vendorProfile("v0003", { phone_verified_at: null }), vendorProfile("v0004", { sms_opt_out_at: "2026-11-01T00:00:00Z" })]);
    const result = await fanOutGigOffers(db as never, "gig-1", deps(["v0001", "v0002", "v0003", "v0004", "mgr-1"]));
    expect(result.sent).toBe(1);
    expect(result.skipped).toMatchObject({ no_consent: 2, no_verified_phone: 1 });
    expect(sends).toHaveLength(1);
    expect(sends[0]!.text).not.toContain("1420");
    expect(db.tables.gig_offers).toHaveLength(1);
  });

  it("is idempotent: a second run texts nobody twice", async () => {
    seed([vendorProfile("v0001")]);
    await fanOutGigOffers(db as never, "gig-1", deps(["v0001"]));
    const again = await fanOutGigOffers(db as never, "gig-1", deps(["v0001"]));
    expect(again.sent).toBe(0);
    expect(sends).toHaveLength(1);
  });

  it("caps offers per job and per vendor per day", async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `v${String(i + 1).padStart(4, "0")}`);
    seed(ids.map((id) => vendorProfile(id)));
    const result = await fanOutGigOffers(db as never, "gig-1", deps(ids));
    expect(result.sent).toBe(MAX_GIG_OFFERS_PER_GIG);
    expect(result.skipped.cap_reached).toBe(ids.length - MAX_GIG_OFFERS_PER_GIG);

    const busy = Array.from({ length: MAX_GIG_OFFERS_PER_VENDOR_PER_DAY }, (_, i) => ({ id: `o${i}`, gig_id: `other-${i}`, vendor_user_id: "v0001", sent_at: NOW.toISOString(), status: "sent" }));
    seed([vendorProfile("v0001")], busy);
    const capped = await fanOutGigOffers(db as never, "gig-1", deps(["v0001"]));
    expect(capped.sent).toBe(0);
    expect(capped.skipped.vendor_daily_cap).toBe(1);
  });

  it("fails closed when the consent ledger says STOP or cannot be read", async () => {
    seed([vendorProfile("v0001"), vendorProfile("v0002")]);
    readVendorTextConsent.mockResolvedValueOnce({ ok: true, state: "opted_out" }).mockResolvedValueOnce({ ok: false, error: "x" });
    const result = await fanOutGigOffers(db as never, "gig-1", deps(["v0001", "v0002"]));
    expect(result.sent).toBe(0);
    expect(result.skipped.stopped_or_unreadable).toBe(2);
  });

  it("a refused send is recorded as failed, not sent", async () => {
    seed([vendorProfile("v0001")]);
    const result = await fanOutGigOffers(db as never, "gig-1", { ...deps(["v0001"]), send: async () => ({ ok: false, reason: "quiet_hours" }) });
    expect(result.sent).toBe(0);
    expect(db.tables.gig_offers![0]!.status).toBe("failed");
  });

  it("does nothing once the service is hired out", async () => {
    seed([vendorProfile("v0001")]);
    (db.tables.portal_work_order_records![0] as Row).vendor_user_id = "someone";
    const result = await fanOutGigOffers(db as never, "gig-1", deps(["v0001"]));
    expect(result.sent).toBe(0);
    expect(db.tables.gig_posts![0]!.status).toBe("accepted");
  });
});

describe("accept by reply", () => {
  it("files a request and a submitted bid at the OFFERED price, then tells the manager", async () => {
    seed([vendorProfile("v0001")], [{ id: "o1", gig_id: "gig-1", vendor_user_id: "v0001", status: "sent", sent_at: NOW.toISOString() }]);
    const turn = await handleGigReplyText(db as never, { vendorUserId: "v0001", body: "YES" }, { now: () => NOW });
    expect(turn).toMatchObject({ handled: true });
    expect(requestBoardJob).toHaveBeenCalledTimes(1);
    expect(submitWorkOrderBid).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ userId: "v0001", role: "vendor" }), expect.objectContaining({ workOrderId: "wo-1", amountCents: 4000, materialsCents: 0 }));
    expect(notifyManagerFromAgent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ landlordId: "mgr-1", idempotencyKey: "gig-accept:gig-1:v0001" }));
    expect(db.tables.gig_offers![0]!.status).toBe("accepted");
    // nothing was assigned: only a bid exists
    expect(db.tables.portal_work_order_records![0]!.vendor_user_id).toBeNull();
  });

  it("a repeated YES is a no-op", async () => {
    seed([vendorProfile("v0001")], [{ id: "o1", gig_id: "gig-1", vendor_user_id: "v0001", status: "sent", sent_at: NOW.toISOString() }]);
    await handleGigReplyText(db as never, { vendorUserId: "v0001", body: "YES K7Q2" }, { now: () => NOW });
    const again = await acceptGigOffer(db as never, { vendorUserId: "v0001", code: "K7Q2", channel: "sms" }, { now: () => NOW });
    expect(again).toMatchObject({ ok: true, already: true });
    expect(submitWorkOrderBid).toHaveBeenCalledTimes(1);
    expect(notifyManagerFromAgent).toHaveBeenCalledTimes(1);
  });

  it("a bare YES with two open offers asks which one, and accepts nothing", async () => {
    seed([vendorProfile("v0001")], [{ id: "o1", gig_id: "gig-1", vendor_user_id: "v0001", status: "sent", sent_at: NOW.toISOString() }, { id: "o2", gig_id: "gig-2", vendor_user_id: "v0001", status: "sent", sent_at: NOW.toISOString() }]);
    (db.tables.gig_posts as Row[]).push({ id: "gig-2", work_order_id: "wo-2", manager_user_id: "mgr-1", workspace_id: null, kind: "cleaning", offered_cents: 12000, window_text: null, code: "M3N4", status: "open" });
    (db.tables.portal_work_order_records as Row[]).push({ id: "wo-2", manager_user_id: "mgr-1", vendor_user_id: null, row_data: { id: "wo-2", status: "Open", bucket: "open", category: "cleaning", published: true, publishRef: "pub_" + "b".repeat(32) } });
    const turn = await handleGigReplyText(db as never, { vendorUserId: "v0001", body: "yes" }, { now: () => NOW });
    expect(turn).toMatchObject({ handled: true });
    expect((turn as { reply: string }).reply).toMatch(/Which job/);
    expect(submitWorkOrderBid).not.toHaveBeenCalled();
  });

  it("refuses a closed job, a full job and a non-vendor", async () => {
    seed([vendorProfile("v0001")]);
    (db.tables.portal_work_order_records![0] as Row).vendor_user_id = "someone";
    expect(await acceptGigOffer(db as never, { vendorUserId: "v0001", code: "K7Q2", channel: "sms" })).toMatchObject({ ok: false, reason: "closed" });

    seed([vendorProfile("v0001")], [1, 2, 3].map((n) => ({ id: `a${n}`, gig_id: "gig-1", vendor_user_id: `x${n}`, status: "accepted", sent_at: NOW.toISOString() })));
    expect(await acceptGigOffer(db as never, { vendorUserId: "v0001", code: "K7Q2", channel: "sms" })).toMatchObject({ ok: false, reason: "full" });

    seed([vendorProfile("v0001")]);
    resolveBoardEligibility.mockResolvedValueOnce({ ok: false, status: 403, error: "no" });
    expect(await acceptGigOffer(db as never, { vendorUserId: "v0001", code: "K7Q2", channel: "sms" })).toMatchObject({ ok: false, reason: "not_a_vendor" });
    expect(submitWorkOrderBid).not.toHaveBeenCalled();
  });

  it("a stranger answering a code is invited to sign up, never accepted; a stranger's bare YES is not ours", async () => {
    seed([]);
    const invited = await handleGigReplyText(db as never, { vendorUserId: null, body: "yes K7Q2", signupLink: async () => "https://proplane.ai/start/x" }, { now: () => NOW });
    expect(invited).toMatchObject({ handled: true, vendorUserId: null });
    expect((invited as { reply: string }).reply).toContain("https://proplane.ai/start/x");
    expect(await handleGigReplyText(db as never, { vendorUserId: null, body: "yes" })).toEqual({ handled: false });
    expect(await handleGigReplyText(db as never, { vendorUserId: null, body: "yes ZZZZ" })).toEqual({ handled: false });
    expect(requestBoardJob).not.toHaveBeenCalled();
  });

  it("NO passes on that offer only", async () => {
    seed([vendorProfile("v0001")], [{ id: "o1", gig_id: "gig-1", vendor_user_id: "v0001", status: "sent", sent_at: NOW.toISOString() }]);
    await handleGigReplyText(db as never, { vendorUserId: "v0001", body: "no" }, { now: () => NOW });
    expect(db.tables.gig_offers![0]!.status).toBe("declined");
    expect(submitWorkOrderBid).not.toHaveBeenCalled();
  });
});

describe("the vendor 'any work' read", () => {
  it("lists only open priced jobs among the board's own filtered jobs, with no street, unit, resident or id", async () => {
    seed([]);
    const { lines, serviceIds } = await openGigLinesFor(db as never, [
      { serviceId: "wo-1", area: "Ballard", when: "Anytime" },
      { serviceId: "wo-not-a-gig", area: "Fremont", when: "Anytime" },
    ]);
    expect(lines).toHaveLength(1);
    expect([...serviceIds]).toEqual(["wo-1"]);
    const text = JSON.stringify(lines);
    expect(text).toContain("K7Q2");
    expect(text).toContain("$40");
    expect(text).toContain("Ballard");
    expect(text).not.toMatch(/Alder|1420|SECRET|wo-1|mgr-1|Room 3/);
  });

  it("a job that is no longer open is not listed", async () => {
    seed([]);
    (db.tables.gig_posts![0] as Row).status = "accepted";
    expect((await openGigLinesFor(db as never, [{ serviceId: "wo-1", area: "Ballard", when: "Anytime" }])).lines).toHaveLength(0);
  });
});
