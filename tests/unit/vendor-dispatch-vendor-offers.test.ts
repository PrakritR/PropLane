/**
 * Vendor portal dispatch offers (vendor-dispatch-1018): a vendor sees and answers
 * only offers on their own roster record, and an answer is a compare-and-set so the
 * SMS reply and the portal tap cannot both win.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb, type Row } from "../helpers/fake-table-db";
import { answerVendorDispatchOffer, listVendorDispatchOffers } from "@/lib/vendor-dispatch/vendor-offers.server";

const VENDOR_USER = "11111111-1111-4111-8111-111111111111";
const OTHER_USER = "22222222-2222-4222-8222-222222222222";
const RUN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ATT_MINE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ATT_BACKUP = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ATT_OTHER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const NOW = new Date("2026-10-18T12:00:00.000Z");

let db: FakeDb;

function seed(): Record<string, Row[]> {
  return {
    manager_vendor_records: [
      { id: "v-mine", vendor_user_id: VENDOR_USER, manager_user_id: "m1" },
      { id: "v-backup", vendor_user_id: OTHER_USER, manager_user_id: "m1" },
      { id: "v-other", vendor_user_id: OTHER_USER, manager_user_id: "m1" },
    ],
    vendor_dispatch_runs: [
      {
        id: RUN,
        handle: 7,
        trade: "locksmith",
        issue: "lockout",
        urgency: "emergency",
        offer_text: "Lockout in Capitol Hill. $120.",
        pay_cents: 12000,
        status: "offering",
        accepted_vendor_directory_id: null,
        property_id: "secret-house",
        workspace_id: "ws-secret",
      },
    ],
    vendor_dispatch_attempts: [
      { id: ATT_MINE, run_id: RUN, vendor_directory_id: "v-mine", position: 0, wave: 0, status: "offered", timeout_at: "2026-10-18T12:10:00.000Z", offered_at: "2026-10-18T12:00:00.000Z" },
      { id: ATT_BACKUP, run_id: RUN, vendor_directory_id: "v-backup", position: 1, wave: 0, status: "queued", timeout_at: null, offered_at: null },
      { id: ATT_OTHER, run_id: RUN, vendor_directory_id: "v-other", position: 2, wave: 0, status: "offered", timeout_at: "2026-10-18T12:10:00.000Z", offered_at: "2026-10-18T12:00:00.000Z" },
    ],
  };
}

beforeEach(() => {
  db = createFakeDb(seed());
});

describe("listVendorDispatchOffers", () => {
  it("lists only the vendor's own live offers, with the general-area text and no house or workspace", async () => {
    const result = await listVendorDispatchOffers(db as never, VENDOR_USER, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.offers).toHaveLength(1);
    const offer = result.offers[0]!;
    expect(offer).toMatchObject({ attemptId: ATT_MINE, handle: 7, tradeLabel: "Locksmith", issueLabel: "Lockout", payCents: 12000, status: "offered" });
    expect(offer.offerText).toBe("Lockout in Capitol Hill. $120.");
    expect(JSON.stringify(offer)).not.toMatch(/secret-house|ws-secret/);
  });

  it("drops an offer past its deadline and one on a run that is no longer offering", async () => {
    expect(((await listVendorDispatchOffers(db as never, VENDOR_USER, new Date("2026-10-18T12:30:00.000Z"))) as { offers: unknown[] }).offers).toEqual([]);
    db.tables.vendor_dispatch_runs![0]!.status = "canceled";
    expect(((await listVendorDispatchOffers(db as never, VENDOR_USER, NOW)) as { offers: unknown[] }).offers).toEqual([]);
  });

  it("lists nothing for a user with no roster record", async () => {
    expect(await listVendorDispatchOffers(db as never, "99999999-9999-4999-8999-999999999999", NOW)).toEqual({ ok: true, offers: [] });
  });
});

describe("answerVendorDispatchOffer", () => {
  it("accept claims the run, marks the attempt, and supersedes the other vendors", async () => {
    const result = await answerVendorDispatchOffer(db as never, { vendorUserId: VENDOR_USER, attemptId: ATT_MINE, answer: "accept" }, NOW);
    expect(result).toEqual({ ok: true, status: "accepted" });
    const runRow = db.tables.vendor_dispatch_runs![0]!;
    expect(runRow.status).toBe("accepted");
    expect(runRow.accepted_vendor_directory_id).toBe("v-mine");
    const byId = new Map(db.tables.vendor_dispatch_attempts!.map((a) => [a.id, a.status]));
    expect(byId.get(ATT_MINE)).toBe("accepted");
    expect(byId.get(ATT_BACKUP)).toBe("superseded");
    expect(byId.get(ATT_OTHER)).toBe("superseded");
  });

  it("a second answer to the same offer loses", async () => {
    await answerVendorDispatchOffer(db as never, { vendorUserId: VENDOR_USER, attemptId: ATT_MINE, answer: "accept" }, NOW);
    expect(await answerVendorDispatchOffer(db as never, { vendorUserId: VENDOR_USER, attemptId: ATT_MINE, answer: "accept" }, NOW)).toEqual({
      ok: false,
      reason: "already_answered",
    });
  });

  it("decline marks only the attempt and leaves the run offering", async () => {
    const result = await answerVendorDispatchOffer(db as never, { vendorUserId: VENDOR_USER, attemptId: ATT_MINE, answer: "decline" }, NOW);
    expect(result).toEqual({ ok: true, status: "declined" });
    expect(db.tables.vendor_dispatch_runs![0]!.status).toBe("offering");
    expect(db.tables.vendor_dispatch_attempts!.find((a) => a.id === ATT_MINE)!.status).toBe("declined");
  });

  it("reads another vendor's attempt as not found and changes nothing", async () => {
    expect(await answerVendorDispatchOffer(db as never, { vendorUserId: VENDOR_USER, attemptId: ATT_OTHER, answer: "accept" }, NOW)).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(db.tables.vendor_dispatch_runs![0]!.status).toBe("offering");
    expect(db.tables.vendor_dispatch_attempts!.find((a) => a.id === ATT_OTHER)!.status).toBe("offered");
  });

  it("refuses an expired offer", async () => {
    expect(
      await answerVendorDispatchOffer(db as never, { vendorUserId: VENDOR_USER, attemptId: ATT_MINE, answer: "accept" }, new Date("2026-10-18T12:30:00.000Z")),
    ).toEqual({ ok: false, reason: "expired" });
  });

  it("does not stand when the run was canceled first", async () => {
    db.tables.vendor_dispatch_runs![0]!.status = "canceled";
    const result = await answerVendorDispatchOffer(db as never, { vendorUserId: VENDOR_USER, attemptId: ATT_MINE, answer: "accept" }, NOW);
    expect(result).toEqual({ ok: false, reason: "already_answered" });
    expect(db.tables.vendor_dispatch_runs![0]!.status).toBe("canceled");
    expect(db.tables.vendor_dispatch_attempts!.find((a) => a.id === ATT_MINE)!.status).toBe("superseded");
  });

  it("rejects a malformed attempt id", async () => {
    expect(await answerVendorDispatchOffer(db as never, { vendorUserId: VENDOR_USER, attemptId: "nope", answer: "accept" }, NOW)).toEqual({
      ok: false,
      reason: "not_found",
    });
  });
});
