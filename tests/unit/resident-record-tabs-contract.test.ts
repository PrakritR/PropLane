import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DemoApplicantRow } from "@/data/demo-portal";
import {
  parseResidentDetailTab,
  parseResidentRecordMoveInTab,
  residentDetailTabsForStage,
  residentRecordMoveInHref,
  RESIDENT_DETAIL_TAB_LABELS,
  RESIDENT_MOVE_IN_TABS,
} from "@/lib/portal-detail-routes";
import { recordSections } from "@/lib/portals/record-sections";
import {
  RESIDENT_DETAIL_BACKGROUND_CHECK_BUCKET_TABS,
  residentApplicationStatusBucket,
  residentBackgroundCheckStatusBucket,
} from "@/lib/resident-detail-subsection-tabs";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

const row = (overrides: Partial<DemoApplicantRow> = {}): DemoApplicantRow =>
  ({ id: "PROPLANE-T1", name: "T", property: "P", bucket: "pending", stage: "Submitted", detail: "", email: "t@example.com", ...overrides }) as DemoApplicantRow;

describe("manager resident record: rail order", () => {
  const sections = recordSections("manager", "resident", { basePath: "/portal", residentsTab: "current" });

  it("RESIDENT then HOME, Communication last, no Activity and no Inspections", () => {
    expect(sections.groups.map((g) => [g.label, g.items.map((i) => i.id)])).toEqual([
      ["Resident", ["overview", "tours", "application", "background-check"]],
      ["Home", ["lease", "move-in", "payments", "services", "documents", "communication"]],
    ]);
  });

  it("the stage tab list follows the same order; a prospect has no Services", () => {
    expect(residentDetailTabsForStage("current")).toEqual([
      "overview", "tours", "application", "background-check", "lease", "move-in", "payments", "services", "documents", "communication",
    ]);
    expect(residentDetailTabsForStage("potential")).not.toContain("services");
    expect(residentDetailTabsForStage("potential").at(-1)).toBe("communication");
  });

  it('labels Move in "Move in", not "Move-in forms"', () => {
    expect(RESIDENT_DETAIL_TAB_LABELS["move-in"]).toBe("Move in");
    expect(sections.groups.flatMap((g) => g.items).find((i) => i.id === "move-in")?.label).toBe("Move in");
  });
});

describe("old /inspections links open Move in → Inspections", () => {
  it("parseResidentDetailTab maps inspections to the Move in tab, not Overview", () => {
    expect(parseResidentDetailTab("inspections")).toBe("move-in");
    expect(parseResidentDetailTab("activity")).toBe("overview");
  });

  it("the record keeps the Move in sub-tab in the URL; Forms is the bare address", () => {
    expect(residentRecordMoveInHref("/portal", "current", "AXIS-1", "inspections")).toBe("/portal/residents/current/AXIS-1/move-in/inspections");
    expect(residentRecordMoveInHref("/portal", "current", "AXIS-1", "forms")).toBe("/portal/residents/current/AXIS-1/move-in");
    expect(parseResidentRecordMoveInTab(undefined)).toBe("forms");
    expect(parseResidentRecordMoveInTab("inspections")).toBe("inspections");
    expect(parseResidentRecordMoveInTab("info")).toBe("info");
  });

  it("the Move in sub-tabs are the resident's My home tabs, in their order", () => {
    expect([...RESIDENT_MOVE_IN_TABS]).toEqual(["forms", "placement", "info", "housemates", "inspections"]);
  });

  it("the server redirects /inspections to /move-in/inspections", () => {
    const src = read("src/lib/render-portal-section.tsx");
    expect(src).toContain('residentDetailTabRaw === "inspections"');
    expect(src).toContain("/move-in/inspections");
  });
});

describe("Application tab: Incomplete · Pending · Approved · Rejected", () => {
  it("an unsubmitted (in progress) application is Incomplete; the rest follow the decision bucket", () => {
    expect(residentApplicationStatusBucket(row({ stage: "In progress", application: {} as never }))).toBe("incomplete");
    expect(residentApplicationStatusBucket(row({ stage: "Submitted", application: {} as never }))).toBe("pending");
    expect(residentApplicationStatusBucket(row({ bucket: "approved", stage: "Approved" }))).toBe("approved");
    expect(residentApplicationStatusBucket(row({ bucket: "rejected", stage: "Rejected" }))).toBe("rejected");
  });
});

describe("Background check tab: same four buckets, mapped from the check's status", () => {
  const check = (status: "pending" | "complete", result: "clear" | "consider" | null) =>
    ({ provider: "checkr", candidateId: "c", reportId: "r", packageSlug: "x", status, result, orderedAt: "2026-10-01" }) as unknown as DemoApplicantRow["backgroundCheck"];

  it("labels the tabs like Application", () => {
    expect(RESIDENT_DETAIL_BACKGROUND_CHECK_BUCKET_TABS.map((t) => t.label)).toEqual(["Incomplete", "Pending", "Approved", "Rejected"]);
  });

  it("not run → Incomplete, ordered → Pending, clear → Approved, consider → Rejected", () => {
    const base = { application: {} as never };
    expect(residentBackgroundCheckStatusBucket(row({ ...base, backgroundCheckStatus: "pending_review" }))).toBe("incomplete");
    expect(residentBackgroundCheckStatusBucket(row({ ...base, backgroundCheck: check("pending", null) }))).toBe("pending");
    expect(residentBackgroundCheckStatusBucket(row({ ...base, backgroundCheck: check("complete", "clear") }))).toBe("approved");
    expect(residentBackgroundCheckStatusBucket(row({ ...base, backgroundCheck: check("complete", "consider") }))).toBe("rejected");
  });

  it("a resident with no check at all (not applicable) is Incomplete", () => {
    expect(residentBackgroundCheckStatusBucket(row({ manuallyAdded: true }))).toBe("incomplete");
  });
});

describe("header icons are tab-independent", () => {
  const residents = read("src/components/portal/pro-residents.tsx");

  it("the record publishes its header actions once, and no tab body publishes a second set", () => {
    // `PortalRecordActions` publishes into the single title-actions slot (last one wins), so a second
    // one rendered by a tab body replaced the header icons on that tab.
    expect(residents.match(/<PortalRecordActions\b/g)?.length).toBe(1);
    expect(residents).not.toContain("residentDetailBottomBarActions");
    expect(residents).toContain("actions={residentRecordHeaderActions}");
  });

  it("every tab's own actions live in its section header card, which carries a title", () => {
    for (const title of ["Application", "Background check", "Lease", "Payments", "Services", "Documents", "Tours"]) {
      expect(residents, title).toContain(`title="${title}"`);
    }
    expect(read("src/components/portal/move-in-forms/resident-record-move-in-section.tsx")).toContain('title="Move in"');
    // Communication is the exception: the thread card has its own header (avatar, name, info icon) and fills the page.
    expect(residents).not.toContain('title="Communication"');
  });

  it("the registry header set does not depend on the open section for the record's own header", () => {
    const withTab = (tab: string) => recordSections("manager", "resident", { basePath: "/portal" }, tab).headerActions;
    expect(withTab("overview").map((a) => a.id)).toEqual(withTab("communication").map((a) => a.id));
  });
});
