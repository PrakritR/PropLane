import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DemoApplicantRow } from "@/data/demo-portal";
import {
  isRetiredMoveInFormsTab,
  parseResidentDetailTab,
  parseResidentRecordMoveInTab,
  residentFormsHref,
  residentDetailTabsForStage,
  residentRecordMoveInHref,
  RESIDENT_DETAIL_TAB_LABELS,
  RESIDENT_MOVE_IN_TABS,
  RESIDENT_RECORD_MOVE_IN_TABS,
} from "@/lib/portal-detail-routes";
import { recordSections } from "@/lib/portals/record-sections";
import {
  RESIDENT_DETAIL_BACKGROUND_CHECK_TABS,
  residentApplicationStatusBucket,
  residentBackgroundCheckCompletedCount,
} from "@/lib/resident-detail-subsection-tabs";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

const row = (overrides: Partial<DemoApplicantRow> = {}): DemoApplicantRow =>
  ({ id: "PROPLANE-T1", name: "T", property: "P", bucket: "pending", stage: "Submitted", detail: "", email: "t@example.com", ...overrides }) as DemoApplicantRow;

describe("manager resident record: rail order", () => {
  const sections = recordSections("manager", "resident", { basePath: "/portal", residentsTab: "current" });

  it("RESIDENT then HOME, Communication last, no Activity and no Inspections", () => {
    expect(sections.groups.map((g) => [g.label, g.items.map((i) => i.id)])).toEqual([
      ["Resident", ["overview", "tours", "application", "background-check"]],
      ["Home", ["lease", "forms", "move-in", "payments", "services", "documents", "communication"]],
    ]);
  });

  it("the stage tab list follows the same order; a prospect has no Services", () => {
    expect(residentDetailTabsForStage("current")).toEqual([
      "overview", "tours", "application", "background-check", "lease", "forms", "move-in", "payments", "services", "documents", "communication",
    ]);
    expect(residentDetailTabsForStage("potential")).not.toContain("services");
    expect(residentDetailTabsForStage("potential").at(-1)).toBe("communication");
  });

  it('labels Move in "Move in" and the new tab "Forms", right after Lease', () => {
    expect(RESIDENT_DETAIL_TAB_LABELS["move-in"]).toBe("Move in");
    expect(sections.groups.flatMap((g) => g.items).find((i) => i.id === "move-in")?.label).toBe("Move in");
    expect(RESIDENT_DETAIL_TAB_LABELS.forms).toBe("Forms");
    expect(sections.groups.flatMap((g) => g.items).find((i) => i.id === "forms")?.label).toBe("Forms");
  });

  it("Forms is a rail item with its own addresses: bare is Pending, /completed is Completed", () => {
    expect(residentFormsHref("/portal", "current", "AXIS-1")).toBe("/portal/residents/current/AXIS-1/forms");
    expect(residentFormsHref("/portal", "current", "AXIS-1", "completed")).toBe("/portal/residents/current/AXIS-1/forms/completed");
    expect(parseResidentDetailTab("forms")).toBe("forms");
  });
});

