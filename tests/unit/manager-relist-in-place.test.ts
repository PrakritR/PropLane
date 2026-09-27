// @vitest-environment jsdom
/**
 * Regression: relist-delete-can-destroy-the-row-the-quota-refused.
 *
 * Relisting an unlisted listing transitions ONE record `unlisted` -> `live` in
 * place: `unlistManagerListing` is the only writer of the unlisted bucket and
 * stores rows via `mockToAdminRow(removed, listingId)`, so `adminRefId` and
 * `listingId` are the same id the relist upsert carries.
 *
 * `listAdminRow` nonetheless fired a second, fire-and-forget
 * `deleteMirroredPropertyRecord(row.adminRefId)` at that very id. While every
 * upsert was accepted, the next mirror re-created the row from the local copy
 * and the delete looked harmless. The plan cap removed that accident: a relist
 * the server refuses (an owner at their cap, which the viewer-scoped client
 * pre-check cannot always predict — a co-manager relisting a linked listing,
 * or a plan the server could not read) would still have the delete land. The
 * listing would be gone from `manager_property_records`, with
 * `clearHousingAccessForDeletedProperty` stripping co-manager grants and
 * scrubbing resident housing for that id, surviving only in the one browser
 * that pressed Relist — the exact data loss the plan work forbids.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import {
  publishManagerListingSubmissionToServer,
  readExtraListingsForUser,
} from "@/lib/demo-property-pipeline";
import { flushPropertyRecordOutbox, pendingPropertyRecordWrites } from "@/lib/property-record-outbox";
import {
  listAdminRow,
  readAdminPropertyRows,
  unlistManagerListing,
} from "@/lib/demo-admin-property-inventory";
import { FREE_MAX_PROPERTIES, managerPropertyLimitMessage } from "@/lib/manager-access";

/** Statuses that spend a plan listing slot (LISTING_SLOT_PROPERTY_STATUSES). */
const SLOT_STATUSES = new Set(["pending", "live", "review"]);

type ServerRecord = { owner: string; status: string };

/** What `manager_property_records` holds, keyed by record id. */
let records: Map<string, ServerRecord>;
/** Every id the client asked the server to DELETE. */
let deletedIds: string[];
/** The owner's plan cap, mirroring `assertManagerPropertyListingQuota`. */
let slotCap: number;

function slotsHeldBy(owner: string, exceptId: string): number {
  let n = 0;
  for (const [id, rec] of records) {
    if (id !== exceptId && rec.owner === owner && SLOT_STATUSES.has(rec.status)) n += 1;
  }
  return n;
}

/**
 * A fake `POST /api/property-records` that enforces the same rule the real
 * route does: a write moving a record INTO a listing slot is refused once the
 * owner is at their cap; a row already holding a slot is never re-charged.
 */
function serverFetch() {
  return vi.fn(async (url: unknown, init?: { body?: unknown }) => {
    if (!String(url).includes("/api/property-records")) {
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      action?: string;
      id?: string;
      managerUserId?: string | null;
      status?: string;
    };
    const id = String(body.id ?? "");
    if (body.action === "delete") {
      deletedIds.push(id);
      records.delete(id);
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }
    if (body.action === "upsert") {
      const owner = String(body.managerUserId ?? "");
      const status = String(body.status ?? "");
      const existing = records.get(id);
      const takesNewSlot = SLOT_STATUSES.has(status) && !SLOT_STATUSES.has(existing?.status ?? "");
      if (takesNewSlot && slotsHeldBy(owner, id) >= slotCap) {
        return {
          ok: false,
          status: 403,
          json: async () => ({
            error: managerPropertyLimitMessage("free"),
            code: "property_limit_reached",
          }),
        } as unknown as Response;
      }
      records.set(id, { owner, status });
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => ({ snapshot: null }) } as unknown as Response;
  });
}

/** The mirrored writes are fire-and-forget; let them settle. */
async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function submission(buildingName: string) {
  return {
    ...createDefaultListingSubmission(),
    buildingName,
    address: "5200 Ravenna Ave NE",
    zip: "98105",
  };
}

