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
  RESIDENT_DETAIL_BACKGROUND_CHECK_TABS,
  residentApplicationStatusBucket,
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
    // A retired slug keeps its destination; anything unrecognised lands on Forms, never silently on Placement.
    expect(parseResidentRecordMoveInTab("amenities")).toBe("info");
    expect(parseResidentRecordMoveInTab("zzz")).toBe("forms");
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

describe("Background check tab: one Completed tab", () => {
  it("is a single tab labelled Completed, not the Application buckets", () => {
    expect(RESIDENT_DETAIL_BACKGROUND_CHECK_TABS.map((t) => t.id)).toEqual(["completed"]);
    expect(RESIDENT_DETAIL_BACKGROUND_CHECK_TABS.map((t) => t.label)).toEqual(["Completed"]);
  });

  it("its header offers ordering a check and nothing to upload", () => {
    const ids = recordSections("manager", "resident", { basePath: "/portal" }, "background-check").headerActions.map((a) => a.id);
    expect(ids).toEqual(["run-check"]);
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

  it("the record's top-right icons are Edit and Delete only, on every tab", () => {
    const withTab = (tab?: string) =>
      recordSections("manager", "resident", { basePath: "/portal" }, tab).headerActions.map((a) => a.id);
    expect(withTab()).toEqual(["edit", "delete"]);
    // The record reads the tab-independent set, never the open section's.
    expect(residents).toContain('recordSections("manager", "resident", { basePath: portalBase, residentsTab }).headerActions');
    for (const relocated of ["message", "share", "archive", "setup", "send-application", "send-lease", "upload-for-resident"]) {
      expect(withTab(), relocated).not.toContain(relocated);
    }
  });

  it("no tab header card carries a section title — only its tabs and icons", () => {
    for (const title of ["Application", "Background check", "Lease", "Payments", "Services", "Documents", "Tours", "Communication"]) {
      expect(residents, title).not.toContain(`title="${title}"`);
    }
    expect(read("src/components/portal/move-in-forms/resident-record-move-in-section.tsx")).not.toContain('title="Move in"');
    expect(read("src/components/portal/manager-resident-section-toolbar.tsx")).not.toContain("resident-section-title");
  });

  it("every relocated action is reachable from the tab it moved to", () => {
    const section = (tab: string) =>
      recordSections("manager", "resident", { basePath: "/portal" }, tab).headerActions.map((a) => a.id);
    // Share / Archive are the Overview ⋯; Send invite joins them when there is no login yet.
    expect(section("overview")).toEqual(["share", "archive"]);
    expect(residents).toContain('data-attr="resident-overview-more"');
    expect(residents).toContain('data-attr="resident-overview-setup"');
    // Send application is the Application tab's blue +.
    expect(residents).toContain('{ id: "send-application", label: "Add application"');
    // Lease keeps download only — no bell, no upload, no +.
    expect(section("lease")).toEqual(["download"]);
    // Upload for resident sits with Documents' own +.
    expect(section("documents")).toEqual(["upload-for-resident", "upload"]);
  });

  it("Documents draws its kinds as the header card's tabs, not a second control row", () => {
    expect(residents).toContain("MANAGER_RESIDENT_DOC_TABS");
    expect(residents).toContain("activeId={residentDocumentTab}");
    const panel = read("src/components/portal/manager-resident-documents-panel.tsx");
    expect(panel).not.toContain("LocalDestinationNav");
  });
});

describe("Roommates reads the household from the server", () => {
  const section = read("src/components/portal/move-in-forms/resident-record-move-in-section.tsx");

  it("fetches only while the Roommates sub-tab is open, and never counts the household in a tab badge", () => {
    expect(section).toContain('activeTab === "housemates" && Boolean(applicationId) && !demo');
    expect(section).toContain('count: id === "forms" ? rows.length : undefined');
  });

  it("a failed read is an error with a retry, never 'no residents'", () => {
    expect(section).toContain('data-attr="resident-move-in-roommates-error"');
    expect(section).toContain("failed: true");
  });

  it("the route re-authorizes the property the household is derived from", () => {
    const route = read("src/app/api/manager-applications/[id]/housemates/route.ts");
    expect(route).toContain("propertyIdFromAppRow(row)");
    expect(route).toContain("managerCanAccessApplicationRecord(db, user.id, { property_id: propertyId })");
    expect(route).toContain('"Not authorized for this property."');
  });
});
