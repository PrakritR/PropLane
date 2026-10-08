// @vitest-environment jsdom
//
// The grouping key each grouped list uses: Residents and Applications group by
// house, Vendors by trade. Plus the three-way sort the Filter popovers offer and
// the rows drawn under a header (the header says the house, so the place line
// drops it).
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import {
  ManagerResidentsGroupedTable,
  RESIDENT_NO_HOUSE_LABEL,
  residentHouseId,
  residentHouseLabel,
} from "@/components/portal/pro-residents-grouped-table";
import {
  ManagerApplicationsGroupedTable,
  applicationClusterLead,
  applicationClusterSize,
} from "@/components/portal/pro-applications-grouped-table";
import type { ManagerResidentListRow } from "@/lib/manager-resident-list";
import type { ApplicationListCluster } from "@/lib/rental-application/application-list-grouping";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { applicationHouseId, applicationHouseLabel, applicationPropertyMeta } from "@/lib/manager-application-list";
import {
  HOUSE_LIST_SORT_OPTIONS,
  groupItems,
  sortHouseListItems,
} from "@/lib/portal-grouped-list";
import {
  VENDOR_OTHER_CATEGORY,
  canonicalVendorCategory,
  vendorCategories,
  vendorCategoryOptions,
  vendorGroupCategory,
  vendorMatchesCategories,
} from "@/lib/vendor-category";

afterEach(cleanup);

const resident = (over: Partial<ManagerResidentListRow> & Pick<ManagerResidentListRow, "id" | "name">): ManagerResidentListRow => ({
  email: "",
  propertyId: "h1",
  propertyLabel: "Alder Row",
  roomLabel: "Room 1",
  leaseStart: "",
  ...over,
});

const application = (over: Partial<DemoApplicantRow> & Pick<DemoApplicantRow, "id" | "name">): DemoApplicantRow =>
  ({
    email: "",
    property: "Alder Row · 3 rooms",
    stage: "Pending review",
    bucket: "pending",
    detail: "",
    assignedRoomChoice: "Room 2",
    ...over,
  }) as DemoApplicantRow;

describe("Residents group by house", () => {
  it("keys a resident by property id and labels by property name; a blank house is the No house bucket", () => {
    const row = resident({ id: "1", name: "Ana", propertyId: "p-9", propertyLabel: "Birch Court" });
    expect(residentHouseLabel(row)).toBe("Birch Court");
    expect(residentHouseId(row)).toBe("p-9");
    expect(residentHouseId(resident({ id: "2", name: "Bo", propertyId: "", propertyLabel: "Cedar" }))).toBe("Cedar");

    const groups = groupItems(
      [
        resident({ id: "a", name: "A", propertyId: "p2", propertyLabel: "Zed House" }),
        resident({ id: "b", name: "B", propertyId: "", propertyLabel: "" }),
        resident({ id: "c", name: "C", propertyId: "p1", propertyLabel: "Alder Row" }),
      ],
      { groupLabel: residentHouseLabel, groupId: residentHouseId, otherLabel: RESIDENT_NO_HOUSE_LABEL },
    );
    expect(groups.map((g) => g.label)).toEqual(["Alder Row", "Zed House", "No house"]);
  });

  it("two houses with one name stay two groups when their property ids differ", () => {
    const groups = groupItems(
      [
        resident({ id: "a", name: "A", propertyId: "p1", propertyLabel: "Maple" }),
        resident({ id: "b", name: "B", propertyId: "p2", propertyLabel: "Maple" }),
      ],
      { groupLabel: residentHouseLabel, groupId: residentHouseId, otherLabel: "No house" },
    );
    expect(groups).toHaveLength(2);
  });

  it("draws rows under a house header with the room only; flat, each row names its house", () => {
    const rows = [resident({ id: "1", name: "Ana" }), resident({ id: "2", name: "Bo", propertyId: "h2", propertyLabel: "Birch Court" })];
    const grouped = render(<ManagerResidentsGroupedTable rows={rows} groupByHouse onOpenResident={() => {}} />);
    const header = grouped.container.querySelector('[data-attr="portal-list-group-header"]') as HTMLElement;
    expect(header.textContent).toContain("Alder Row");
    // Two groups: short list, so open.
    const firstRow = grouped.container.querySelector('[data-attr="resident-list-row"]')!;
    expect(firstRow.textContent).toContain("Room 1");
    expect(firstRow.textContent).not.toContain("Alder Row");
    cleanup();

    const flat = render(<ManagerResidentsGroupedTable rows={rows} onOpenResident={() => {}} />);
    expect(flat.container.querySelector('[data-attr="portal-list-group-header"]')).toBeNull();
    expect(flat.container.querySelector('[data-attr="resident-list-row"]')!.textContent).toContain("Room 1 · Alder Row");
  });
});

