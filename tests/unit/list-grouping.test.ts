/**
 * `src/lib/portals/list-grouping.ts` — the per-list group/sort catalog, the
 * pure grouping engine, and the URL round-trip it drives
 * (PLAN-0921-1029 "Grouping & sort"). Sort applies inside each group;
 * `Group = "none"` sorts the flat list; an unknown group/sort value falls
 * back to the list's default rather than throwing.
 */
import { describe, expect, it } from "vitest";
import type { DemoManagerPaymentLedgerRow } from "@/data/demo-portal";
import {
  PORTAL_LIST_GROUP_NONE,
  groupAndSortPaymentLedgerRows,
  groupAndSortPortalListRows,
  portalListGroupSortCatalog,
  readPortalListGroupSortParams,
  resolvePortalListGroup,
  resolvePortalListSort,
  withPortalListGroupSortParams,
  type PortalListGrouper,
} from "@/lib/portals/list-grouping";

function chargeRow(overrides: Partial<DemoManagerPaymentLedgerRow>): DemoManagerPaymentLedgerRow {
  return {
    id: "row-1",
    propertyName: "Lakeview Studio",
    roomNumber: "Studio",
    residentName: "Test Resident",
    residentEmail: "resident@test.proplane.local",
    chargeTitle: "Rent · Oct 2026",
    lineAmount: "$1,800.00",
    amountPaid: "$0.00",
    balanceDue: "$1,800.00",
    dueDate: "Oct 1, 2026",
    dueDateSortMs: Date.parse("2026-10-01"),
    bucket: "pending",
    statusLabel: "Pending",
    notes: "",
    ...overrides,
  };
}

describe("portalListGroupSortCatalog", () => {
  it("ships the plan's table for every list", () => {
    const payments = portalListGroupSortCatalog("payments");
    expect(payments.groupOptions.map((o) => o.value)).toEqual(["resident", "property", "month-due", "charge-type", "none"]);
    expect(payments.defaultGroup).toBe("resident");
    expect(payments.sortOptions.map((o) => o.value)).toEqual(["due-date", "amount", "name", "updated"]);
    expect(payments.defaultSort).toBe("due-date");

    const properties = portalListGroupSortCatalog("properties");
    expect(properties.groupOptions.map((o) => o.value)).toEqual(["none"]);

    const residents = portalListGroupSortCatalog("residents");
    expect(residents.groupOptions.map((o) => o.value)).toEqual(["none", "property"]);
    expect(residents.defaultGroup).toBe("none");

    const vendors = portalListGroupSortCatalog("vendors");
    expect(vendors.groupOptions.map((o) => o.value)).toEqual(["none", "trade"]);
  });
});

describe("resolvePortalListGroup / resolvePortalListSort", () => {
  it("falls back to the list's default rather than throwing on an unknown value", () => {
    expect(resolvePortalListGroup("payments", "not-a-real-group")).toBe("resident");
    expect(resolvePortalListGroup("payments", null)).toBe("resident");
    expect(resolvePortalListGroup("payments", undefined)).toBe("resident");
    expect(resolvePortalListSort("payments", "not-a-real-sort")).toBe("due-date");
    // A real value from one list is not real for another.
    expect(resolvePortalListGroup("properties", "resident")).toBe(PORTAL_LIST_GROUP_NONE);
  });
});

