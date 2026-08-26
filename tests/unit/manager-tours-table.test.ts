/**
 * Tours as a resident-grouped list, matching Payments.
 *
 * The rows are built from `buildScheduledTourMeetings` — the SAME feed the week grid draws — so
 * the table and the grid can never disagree about which tours exist. The two sit behind one tab,
 * and a tour visible in one view but not the other reads as lost data.
 *
 * The status reading is deliberately conservative: anything not positively accepted counts as
 * still awaiting a reply, because telling a manager a tour is confirmed when the guest was never
 * told is how somebody is left standing outside a property.
 */
import { describe, expect, it } from "vitest";
import {
  clusterManagerTourRows,
  pendingTourCount,
  toManagerTourRows,
  tourMeetingConfirmed,
} from "@/lib/manager-tour-rows";

const meeting = (over: Record<string, unknown> = {}) =>
  ({
    id: "m1",
    startIso: "2026-08-26T20:00:00Z",
    endIso: "2026-08-26T20:30:00Z",
    name: "Nayan Taori",
    email: "nayan@example.com",
    phone: "(206) 555-0100",
    propertyTitle: "5259 Brooklyn Ave NE",
    roomLabel: "Room 3",
    statusLabel: "Confirmed",
    kind: "tour",
    ...over,
  }) as never;

describe("tour confirmation reading", () => {
  it("treats an accepted tour as confirmed", () => {
    expect(tourMeetingConfirmed("Confirmed")).toBe(true);
    expect(tourMeetingConfirmed("Co-manager tour")).toBe(true);
  });

  it("treats a requested tour as NOT confirmed", () => {
    expect(tourMeetingConfirmed("Tour requested")).toBe(false);
    expect(tourMeetingConfirmed("Requested")).toBe(false);
  });

  it("treats an unknown or missing status as NOT confirmed", () => {
    // Erring the other way tells a manager a guest has been given a time they never received.
    expect(tourMeetingConfirmed("")).toBe(false);
    expect(tourMeetingConfirmed(undefined)).toBe(false);
    expect(tourMeetingConfirmed(null)).toBe(false);
  });
});

describe("tour rows", () => {
  it("keeps only tours, not other meetings on the same feed", () => {
    const rows = toManagerTourRows([meeting(), meeting({ id: "m2", kind: "partner" })]);
    expect(rows.map((r) => r.id)).toEqual(["m1"]);
  });

  it("treats a meeting with no kind as a tour", () => {
    expect(toManagerTourRows([meeting({ kind: undefined })])).toHaveLength(1);
  });

  it("orders soonest first", () => {
    const rows = toManagerTourRows([
      meeting({ id: "later", startIso: "2026-09-01T20:00:00Z" }),
      meeting({ id: "sooner", startIso: "2026-08-27T20:00:00Z" }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(["sooner", "later"]);
  });

  it("sorts an unparseable time last rather than scrambling the list", () => {
    const rows = toManagerTourRows([
      meeting({ id: "broken", startIso: "nonsense" }),
      meeting({ id: "good", startIso: "2026-08-27T20:00:00Z" }),
    ]);
    expect(rows[0]!.id).toBe("good");
  });

  it("carries the contact details the detail view shows", () => {
    const row = toManagerTourRows([meeting()])[0]!;
    expect(row.residentName).toBe("Nayan Taori");
    expect(row.residentEmail).toBe("nayan@example.com");
    expect(row.residentPhone).toBe("(206) 555-0100");
    expect(row.roomLabel).toBe("Room 3");
    expect(row.confirmed).toBe(true);
  });
});

describe("grouping", () => {
  it("puts one person's tours under a single header", () => {
    const rows = toManagerTourRows([
      meeting({ id: "a", startIso: "2026-08-27T20:00:00Z" }),
      meeting({ id: "b", startIso: "2026-08-28T20:00:00Z" }),
      meeting({ id: "c", email: "someone@example.com", name: "Ahalya Bindhu Rajesh" }),
    ]);
    const clusters = clusterManagerTourRows(rows);
    expect(clusters).toHaveLength(2);
    // Groups appear in soonest-first order, so "c" (Aug 26) heads the list ahead of "a" (Aug 27).
    expect(clusters[0]!.rows.map((r) => r.id)).toEqual(["c"]);
    expect(clusters[1]!.rows.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("counts how many are still awaiting a reply", () => {
    const rows = toManagerTourRows([
      meeting({ id: "a", statusLabel: "Tour requested" }),
      meeting({ id: "b", statusLabel: "Confirmed" }),
      meeting({ id: "c", statusLabel: "Tour requested" }),
    ]);
    expect(pendingTourCount(rows)).toBe(2);
  });

  it("labels the property only when every tour agrees", () => {
    const rows = toManagerTourRows([
      meeting({ id: "a" }),
      meeting({ id: "b", propertyTitle: "4709A 8th Ave NE" }),
    ]);
    expect(clusterManagerTourRows(rows)[0]!.propertyLabel).toBeNull();
  });
});
