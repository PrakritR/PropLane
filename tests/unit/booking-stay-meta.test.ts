import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabaseClient, type Row } from "./helpers/fake-supabase-tables";

/**
 * C2-BK2 / CX-ST1: a signed-lease or application stay keeps its dates, room and
 * rent on the lease/application, but the manager's notes and stay details are
 * editable through an authenticated server write that re-derives ownership of the
 * lease/application from the session. A channel feed stay is never editable.
 */

const mocks = vi.hoisted(() => ({
  managerCanAccessLeaseRecord: vi.fn(async () => true),
  managerCanAccessApplicationRecord: vi.fn(async () => true),
  collectLinkedPropertyIdsForUser: vi.fn(async () => new Set<string>()),
}));
vi.mock("@/lib/auth/manager-lease-scope", () => ({
  managerCanAccessLeaseRecord: mocks.managerCanAccessLeaseRecord,
  collectLinkedPropertyIdsForUser: mocks.collectLinkedPropertyIdsForUser,
}));
vi.mock("@/lib/auth/manager-application-access", () => ({
  managerCanAccessApplicationRecord: mocks.managerCanAccessApplicationRecord,
}));

import { applyStayMeta, normalizeStayMetaInput, stayMetaRefOf } from "@/lib/channel-calendar/stay-meta";
import { listStayMeta, saveStayMeta, stayMetaRecordId } from "@/lib/channel-calendar/stay-meta.server";
import { BOOKING_STAY_META_RECORD_TYPE } from "@/lib/portal-schedule-record-scope";
import type { PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";

const base: PropertyBookingEntry = { source: "proplane", propertyId: "p", propertyLabel: "House", roomId: "r", roomLabel: "Room", summary: "Taylor", start: "2026-11-01", end: "2026-11-30", leaseId: "lease-1" };

function setup() {
  const tables: Record<string, Row[]> = {
    portal_lease_pipeline_records: [{ id: "lease-1", manager_user_id: "owner-1", property_id: "p" }],
    manager_application_records: [{ id: "AXIS-77", manager_user_id: "owner-1", property_id: "p", assigned_property_id: null }],
    portal_schedule_records: [],
  };
  return { tables, db: fakeSupabaseClient(tables) as never };
}

beforeEach(() => {
  mocks.managerCanAccessLeaseRecord.mockReset().mockResolvedValue(true);
  mocks.managerCanAccessApplicationRecord.mockReset().mockResolvedValue(true);
});

describe("which stays carry editable notes", () => {
  it("a signed lease and an application hold do; blocks, channel feeds and cancelled stays do not", () => {
    expect(stayMetaRefOf(base)).toEqual({ kind: "lease", refId: "lease-1" });
    expect(stayMetaRefOf({ source: "hold", applicationId: "AXIS-77" })).toEqual({ kind: "application", refId: "AXIS-77" });
    expect(stayMetaRefOf({ source: "block" })).toBeNull();
    expect(stayMetaRefOf({ source: "airbnb" })).toBeNull();
    expect(stayMetaRefOf({ source: "proplane", leaseId: "lease-1", bookingStatus: "cancelled" })).toBeNull();
  });
});

describe("normalizeStayMetaInput", () => {
  it("accepts notes and housekeeping, drops an attempt to overwrite the source", () => {
    expect(normalizeStayMetaInput({ kind: "lease", refId: " lease-1 ", notes: " Late arrival ", stayDetails: { linen: "Requested", source: "Direct", bogus: "x" } })).toEqual({
      kind: "lease",
      refId: "lease-1",
      notes: "Late arrival",
      stayDetails: { linen: "Requested" },
    });
  });
  it("rejects an unknown kind, an empty id and oversized text", () => {
    expect(normalizeStayMetaInput({ kind: "block", refId: "x" })).toBeNull();
    expect(normalizeStayMetaInput({ kind: "lease", refId: "" })).toBeNull();
    expect(normalizeStayMetaInput({ kind: "lease", refId: "x", notes: "n".repeat(2001) })).toBeNull();
    expect(normalizeStayMetaInput(null)).toBeNull();
  });
});

describe("applyStayMeta", () => {
  it("lays notes and details over only the stay they belong to, leaving dates, room and rent alone", () => {
    const other: PropertyBookingEntry = { ...base, leaseId: "lease-2", summary: "Jordan" };
    const out = applyStayMeta([base, other], [{ kind: "lease", refId: "lease-1", notes: "Gate code 4411", stayDetails: { linen: "Delivered" } }]);
    expect(out[0]).toMatchObject({ reason: "Gate code 4411", stayDetails: { linen: "Delivered" }, start: base.start, end: base.end, roomId: "r" });
    expect(out[1]).toBe(other);
  });
});

describe("saveStayMeta — ownership is re-derived from the session", () => {
  it("writes one record per lease, owned by the lease's owner, after the access check passes", async () => {
    const { tables, db } = setup();
    const result = await saveStayMeta(db, "mgr-session", { kind: "lease", refId: "lease-1", notes: "Gate code 4411", stayDetails: { linen: "Requested" }, managerUserId: "attacker", propertyId: "elsewhere" });
    expect(result.ok).toBe(true);
    expect(mocks.managerCanAccessLeaseRecord).toHaveBeenCalledWith(expect.anything(), "mgr-session", { manager_user_id: "owner-1", property_id: "p" }, "edit");
    const row = tables.portal_schedule_records[0]!;
    expect(row).toMatchObject({ id: stayMetaRecordId("lease", "lease-1"), manager_user_id: "owner-1", property_id: "p", record_type: BOOKING_STAY_META_RECORD_TYPE });
    // Body-supplied owner/property ids are ignored.
    expect(JSON.stringify(row)).not.toContain("attacker");
    expect(JSON.stringify(row)).not.toContain("elsewhere");
    expect((await listStayMeta(db, "owner-1"))[0]).toMatchObject({ kind: "lease", refId: "lease-1", notes: "Gate code 4411" });
  });

  it("refuses a manager who may not edit that lease and writes nothing", async () => {
    const { tables, db } = setup();
    mocks.managerCanAccessLeaseRecord.mockResolvedValue(false);
    expect(await saveStayMeta(db, "stranger", { kind: "lease", refId: "lease-1", notes: "x" })).toMatchObject({ ok: false, status: 403 });
    expect(tables.portal_schedule_records).toHaveLength(0);
  });

  it("saves an application stay's notes and refuses one the manager cannot edit", async () => {
    const { tables, db } = setup();
    expect((await saveStayMeta(db, "mgr", { kind: "application", refId: "axis-77", notes: "Arrives Friday" })).ok).toBe(true);
    expect(tables.portal_schedule_records[0]).toMatchObject({ manager_user_id: "owner-1", property_id: "p" });
    mocks.managerCanAccessApplicationRecord.mockResolvedValue(false);
    expect(await saveStayMeta(db, "stranger", { kind: "application", refId: "AXIS-77", notes: "y" })).toMatchObject({ ok: false, status: 403 });
  });

  it("404s a lease that does not exist and 400s a malformed payload", async () => {
    const { db } = setup();
    expect(await saveStayMeta(db, "mgr", { kind: "lease", refId: "missing" })).toMatchObject({ ok: false, status: 404 });
    expect(await saveStayMeta(db, "mgr", { kind: "airbnb", refId: "x" })).toMatchObject({ ok: false, status: 400 });
  });
});