describe("Applications group by house", () => {
  it("labels by the property name without its room-count suffix and keys by property id", () => {
    const row = application({ id: "1", name: "Ana", property: "Alder Row · 3 rooms", propertyId: "p-7" } as never);
    expect(applicationHouseLabel(row)).toBe("Alder Row");
    expect(applicationHouseId(row)).toBe("p-7");
    expect(applicationHouseId(application({ id: "2", name: "Bo", property: "Birch Court · 2 rooms" }))).toBe("Birch Court");
  });

  it("drops the house from the place line under a header and counts applications, not households", () => {
    const row = application({ id: "1", name: "Ana" });
    expect(applicationPropertyMeta(row)).toContain("Alder Row");
    expect(applicationPropertyMeta(row, false)).not.toContain("Alder Row");

    const household: ApplicationListCluster = {
      kind: "household",
      groupId: "AXISGRP-1",
      group: null,
      rows: [application({ id: "h1", name: "Cy" }), application({ id: "h2", name: "Di" })],
    };
    const single: ApplicationListCluster = { kind: "single", row: application({ id: "s1", name: "Ed" }) };
    expect(applicationClusterSize(household)).toBe(2);
    expect(applicationClusterSize(single)).toBe(1);
    expect(applicationClusterLead(household)?.id).toBe("h1");

    const { container } = render(
      <ManagerApplicationsGroupedTable
        clusters={[household, single]}
        cosignerSubmissionsBySigner={new Map()}
        groupByHouse
        onOpenApplication={() => {}}
        onOpenCosigner={() => {}}
      />,
    );
    const header = container.querySelector('[data-attr="portal-list-group-header"]') as HTMLElement;
    expect(header.textContent).toContain("Alder Row");
    expect(header.textContent).toContain("3");
    const rows = container.querySelectorAll('[data-attr="application-list-row"]');
    expect(rows).toHaveLength(3);
    expect(rows[0]!.textContent).not.toContain("Alder Row");
    fireEvent.click(header);
    expect(container.querySelectorAll('[data-attr="application-list-row"]')).toHaveLength(0);
  });
});

describe("the House / Name / Recently updated sort", () => {
  const items = [
    { name: "Cy", at: 100 },
    { name: "ana", at: 300 },
    { name: "Bo", at: 200 },
  ];
  const accessors = { name: (i: { name: string }) => i.name, updatedMs: (i: { at: number }) => i.at };
  it("offers House first (the default), then Name, then Recently updated", () => {
    expect(HOUSE_LIST_SORT_OPTIONS.map((o) => o.label)).toEqual(["House", "Name", "Recently updated"]);
    expect(HOUSE_LIST_SORT_OPTIONS[0]!.value).toBe("house");
  });
  it("House and Name list A to Z (case blind); Recently updated is newest first", () => {
    expect(sortHouseListItems(items, "house", accessors).map((i) => i.name)).toEqual(["ana", "Bo", "Cy"]);
    expect(sortHouseListItems(items, "name", accessors).map((i) => i.name)).toEqual(["ana", "Bo", "Cy"]);
    expect(sortHouseListItems(items, "recent", accessors).map((i) => i.at)).toEqual([300, 200, 100]);
  });
});

describe("Vendors group by category (trade)", () => {
  it("normalises free-text trades to the pick list's spelling", () => {
    expect(canonicalVendorCategory("plumbing ")).toBe("Plumbing");
    expect(canonicalVendorCategory("HVAC")).toBe("HVAC");
    expect(canonicalVendorCategory("hvac")).toBe("HVAC");
    expect(canonicalVendorCategory("roofing")).toBe("Roofing");
    expect(canonicalVendorCategory("   ")).toBe("");
  });

  it("lists a vendor's categories primary first, deduped, and files a vendor with no trade under Other", () => {
    expect(vendorCategories({ trade: "Plumbing", trades: ["plumbing", "HVAC"] })).toEqual(["Plumbing", "HVAC"]);
    expect(vendorCategories({ trade: "Electrical" })).toEqual(["Electrical"]);
    expect(vendorCategories({ trade: "" })).toEqual([VENDOR_OTHER_CATEGORY]);
  });

  it("groups hundreds of vendors by category A to Z with Other last", () => {
    const trades = ["Plumbing", "HVAC", "Electrical", "Cleaning", "General maintenance", "Appliance repair", "Landscaping", "Pest control", "Other", ""];
    const vendors = Array.from({ length: 500 }, (_, i) => ({ id: `v${i}`, name: `Vendor ${i}`, trade: trades[i % trades.length]! }));
    const groups = groupItems(vendors, {
      groupLabel: (v) => vendorGroupCategory(v),
      otherLabel: VENDOR_OTHER_CATEGORY,
    });
    expect(groups.map((g) => g.label)).toEqual([
      "Appliance repair",
      "Cleaning",
      "Electrical",
      "General maintenance",
      "HVAC",
      "Landscaping",
      "Pest control",
      "Plumbing",
      "Other",
    ]);
    // "Other" and the blank trade share the catch-all bucket.
    expect(groups[groups.length - 1]!.count).toBe(100);
    expect(groups.reduce((sum, g) => sum + g.count, 0)).toBe(500);
  });

  it("the Category filter keeps a vendor who works in any selected category, filed under the selected one", () => {
    const multi = { trade: "Plumbing", trades: ["Plumbing", "HVAC"] };
    expect(vendorMatchesCategories(multi, [])).toBe(true);
    expect(vendorMatchesCategories(multi, ["hvac"])).toBe(true);
    expect(vendorMatchesCategories(multi, ["Electrical"])).toBe(false);
    expect(vendorGroupCategory(multi)).toBe("Plumbing");
    expect(vendorGroupCategory(multi, ["HVAC"])).toBe("HVAC");
  });

  it("the Category dropdown lists the categories present, A to Z, Other last, plus any already selected", () => {
    const options = vendorCategoryOptions(
      [{ trade: "plumbing" }, { trade: "HVAC" }, { trade: "" }, { trade: "Cleaning", trades: ["Cleaning", "Landscaping"] }],
      ["Roofing"],
    );
    expect(options.map((o) => o.value)).toEqual(["Cleaning", "HVAC", "Landscaping", "Plumbing", "Roofing", "Other"]);
  });
});
