/**
 * One Services list over two stores.
 *
 * A manager and a resident think about one pile of work. PropLane keeps it in two: add-on services
 * a resident BUYS, and maintenance a resident REPORTS. The models genuinely differ, and AGENTS.md
 * forbids merging their tables — so this merges the PRESENTATION and nothing else.
 *
 * The invariant that makes that safe: every row keeps its `kind` and its own id, so a click still
 * routes into the right detail surface and a write still lands in the right store. Lose that and
 * the merge stops being cosmetic and starts corrupting data.
 */
import { describe, expect, it } from "vitest";
import {
  addOnState,
  buildUnifiedServiceRows,
  countServiceRowsByState,
  maintenanceState,
  sortServiceRows,
} from "@/lib/unified-service-rows";

describe("state mapping", () => {
  it("maps an add-on request's status", () => {
    expect(addOnState("pending")).toBe("open");
    expect(addOnState("approved")).toBe("scheduled");
    // The item came back — the request is finished.
    expect(addOnState("returned")).toBe("done");
    // Declined is NOT done: filtering for finished work must not surface things that never happened.
    expect(addOnState("denied")).toBe("declined");
  });

  it("maps a work order's bucket", () => {
    expect(maintenanceState("open")).toBe("open");
    expect(maintenanceState("scheduled")).toBe("scheduled");
    expect(maintenanceState("completed")).toBe("done");
    expect(maintenanceState("cancelled")).toBe("declined");
  });

  it("reads an unknown state as open, keeping the row visible", () => {
    // Guessing `done` would hide real work behind a filter nobody thinks to change.
    for (const raw of ["", null, undefined, "wat"]) {
      expect(addOnState(raw)).toBe("open");
      expect(maintenanceState(raw)).toBe("open");
    }
  });
});

describe("building the merged list", () => {
  const addOns = [
    { id: "req-1", offerName: "Parking spot", status: "approved", residentName: "Ahalya", approvedAt: "2026-09-02T17:00:00Z", requestedAt: "2026-08-01T00:00:00Z", propertyId: "prop-1" },
    { id: "req-2", offerName: "Storage unit", status: "pending", residentName: "Ahalya", requestedAt: "2026-08-20T00:00:00Z", propertyId: "prop-1" },
  ];
  const maintenance = [
    { id: "wo-1", title: "Leaking tap", bucket: "scheduled", status: "Scheduled", residentName: "Nayan", propertyName: "5257 Brooklyn Ave NE", unit: "Room 1", scheduledAtIso: "2026-09-01T17:00:00Z" },
    { id: "wo-2", title: "Broken blind", bucket: "open", residentName: "Nayan", propertyName: "5257 Brooklyn Ave NE", createdAtIso: "2026-08-25T00:00:00Z" },
  ];

  it("carries both stores in one list", () => {
    const rows = buildUnifiedServiceRows({ addOns, maintenance });
    expect(rows).toHaveLength(4);
    expect(rows.filter((r) => r.kind === "add-on")).toHaveLength(2);
    expect(rows.filter((r) => r.kind === "maintenance")).toHaveLength(2);
  });

  it("keeps each row's own id and kind, so a click routes to the right store", () => {
    // This is the invariant that keeps the merge cosmetic. Without it a click on an add-on could
    // open a work order, or worse, write to the wrong table.
    const rows = buildUnifiedServiceRows({ addOns, maintenance });
    expect(rows.find((r) => r.id === "req-1")?.kind).toBe("add-on");
    expect(rows.find((r) => r.id === "wo-1")?.kind).toBe("maintenance");
    // Ids from the two stores must not be rewritten or prefixed.
    expect(rows.map((r) => r.id).sort()).toEqual(["req-1", "req-2", "wo-1", "wo-2"]);
  });

  it("puts scheduled work first, soonest at the top", () => {
    // "What is happening next" is the manager's actual question.
    const rows = buildUnifiedServiceRows({ addOns, maintenance });
    expect(rows.slice(0, 2).map((r) => r.id)).toEqual(["wo-1", "req-1"]);
  });

  it("orders unscheduled work newest-first behind the scheduled block", () => {
    const rows = buildUnifiedServiceRows({ addOns, maintenance });
    expect(rows.slice(2).map((r) => r.id)).toEqual(["wo-2", "req-2"]);
  });

  it("resolves an add-on's property through the caller's catalog", () => {
    // The request stores only an id; this module deliberately reads no catalog of its own.
    const rows = buildUnifiedServiceRows({
      addOns,
      maintenance: [],
      propertyLabelForRequest: (id) => (id === "prop-1" ? "5257 Brooklyn Ave NE" : null),
    });
    expect(rows.every((r) => r.propertyLabel === "5257 Brooklyn Ave NE")).toBe(true);
  });

  it("skips rows with no id rather than rendering an unopenable one", () => {
    const rows = buildUnifiedServiceRows({
      addOns: [{ id: "", offerName: "Ghost" }],
      maintenance: [{ id: "", title: "Ghost" }],
    });
    expect(rows).toEqual([]);
  });

  it("falls back to a readable title", () => {
    const rows = buildUnifiedServiceRows({
      addOns: [{ id: "a", offerName: "  " }],
      maintenance: [{ id: "b", title: null }],
    });
    expect(rows.map((r) => r.title).sort()).toEqual(["Add-on service", "Maintenance"]);
  });

  it("treats an unparseable date as unscheduled rather than scrambling the order", () => {
    const rows = sortServiceRows([
      { id: "bad", kind: "maintenance", title: "x", statusLabel: "", state: "open", residentName: "", residentEmail: "", propertyLabel: "", unitLabel: "", scheduledIso: "nonsense", createdIso: "" },
      { id: "good", kind: "maintenance", title: "y", statusLabel: "", state: "scheduled", residentName: "", residentEmail: "", propertyLabel: "", unitLabel: "", scheduledIso: "2026-09-01T00:00:00Z", createdIso: "" },
    ]);
    expect(rows[0]!.id).toBe("good");
  });

  it("counts each state for the filter pills", () => {
    const counts = countServiceRowsByState(buildUnifiedServiceRows({ addOns, maintenance }));
    expect(counts).toEqual({ open: 2, scheduled: 2, done: 0, declined: 0 });
  });
});