describe("old /inspections links open Move in → Inspections", () => {
  it("parseResidentDetailTab maps inspections to the Move in tab, not Overview", () => {
    expect(parseResidentDetailTab("inspections")).toBe("move-in");
    expect(parseResidentDetailTab("activity")).toBe("overview");
  });

  it("the record keeps the Move in sub-tab in the URL; Placement is the bare address", () => {
    expect(residentRecordMoveInHref("/portal", "current", "AXIS-1", "inspections")).toBe("/portal/residents/current/AXIS-1/move-in/inspections");
    expect(residentRecordMoveInHref("/portal", "current", "AXIS-1", "placement")).toBe("/portal/residents/current/AXIS-1/move-in");
    expect(parseResidentRecordMoveInTab(undefined)).toBe("placement");
    expect(parseResidentRecordMoveInTab("inspections")).toBe("inspections");
    expect(parseResidentRecordMoveInTab("info")).toBe("info");
    // A retired slug keeps its destination; anything unrecognised (including the old forms sub-tab,
    // which the server redirects to the Forms rail item) lands on Placement.
    expect(parseResidentRecordMoveInTab("amenities")).toBe("info");
    expect(parseResidentRecordMoveInTab("zzz")).toBe("placement");
  });

  it("the Move in sub-tabs are Placement · Move-in details · Roommates · Inspections, the resident's My home tabs", () => {
    expect([...RESIDENT_MOVE_IN_TABS]).toEqual(["placement", "info", "housemates", "inspections"]);
    expect([...RESIDENT_RECORD_MOVE_IN_TABS]).toEqual([...RESIDENT_MOVE_IN_TABS]);
  });

  it("the old /move-in/forms record link redirects to the record's Forms tab", () => {
    expect(isRetiredMoveInFormsTab("forms")).toBe(true);
    expect(isRetiredMoveInFormsTab("placement")).toBe(false);
    const src = read("src/lib/render-portal-section.tsx");
    expect(src).toContain('isRetiredMoveInFormsTab(residentDetailItemId)');
    expect(src).toContain("/forms`);");
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
  const check = (status: "pending" | "complete" | "canceled", result: "clear" | "consider" | null) =>
    ({ provider: "checkr", candidateId: "c", reportId: "r", packageSlug: "x", status, result, orderedAt: "2026-10-01" }) as unknown as DemoApplicantRow["backgroundCheck"];

  it("is a single tab labelled Completed, not the Application buckets", () => {
    expect(RESIDENT_DETAIL_BACKGROUND_CHECK_TABS.map((t) => t.id)).toEqual(["completed"]);
    expect(RESIDENT_DETAIL_BACKGROUND_CHECK_TABS.map((t) => t.label)).toEqual(["Completed"]);
  });

  it("counts only a check that came back — a pending or unordered one is 0, not 'Completed 1'", () => {
    expect(residentBackgroundCheckCompletedCount(null)).toBe(0);
    // A submitted application with nothing ordered resolves to `pending_review`, which "applies"
    // but is not finished: counting applicability read 1 while the panel said pending.
    expect(residentBackgroundCheckCompletedCount(row({ application: {} as never }))).toBe(0);
    expect(residentBackgroundCheckCompletedCount(row({ backgroundCheckStatus: "pending_review" }))).toBe(0);
    expect(residentBackgroundCheckCompletedCount(row({ backgroundCheckStatus: "not_applicable" }))).toBe(0);
    expect(residentBackgroundCheckCompletedCount(row({ backgroundCheckStatus: "passed" }))).toBe(1);
    expect(residentBackgroundCheckCompletedCount(row({ backgroundCheckStatus: "flagged" }))).toBe(1);
  });

  it("a report that came back counts whatever it concluded, including 'review'", () => {
    // `backgroundCheckStatusFromScreening` collapses complete + review / not_available back to
    // `pending_review`, and `review` is the DEFAULT recommendation — so reading only the derived
    // status said "Completed 0" beside a panel rendering the finished report.
    const screening = (status: string, recommendation: string) =>
      ({ provider: "internal", status, recommendation, orderedAt: "2026-10-01" }) as unknown as DemoApplicantRow["screening"];
    expect(
      residentBackgroundCheckCompletedCount(row({ screening: screening("complete", "review"), backgroundCheckStatus: "pending_review" })),
    ).toBe(1);
    expect(
      residentBackgroundCheckCompletedCount(row({ screening: screening("complete", "not_available"), backgroundCheckStatus: "pending_review" })),
    ).toBe(1);
    expect(residentBackgroundCheckCompletedCount(row({ screening: screening("in_progress", "review") }))).toBe(0);
    expect(
      residentBackgroundCheckCompletedCount(
        row({ backgroundCheck: check("complete", "clear"), backgroundCheckStatus: "pending_review" }),
      ),
    ).toBe(1);
    expect(residentBackgroundCheckCompletedCount(row({ backgroundCheck: check("pending", null) }))).toBe(0);
  });

  it("an order that died is not a report that came back", () => {
    // The same mapper sends a `failed` / `canceled` screening to `flagged`, so trusting the derived
    // badge read "Completed 1" for an order that never produced anything, beside a panel showing
    // Pending. With an order present its own status decides; the badge is only the no-order fallback.
    const screening = (status: string) =>
      ({ provider: "internal", status, recommendation: "review", orderedAt: "2026-10-01" }) as unknown as DemoApplicantRow["screening"];
    expect(residentBackgroundCheckCompletedCount(row({ screening: screening("failed"), backgroundCheckStatus: "flagged" }))).toBe(0);
    expect(residentBackgroundCheckCompletedCount(row({ screening: screening("canceled"), backgroundCheckStatus: "flagged" }))).toBe(0);
    expect(residentBackgroundCheckCompletedCount(row({ backgroundCheck: check("canceled", null), backgroundCheckStatus: "flagged" }))).toBe(0);
    // No order at all: a result the manager recorded by hand still counts.
    expect(residentBackgroundCheckCompletedCount(row({ backgroundCheckStatus: "flagged" }))).toBe(1);
  });

  it("the body still renders the check panel, so a pending check is visible with its true status", () => {
    const residents = read("src/components/portal/pro-residents.tsx");
    expect(residents).toContain("<ManagerResidentBackgroundCheckPanel row={selectedApplicationRow} />");
    expect(residents).toContain("residentBackgroundCheckCompletedCount(selectedApplicationRow)");
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
    // Overview has no header card (captain, 2026-10-06): no ⋯, no Share, no Archive. Send invite is the
    // lifecycle card's inline action.
    expect(section("overview")).toEqual([]);
    expect(residents).not.toContain('data-attr="resident-overview-more"');
    expect(residents).not.toContain('data-attr="resident-overview-setup"');
    expect(read("src/lib/manager-resident-lifecycle.ts")).toContain('{ label: "Send invite", actionId: "send-setup" }');
    // Send application is the Application tab's blue +.
    expect(read("src/lib/resident-record-section-actions.ts")).toContain('{ id: "send-application", label: "Send application"');
    // ...and the completed-application upload is a Start-from-a-file card inside that pop-up, not a ⋯ item.
    expect(residents).toContain("onUploadCompletedApplication=");
    expect(residents).not.toContain('data-attr="resident-application-more"');
    expect(residents).not.toContain('data-attr="resident-application-upload-completed"');
    // Lease keeps download only — no bell, no upload, no +.
    expect(section("lease")).toEqual(["download"]);
    // Documents has its own + only; Upload for resident is the Upload icon inside that pop-up.
    expect(section("documents")).toEqual(["upload"]);
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
    expect(section).toContain('if (activeTab !== "housemates" || !householdHref) return;');
    expect(section).not.toContain("count:");
  });

  it("only the retry forces a fresh read past the shared-GET cache, and the Button owns its spinner", () => {
    // A counter in state stayed truthy for the component's life, so one Try again made every later
    // open of Roommates — for any resident — re-run the paged household sweep. And the retry has to
    // hand its promise to the Button, or a 15s forced read shows no sign of running.
    expect(section).toContain("sharedGet(householdHref, { force: true })");
    expect(section).toContain("const retryHousehold = useCallback(async () => {");
    expect(section).toContain("onClick={() => retryHousehold()}");
    expect(section).not.toContain("housemateReloads");
  });

  it("an answer that lands after the manager moved on is dropped, not stored under the old record", () => {
    // Storing it would leave the stamp matching nothing: the open record read as still loading,
    // with no retry on screen and no dependency left to change and re-read it.
    expect(section).toContain("viewedApplicationIdRef.current !== requestedFor");
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
