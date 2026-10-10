// @vitest-environment jsdom
/**
 * Residents on Bookings come from the occupancy snapshot (primary), so a slow or failed
 * /api/manager-applications read never hides them. When applications / leases arrive they only
 * enrich the same stay (match by applicationId / leaseId) and never add a second row.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { PORTAL_READ_TIMEOUT_MS } from "@/lib/auth/fetch-with-timeout";

const channel = vi.fn<(ids: string[]) => Promise<unknown[]>>();
const occupancy = vi.fn<() => Promise<{ days: unknown[]; stays?: unknown[] }>>();
const applicationsSync = vi.fn<() => Promise<{ rows: unknown[]; ok: boolean; complete?: boolean }>>();
let storedApplicationRows: unknown[] = [];

vi.mock("@/lib/channel-calendar/client", () => ({
  fetchManagerChannelBookings: (ids: string[]) => channel(ids),
  fetchOccupancySnapshot: () => occupancy(),
}));
vi.mock("@/lib/channel-calendar/room-date-blocks", () => ({
  ROOM_DATE_BLOCKS_CHANGED: "axis:room-date-blocks-changed",
  fetchRoomDateBlocks: () => Promise.resolve([]),
}));
vi.mock("@/lib/channel-calendar/stay-meta-client", () => ({ fetchStayMetas: () => Promise.resolve([]) }));
vi.mock("@/lib/lease-pipeline-storage", () => ({
  LEASE_PIPELINE_EVENT: "lease-pipeline-changed",
  leasePipelineReadSucceeded: () => true,
  leaseIsFullyExecuted: () => false,
  readLeasePipeline: () => [],
  // Leases never answer either: the page must not wait on them.
  syncLeasePipelineFromServer: () => new Promise(() => {}),
}));
vi.mock("@/lib/manager-applications-storage", () => ({
  MANAGER_APPLICATIONS_EVENT: "manager-applications-changed",
  normalizeApplicationAxisId: (id: unknown) => String(id ?? ""),
  readManagerApplicationRows: () => storedApplicationRows,
  syncManagerApplicationsFromServerWithStatus: () => applicationsSync(),
}));
vi.mock("@/lib/rental-application/data", () => ({
  getPropertyById: () => null,
  isEntireHomeProperty: () => false,
  parseRoomChoiceValue: (value: string) => ({ listingRoomId: value.includes("::") ? value.split("::")[1] : null }),
}));

import { useManagerBookingEntries } from "@/hooks/use-manager-booking-entries";
import { mergeResidentEntries, residentEntriesFromStays } from "@/lib/occupancy/snapshot";

const PROPS = {
  userId: "mgr-1",
  propertyIds: ["house-1"],
  propertyOptions: [{ id: "house-1", label: "Seattle Home" }],
  propertyTick: 0,
};

const stay = (n: number, over: Record<string, unknown> = {}) => ({
  id: `house-1:r${n}:2026-10-05:Resident ${n}`,
  propertyId: "house-1",
  roomId: `r${n}`,
  roomLabel: `Room ${n}`,
  start: "2026-10-05",
  end: "2027-01-31",
  kind: "hold",
  name: `Resident ${n}`,
  monthlyRent: 900,
  resident: {
    source: "hold",
    applicationId: `AXIS-${n}`,
    residentName: `Resident ${n}`,
    residentEmail: `r${n}@example.com`,
    residentPhone: "+12065550100",
    monthlyRent: 900,
    securityDeposit: 500,
    leaseTerm: "Long-term",
    statusLabel: "Approved · lease pending",
  },
  ...over,
});

async function flush() {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  });
}

const residentEntries = (entries: Array<{ source: string }>) => entries.filter((e) => e.source === "hold" || e.source === "proplane");

beforeEach(() => {
  vi.useFakeTimers();
  channel.mockReset();
  occupancy.mockReset();
  applicationsSync.mockReset();
  channel.mockResolvedValue([]);
  storedApplicationRows = [];
  applicationsSync.mockImplementation(() => new Promise(() => {}));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Bookings residents from the occupancy snapshot", () => {
  it("shows residents as soon as occupancy answers, while applications and leases never resolve", async () => {
    occupancy.mockResolvedValue({ days: [], stays: [stay(1), stay(2)] });
    const { result } = renderHook(() => useManagerBookingEntries(PROPS));
    await flush();

    const residents = residentEntries(result.current.entries) as Array<Record<string, unknown>>;
    expect(residents).toHaveLength(2);
    expect(residents[0]).toMatchObject({
      source: "hold",
      applicationId: "AXIS-1",
      residentName: "Resident 1",
      residentEmail: "r1@example.com",
      residentPhone: "+12065550100",
      monthlyRent: 900,
      securityDeposit: 500,
      leaseTerm: "Long-term",
      propertyLabel: "Seattle Home",
      roomLabel: "Room 1",
      start: "2026-10-05",
      end: "2027-01-31",
    });
    expect(result.current.failedSources).toEqual([]);
  });

  it("does not raise the load-failed band when applications time out but occupancy answered", async () => {
    occupancy.mockResolvedValue({ days: [], stays: [stay(1)] });
    const { result } = renderHook(() => useManagerBookingEntries(PROPS));
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PORTAL_READ_TIMEOUT_MS + 10);
    });
    expect(result.current.failedSources).toEqual([]);
    expect(residentEntries(result.current.entries)).toHaveLength(1);
  });

  it("does not raise the band when the applications read errors but occupancy answered", async () => {
    occupancy.mockResolvedValue({ days: [], stays: [stay(1)] });
    applicationsSync.mockResolvedValue({ rows: [], ok: false });
    const { result } = renderHook(() => useManagerBookingEntries(PROPS));
    await flush();
    expect(result.current.failedSources).toEqual([]);
    expect(residentEntries(result.current.entries)).toHaveLength(1);
  });

  it("raises the band for applications only when occupancy also failed", async () => {
    occupancy.mockRejectedValue(new Error("down"));
    applicationsSync.mockResolvedValue({ rows: [], ok: false });
    const { result } = renderHook(() => useManagerBookingEntries(PROPS));
    await flush();
    expect(result.current.failedSources).toEqual(expect.arrayContaining(["occupancy", "applications"]));
  });

  it("raises the band when the channel fails even though residents are present", async () => {
    occupancy.mockResolvedValue({ days: [], stays: [stay(1)] });
    channel.mockRejectedValue(new Error("down"));
    const { result } = renderHook(() => useManagerBookingEntries(PROPS));
    await flush();
    expect(result.current.failedSources).toEqual(["channel"]);
  });

  it("enriches the same stay when applications arrive and never duplicates it", async () => {
    occupancy.mockResolvedValue({ days: [], stays: [stay(1), stay(2)] });
    const application = {
      id: "AXIS-1",
      bucket: "approved",
      name: "Resident 1",
      email: "r1@example.com",
      propertyId: "house-1",
      assignedPropertyId: "house-1",
      assignedRoomChoice: "house-1::r1",
      manualResidentDetails: { moveInDate: "2026-10-05", moveOutDate: "2027-01-31", monthlyRent: 950 },
    };
    const second = { ...application, id: "AXIS-2", name: "Resident 2", assignedRoomChoice: "house-1::r2", manualResidentDetails: { moveInDate: "2026-10-05", moveOutDate: "2027-01-31" } };
    storedApplicationRows = [application, second];
    applicationsSync.mockResolvedValue({ rows: [application, second], ok: true, complete: true });
    const { result } = renderHook(() => useManagerBookingEntries(PROPS));
    await flush();

    const residents = residentEntries(result.current.entries) as Array<Record<string, unknown>>;
    expect(residents).toHaveLength(2);
    expect(residents.filter((entry) => entry.applicationId === "AXIS-1")).toHaveLength(1);
    // The client copy overrides the field it carries; the snapshot's remaining facts survive.
    const merged = residents.find((entry) => entry.applicationId === "AXIS-1")!;
    expect(merged.monthlyRent).toBe(950);
    expect(merged.securityDeposit).toBe(500);
  });

  it("drops a hold the loaded applications list no longer contains", async () => {
    occupancy.mockResolvedValue({ days: [], stays: [stay(1), stay(2)] });
    const application = {
      id: "AXIS-1",
      bucket: "approved",
      name: "Resident 1",
      propertyId: "house-1",
      assignedRoomChoice: "house-1::r1",
      manualResidentDetails: { moveInDate: "2026-10-05" },
    };
    storedApplicationRows = [application];
    applicationsSync.mockResolvedValue({ rows: [application], ok: true, complete: true });
    const { result } = renderHook(() => useManagerBookingEntries(PROPS));
    await flush();
    const ids = residentEntries(result.current.entries).map((entry) => (entry as { applicationId?: string }).applicationId);
    expect(ids).toEqual(["AXIS-1"]);
  });

  it("keeps every snapshot hold when the applications answer was only PART of the list", async () => {
    occupancy.mockResolvedValue({ days: [], stays: [stay(1), stay(2)] });
    const application = {
      id: "AXIS-1",
      bucket: "approved",
      name: "Resident 1",
      propertyId: "house-1",
      assignedRoomChoice: "house-1::r1",
      manualResidentDetails: { moveInDate: "2026-10-05" },
    };
    storedApplicationRows = [application];
    // The route capped (or workspace-raced) its answer: AXIS-2's absence is not its deletion.
    applicationsSync.mockResolvedValue({ rows: [application], ok: true, complete: false });
    const { result } = renderHook(() => useManagerBookingEntries(PROPS));
    await flush();
    const ids = residentEntries(result.current.entries).map((entry) => (entry as { applicationId?: string }).applicationId);
    expect(ids).toEqual(["AXIS-1", "AXIS-2"]);
    expect(result.current.failedSources).toEqual([]);
  });

  it("offers the snapshot's lease residents in the Block dates picker while the lease read is down", async () => {
    occupancy.mockResolvedValue({
      days: [],
      stays: [
        stay(1, {
          kind: "lease",
          resident: { source: "proplane", leaseId: "L-1", residentName: "Resident 1", residentEmail: "r1@example.com" },
        }),
      ],
    });
    const { result } = renderHook(() => useManagerBookingEntries(PROPS));
    await flush();
    expect(result.current.residentOptions).toEqual([
      expect.objectContaining({ key: "email:r1@example.com", name: "Resident 1", email: "r1@example.com" }),
    ]);
  });
});

describe("occupancy resident helpers", () => {
  it("residentEntriesFromStays ignores non-resident stays and keeps lease ids", () => {
    const entries = residentEntriesFromStays(
      [
        { propertyId: "house-1", roomId: "r1", roomLabel: "Room 1", start: "2026-10-01", end: "2026-10-09", kind: "guest", name: "Airbnb guest" },
        stay(1, { kind: "lease", resident: { source: "proplane", leaseId: "L-1", residentName: "Resident 1" } }),
      ],
      (id) => `label:${id}`,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ source: "proplane", leaseId: "L-1", propertyLabel: "label:house-1" });
  });

  it("mergeResidentEntries keys on source + applicationId|leaseId", () => {
    const base = { propertyId: "p", propertyLabel: "P", roomId: "r", roomLabel: "R", summary: "x", start: "2026-01-01", end: "2026-02-01" };
    const merged = mergeResidentEntries(
      [
        { ...base, source: "hold", applicationId: "A" },
        { ...base, source: "proplane", leaseId: "L" },
      ],
      [
        { ...base, source: "hold", applicationId: "A", leaseTerm: "Long-term" },
        { ...base, source: "proplane", leaseId: "L", applicationId: "A" },
        { ...base, source: "hold", applicationId: "B" },
      ],
    );
    expect(merged).toHaveLength(3);
    expect(merged[0].leaseTerm).toBe("Long-term");
  });
});

describe("occupancyStayResident", () => {
  it("carries the resident facts of a hold and none for a channel stay; redaction is applied before it", async () => {
    const { occupancyStayResident } = await import("@/lib/occupancy/snapshot");
    const { withoutResidentFinancials } = await import("@/lib/channel-calendar/property-bookings");
    const hold = {
      source: "hold" as const,
      applicationId: "AXIS-9",
      propertyId: "p",
      propertyLabel: "P",
      roomId: "r",
      roomLabel: "R",
      summary: "Mo",
      start: "2026-10-05",
      end: "2027-01-31",
      residentName: "Mo",
      residentPhone: "+12065550100",
      monthlyRent: 900,
      securityDeposit: 500,
      leaseTerm: "Long-term",
    };
    expect(occupancyStayResident(hold)).toMatchObject({ source: "hold", applicationId: "AXIS-9", monthlyRent: 900, securityDeposit: 500 });
    const redacted = occupancyStayResident(withoutResidentFinancials(hold));
    expect(redacted).not.toHaveProperty("monthlyRent");
    expect(redacted).not.toHaveProperty("securityDeposit");
    expect(redacted).not.toHaveProperty("residentPhone");
    expect(occupancyStayResident({ ...hold, source: "airbnb" })).toBeUndefined();
  });
});