let seq = 0;
const nextManager = () => `mgr-relist-${(seq += 1)}`;

beforeEach(() => {
  window.history.replaceState(null, "", "/portal/properties");
  window.localStorage.clear();
  window.sessionStorage.clear();
  records = new Map();
  deletedIds = [];
  slotCap = Number.POSITIVE_INFINITY;
  vi.stubGlobal("fetch", serverFetch());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function publishLive(manager: string, listingId: string, name: string) {
  const ok = await publishManagerListingSubmissionToServer(listingId, submission(name), manager, {});
  await flush();
  expect(ok).toBe(true);
  return listingId;
}

describe("unlist -> relist round trip inside the plan cap", () => {
  it("ends with the record live exactly once — no duplicate, no missing row", async () => {
    // The case the removed delete used to mask: relisting no longer "self-heals"
    // by destroying and re-mirroring the record, so it has to be right in place.
    const manager = nextManager();
    const listingId = "mgr-ravenna-a-100001";
    await publishLive(manager, listingId, "Ravenna House");

    expect(unlistManagerListing(listingId, manager)).toBe(true);
    await flush();
    expect(records.get(listingId)?.status).toBe("unlisted");
    expect(readExtraListingsForUser(manager)).toEqual([]);
    expect(readAdminPropertyRows(3, manager).map((r) => r.adminRefId)).toEqual([listingId]);

    // Unlisting has its own delete-then-upsert pair (`removeExtraListing` drops
    // the live row, `unlistManagerListing` re-writes it as `unlisted`), so the
    // relist is measured against what the server had already been asked to do.
    const deletesBeforeRelist = [...deletedIds];
    const unlistedRow = readAdminPropertyRows(3, manager)[0]!;
    const relistedId = listAdminRow(unlistedRow, manager);
    await flush();

    expect(relistedId).toBe(listingId);
    // One record, transitioned in place — not a second row alongside it.
    expect([...records.keys()]).toEqual([listingId]);
    expect(records.get(listingId)?.status).toBe("live");
    expect(deletedIds).toEqual(deletesBeforeRelist);
    // Local state agrees: live once, and the unlisted bucket is cleared.
    expect(readExtraListingsForUser(manager).map((p) => p.id)).toEqual([listingId]);
    expect(readAdminPropertyRows(3, manager)).toEqual([]);
  });
});

describe("a relist the plan cap refuses", () => {
  it("leaves the server record intact and still relistable after an upgrade", async () => {
    const manager = nextManager();
    const parked = "mgr-ravenna-b-200001";
    const occupying = "mgr-ravenna-c-200002";
    await publishLive(manager, parked, "Parked House");
    await publishLive(manager, occupying, "Occupying House");

    expect(unlistManagerListing(parked, manager)).toBe(true);
    await flush();
    expect(records.get(parked)?.status).toBe("unlisted");

    // The owner now holds their one Free slot with the OTHER listing, so
    // relisting this one asks for a second slot and the server refuses it.
    slotCap = FREE_MAX_PROPERTIES;
    const deletesBeforeRelist = [...deletedIds];
    const unlistedRow = readAdminPropertyRows(3, manager)[0]!;
    listAdminRow(unlistedRow, manager);
    await flush();

    // Nothing was destroyed: the relist issued no delete of its own, and the
    // row the server refused to relist is still there.
    expect(deletedIds).toEqual(deletesBeforeRelist);
    expect(records.has(parked)).toBe(true);
    expect(records.get(parked)?.status).toBe("unlisted");
    // The listing the manager still owns is untouched too.
    expect(records.get(occupying)?.status).toBe("live");

    // The refusal is final for that write: it is not left queued to be
    // replayed on a later sync behind the manager's back (the old page-load
    // mirror did exactly that). The server's row stays the truth, and the
    // manager relists again once the plan allows it.
    expect(pendingPropertyRecordWrites(manager)).toEqual([]);
    slotCap = 2;
    await flushPropertyRecordOutbox(manager);
    expect(records.get(parked)?.status).toBe("unlisted");
    expect(deletedIds).toEqual(deletesBeforeRelist);
  });
});