describe("groupAndSortPortalListRows (generic engine)", () => {
  type Widget = { id: string; bucket: "a" | "b"; n: number };
  const widgets: Widget[] = [
    { id: "w1", bucket: "a", n: 3 },
    { id: "w2", bucket: "b", n: 1 },
    { id: "w3", bucket: "a", n: 2 },
    { id: "w4", bucket: "b", n: 4 },
  ];
  const grouper: PortalListGrouper<Widget> = {
    groupOf: (row, group) => (group === "bucket" ? { key: row.bucket, name: row.bucket } : null),
    summarize: (rows) => ({ count: `${rows.length}` }),
    compare: (a, b) => a.n - b.n,
  };

  it("never throws on an unknown group value and falls back to the list default", () => {
    // "properties" catalog only has a "none" group option, so any non-"none" value is unknown.
    expect(() => groupAndSortPortalListRows(widgets, "properties", grouper, "bucket", "name")).not.toThrow();
    const flat = groupAndSortPortalListRows(widgets, "properties", grouper, "bucket", "name");
    expect(flat).toHaveLength(1);
    expect(flat[0]!.rows).toHaveLength(4);
  });

  it("groups rows and each group's rows equal the exact subset that belongs to it", () => {
    const buckets = groupAndSortPortalListRows(widgets, "tasks", { ...grouper, groupOf: (row) => ({ key: row.bucket, name: row.bucket }) }, "property", "due-date");
    const flatIds = buckets.flatMap((b) => b.rows.map((r) => r.id)).sort();
    expect(flatIds).toEqual(["w1", "w2", "w3", "w4"]);
    for (const bucket of buckets) {
      for (const row of bucket.rows) expect(row.bucket).toBe(bucket.key);
      expect(bucket.summary.count).toBe(`${bucket.rows.length}`);
    }
  });

  it("sorts within each group and Group=none sorts the flat list", () => {
    const grouped = groupAndSortPortalListRows(widgets, "tasks", { ...grouper, groupOf: (row) => ({ key: row.bucket, name: row.bucket }) }, "property", "n");
    for (const bucket of grouped) {
      const ns = bucket.rows.map((r) => r.n);
      expect(ns).toEqual([...ns].sort((a, b) => a - b));
    }

    const flat = groupAndSortPortalListRows(widgets, "tasks", grouper, PORTAL_LIST_GROUP_NONE, "n");
    expect(flat).toHaveLength(1);
    expect(flat[0]!.rows.map((r) => r.n)).toEqual([1, 2, 3, 4]);
  });
});

describe("Payments grouping — the proof case", () => {
  const rows: DemoManagerPaymentLedgerRow[] = [
    chargeRow({ id: "c1", residentName: "Test Resident", residentEmail: "resident@test.proplane.local", propertyName: "Lakeview Studio", balanceDue: "$1,800.00", bucket: "pending", dueDateSortMs: Date.parse("2026-10-01") }),
    chargeRow({ id: "c2", residentName: "Test Resident", residentEmail: "resident@test.proplane.local", propertyName: "Lakeview Studio", chargeTitle: "Security deposit", balanceDue: "$650.00", bucket: "overdue", dueDateSortMs: Date.parse("2026-09-30") }),
    chargeRow({ id: "c3", residentName: "Maya Chen", residentEmail: "maya@test.proplane.local", propertyName: "Cascade Lofts", balanceDue: "$1,900.00", bucket: "pending", dueDateSortMs: Date.parse("2026-10-01") }),
    chargeRow({ id: "c4", residentName: "Maya Chen", residentEmail: "maya@test.proplane.local", propertyName: "Cascade Lofts", chargeTitle: "Rent · Sep 2026", balanceDue: "$1,900.00", bucket: "paid", dueDateSortMs: Date.parse("2026-09-01") }),
  ];

  it("defaults to Resident, and each group's rows are exactly that resident's rows", () => {
    const buckets = groupAndSortPaymentLedgerRows(rows, undefined, undefined);
    expect(buckets).toHaveLength(2);
    const testResident = buckets.find((b) => b.name === "Test Resident")!;
    expect(testResident.rows.map((r) => r.id).sort()).toEqual(["c1", "c2"]);
    const maya = buckets.find((b) => b.name === "Maya Chen")!;
    expect(maya.rows.map((r) => r.id).sort()).toEqual(["c3", "c4"]);
  });

  it("sums the group's owed total from exactly the rows it contains", () => {
    const buckets = groupAndSortPaymentLedgerRows(rows, "resident", "due-date");
    const testResident = buckets.find((b) => b.name === "Test Resident")!;
    // c1 (pending $1,800) + c2 (overdue $650) — a paid row (c4's shape) never counts toward "due".
    expect(testResident.summary.figure).toBe("$2,450 due");
    expect(testResident.summary.count).toBe("2 charges");
    const maya = buckets.find((b) => b.name === "Maya Chen")!;
    // Only c3 is owed; c4 is paid, so it heads into "Paid this year" instead.
    expect(maya.summary.figure).toBe("$1,900 due");
    expect(maya.summary.count).toBe("1 charge");
  });

  it("marks the Resident group's identity so a row inside it knows the header already names the resident", () => {
    const byResident = groupAndSortPaymentLedgerRows(rows, "resident", "due-date");
    expect(byResident.every((bucket) => bucket.identity === "resident")).toBe(true);

    // Any other grouping — or none — does not name the resident, so a row
    // inside it must still name its own resident.
    const byProperty = groupAndSortPaymentLedgerRows(rows, "property", "due-date");
    expect(byProperty.every((bucket) => bucket.identity === undefined)).toBe(true);
    const byMonth = groupAndSortPaymentLedgerRows(rows, "month-due", "due-date");
    expect(byMonth.every((bucket) => bucket.identity === undefined)).toBe(true);
    const byChargeType = groupAndSortPaymentLedgerRows(rows, "charge-type", "due-date");
    expect(byChargeType.every((bucket) => bucket.identity === undefined)).toBe(true);
    const none = groupAndSortPaymentLedgerRows(rows, PORTAL_LIST_GROUP_NONE, "due-date");
    expect(none.every((bucket) => bucket.identity === undefined)).toBe(true);
  });

  it("sums a group's 'Paid this year' from what a paid charge actually paid (lineAmount), never its now-zero balanceDue", () => {
    const paidRows: DemoManagerPaymentLedgerRow[] = [
      chargeRow({
        id: "p1",
        residentName: "Test Resident",
        residentEmail: "resident@test.proplane.local",
        chargeTitle: "Rent · Aug 2026",
        lineAmount: "$1,800.00",
        // A paid charge's balance is $0.00 — a non-empty, truthy string that
        // must not win over lineAmount when totalling what was paid.
        balanceDue: "$0.00",
        bucket: "paid",
        dueDateSortMs: Date.parse("2026-08-01"),
      }),
      chargeRow({
        id: "p2",
        residentName: "Test Resident",
        residentEmail: "resident@test.proplane.local",
        chargeTitle: "Rent · Jul 2026",
        lineAmount: "$1,800.00",
        balanceDue: "$0.00",
        bucket: "paid",
        dueDateSortMs: Date.parse("2026-07-01"),
      }),
    ];
    const buckets = groupAndSortPaymentLedgerRows(paidRows, "resident", "due-date");
    const testResident = buckets.find((b) => b.name === "Test Resident")!;
    expect(testResident.summary.extra).toBe("Paid this year · $3,600");
  });

  it("sorts within each group by the resolved sort (amount, descending)", () => {
    const buckets = groupAndSortPaymentLedgerRows(rows, "resident", "amount");
    for (const bucket of buckets) {
      const amounts = bucket.rows.map((r) => Number.parseFloat(r.balanceDue.replace(/[^0-9.]/g, "")));
      expect(amounts).toEqual([...amounts].sort((a, b) => b - a));
    }
  });

  it("Group=none sorts the flat list by due date", () => {
    const buckets = groupAndSortPaymentLedgerRows(rows, PORTAL_LIST_GROUP_NONE, "due-date");
    expect(buckets).toHaveLength(1);
    // Ascending by due date: c4 (Sep 1) · c2 (Sep 30) · c1 = c3 (Oct 1, tie keeps input order).
    expect(buckets[0]!.rows.map((r) => r.id)).toEqual(["c4", "c2", "c1", "c3"]);
  });

  it("falls back to the default group rather than throwing on an unknown value", () => {
    expect(() => groupAndSortPaymentLedgerRows(rows, "not-a-real-group", "not-a-real-sort")).not.toThrow();
    const fallback = groupAndSortPaymentLedgerRows(rows, "not-a-real-group", "not-a-real-sort");
    const byResident = groupAndSortPaymentLedgerRows(rows, "resident", "due-date");
    expect(fallback.map((b) => b.key).sort()).toEqual(byResident.map((b) => b.key).sort());
  });
});

describe("URL round-trip", () => {
  it("reads group/sort off a URLSearchParams, falling back to defaults", () => {
    const params = new URLSearchParams("group=property&sort=amount");
    expect(readPortalListGroupSortParams("payments", params)).toEqual({ group: "property", sort: "amount" });
    expect(readPortalListGroupSortParams("payments", new URLSearchParams())).toEqual({ group: "resident", sort: "due-date" });
    expect(readPortalListGroupSortParams("payments", new URLSearchParams("group=bogus&sort=bogus"))).toEqual({
      group: "resident",
      sort: "due-date",
    });
  });

  it("round-trips through withPortalListGroupSortParams and back", () => {
    const current = new URLSearchParams("tab=pending&other=1");
    const next = withPortalListGroupSortParams(current, { group: "property", sort: "amount" });
    expect(next.get("tab")).toBe("pending");
    expect(next.get("other")).toBe("1");
    const resolved = readPortalListGroupSortParams("payments", next);
    expect(resolved).toEqual({ group: "property", sort: "amount" });
  });

  it("also reads a plain query-object shape (server-rendered searchParams)", () => {
    expect(readPortalListGroupSortParams("payments", { group: "month-due", sort: ["amount", "extra"] })).toEqual({
      group: "month-due",
      sort: "amount",
    });
  });
});
