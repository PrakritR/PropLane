import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { routeResolves } from "../helpers/route-resolves";
import { PORTAL_NAV_GROUPS, groupNavItems } from "@/lib/portals/nav-groups";
import { proPortal } from "@/lib/portals/pro";
import { NATIVE_BOTTOM_NAV_PRO_MANAGER_ORDER } from "@/lib/native/portal-bottom-nav";
import { PORTAL_SECTION_CO_MANAGER_PERMISSION } from "@/lib/co-manager-permissions";
import { moveInHubTabs } from "@/components/portal/move-in-forms/manager-move-in-forms-panel";
import {
  inspectionDetailHref,
  RESIDENT_MOVE_IN_TABS,
  RESIDENT_MOVE_IN_TAB_LABELS,
  moveInFormListHref,
  moveInInspectionsHref,
  MOVE_IN_FORM_LIST_TABS,
  parseMoveInFormListTab,
} from "@/lib/portal-detail-routes";
import {
  filterMoveInForms,
  moveInFormKindLabel,
  moveInFormTabCounts,
  MOVE_IN_FORM_KIND_OPTIONS,
} from "@/lib/move-in-forms/manager-rows";
import type { MoveInFormKind, MoveInFormSummary } from "@/lib/move-in-forms/types";

/**
 * The manager's one Move-in page: Intake | Move-in | Move-out | Inspections (+ Other). There is no Inspections sidebar
 * row; the old URLs redirect into the tab and keep the report id so a deep link still opens it.
 */

const CONFIG = readFileSync(join(process.cwd(), "next.config.ts"), "utf8");

function redirectFor(source: string): { destination: string; permanent: string } | null {
  const escaped = source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`source:\\s*"${escaped}",\\s*destination:\\s*"([^"]+)",\\s*permanent:\\s*(true|false)`).exec(CONFIG);
  return match ? { destination: match[1]!, permanent: match[2]! } : null;
}

describe("Move-in hub tab order", () => {
  it("is Intake, Move-in, Move-out, Inspections in the sidebar registry; Other is only a route", () => {
    const section = proPortal.sections.find((s) => s.section === "move-in");
    expect(section?.tabs.map((t) => t.id)).toEqual(["intake", "move-in", "move-out", "inspections"]);
    expect([...MOVE_IN_FORM_LIST_TABS]).toEqual(["intake", "move-in", "move-out", "inspections", "other"]);
  });

  it("opens on the Move-in form tab", () => {
    expect(parseMoveInFormListTab(undefined)).toBe("move-in");
    expect(parseMoveInFormListTab("nonsense")).toBe("move-in");
    expect(parseMoveInFormListTab("waiting")).toBe("move-in");
    expect(parseMoveInFormListTab("intake")).toBe("intake");
    expect(parseMoveInFormListTab("move-out")).toBe("move-out");
    expect(parseMoveInFormListTab("inspections")).toBe("inspections");
    expect(parseMoveInFormListTab("other")).toBe("other");
    expect(moveInFormListHref("/portal")).toBe("/portal/move-in/move-in");
    expect(moveInFormListHref("/portal", "intake")).toBe("/portal/move-in/intake");
    expect(moveInFormListHref("/portal", "inspections")).toBe("/portal/move-in/inspections");
  });

  it("the page renders a tab per kind of form, and the bare URL and the old Waiting / Submitted URLs land on Move-in", () => {
    const source = readFileSync(join(process.cwd(), "src/lib/render-portal-section.tsx"), "utf8");
    expect(source).toContain("redirect(`${def.basePath}/move-in/move-in`)");
    expect(source).toContain('tabParts[0] === "waiting" || tabParts[0] === "submitted"');
    expect(source).toContain('moveInTab === "inspections"');
    // The manager has no Inspections section handler any more; only the resident one remains.
    expect(source).not.toMatch(/\n {4}if \(section === "inspections"\)/);
    expect(source).toContain('kind === "resident" && section === "inspections"');
  });
});

describe("the hub's tab row", () => {
  const counts = { intake: 2, "move-in": 3, "move-out": 0, other: 0 };

  it("draws Other only when the manager has a custom form (or it is open)", () => {
    expect(moveInHubTabs("/portal", counts).map((t) => t.id)).toEqual(["intake", "move-in", "move-out", "inspections"]);
    expect(moveInHubTabs("/portal", { ...counts, other: 1 }).map((t) => t.id)).toEqual(["intake", "move-in", "move-out", "inspections", "other"]);
    expect(moveInHubTabs("/portal", counts, "other").map((t) => t.id)).toContain("other");
  });

  it("counts each form tab's rows; Inspections carries none", () => {
    const tabs = moveInHubTabs("/portal", counts);
    expect(tabs.map((t) => t.count)).toEqual([2, 3, 0, undefined]);
    expect(tabs.map((t) => t.href)).toEqual(["/portal/move-in/intake", "/portal/move-in/move-in", "/portal/move-in/move-out", "/portal/move-in/inspections"]);
  });
});

describe("resident My home", () => {
  it("keeps the forms tab first and labels it Move-in", () => {
    expect(RESIDENT_MOVE_IN_TABS[0]).toBe("forms");
    expect(RESIDENT_MOVE_IN_TAB_LABELS.forms).toBe("Move-in");
  });
});

describe("Inspections left the manager sidebar", () => {
  it("is not a manager section, nav row, native bar slot or co-manager mapping", () => {
    expect(proPortal.sections.some((s) => s.section === "inspections")).toBe(false);
    expect(PORTAL_NAV_GROUPS.pro.flatMap((g) => g.sections)).not.toContain("inspections");
    expect(NATIVE_BOTTOM_NAV_PRO_MANAGER_ORDER as readonly string[]).not.toContain("inspections");
    expect(PORTAL_SECTION_CO_MANAGER_PERMISSION.inspections).toBeUndefined();
    // The tab still follows the residents grant through its parent section.
    expect(PORTAL_SECTION_CO_MANAGER_PERMISSION["move-in"]).toBe("residents");
  });

  it("groups Move-in with Residents and Payments under Tenancy", () => {
    const grouped = groupNavItems("pro", [{ section: "residents" }, { section: "move-in" }, { section: "payments" }]);
    expect(grouped.find((g) => g.id === "tenancy")?.items.map((i) => i.section)).toEqual(["residents", "move-in", "payments"]);
  });

  it("keeps the resident's own Inspections row", () => {
    expect(PORTAL_NAV_GROUPS.resident.find((g) => g.id === "my-home")?.sections).toContain("inspections");
  });
});

describe("old inspection URLs redirect into the Inspections tab", () => {
  it("redirects the list and every deep link, preserving the report path", () => {
    const list = redirectFor("/portal/inspections");
    expect(list?.destination).toBe("/portal/move-in/inspections");
    const deep = redirectFor("/portal/inspections/:path*");
    expect(deep?.destination).toBe("/portal/move-in/inspections/:path*");
    expect(list?.permanent).toBe("false");
    expect(deep?.permanent).toBe("false");
  });

  it("lands on routes that exist", () => {
    const id = "0b2f6a54-9c1d-4e3a-8d2e-7a1f5b6c8d90";
    expect(routeResolves("/portal/move-in/inspections")).toBe(true);
    expect(routeResolves(`/portal/move-in/inspections/move-out/${id}`)).toBe(true);
  });

  it("leaves the resident's own /resident/inspections alone", () => {
    expect(redirectFor("/resident/inspections")).toBeNull();
    expect(redirectFor("/resident/inspections/:path*")).toBeNull();
  });
});

describe("inspection record URLs", () => {
  it("live under the Move-in page and keep the kind segment", () => {
    expect(moveInInspectionsHref("/portal")).toBe("/portal/move-in/inspections");
    expect(moveInInspectionsHref("/portal", "move-out")).toBe("/portal/move-in/inspections/move-out");
    expect(inspectionDetailHref("/portal", "move-in", "abc")).toBe("/portal/move-in/inspections/move-in/abc");
    expect(inspectionDetailHref("/portal", "move-out", "a b", "rooms")).toBe("/portal/move-in/inspections/move-out/a%20b/rooms");
  });
});

function form(kind: MoveInFormKind | undefined, patch: Partial<MoveInFormSummary> = {}): MoveInFormSummary {
  return {
    id: `f-${kind ?? "none"}-${patch.status ?? "sent"}`,
    applicationId: "app-1",
    managerUserId: "m1",
    propertyId: "p1",
    propertyLabel: "5257 Brooklyn Ave",
    roomLabel: "Room 5",
    residentName: "Atlas Bailly",
    residentEmail: "atlas@example.com",
    formId: "starter",
    formName: "A form",
    source: "built",
    status: "sent",
    signedDocumentSha256: null,
    sentAt: "2026-09-28T17:00:00.000Z",
    dueAt: null,
    submittedAt: null,
    remindedAt: null,
    managerViewedAt: null,
    kind: kind as MoveInFormKind,
    questionCount: 1,
    photoCount: 0,
    signed: false,
    ...patch,
  };
}

describe("Form tabs by kind", () => {
  const submitted = { status: "submitted" as const, submittedAt: "2026-09-29T17:00:00.000Z" };
  const forms = [
    form("intake"),
    form("move-in"),
    form("move-out"),
    form("other"),
    form("intake", submitted),
    form("move-out", submitted),
    form("move-in", { status: "cancelled" }),
  ];

  it("offers Intake, Move-in, Move-out, Other in that order", () => {
    expect(MOVE_IN_FORM_KIND_OPTIONS.map((o) => o.label)).toEqual(["Intake", "Move-in", "Move-out", "Other"]);
    expect(moveInFormKindLabel("move-out")).toBe("Move-out");
    expect(moveInFormKindLabel(undefined)).toBe("Other");
  });

  it("lists sent and submitted copies together on each kind's tab, never a cancelled one", () => {
    expect(filterMoveInForms(forms, { tab: "intake" }).map((f) => f.status).sort()).toEqual(["sent", "submitted"]);
    expect(filterMoveInForms(forms, { tab: "move-out" })).toHaveLength(2);
    expect(filterMoveInForms(forms, { tab: "move-in" })).toHaveLength(1);
    expect(filterMoveInForms(forms, { tab: "other" })).toHaveLength(1);
    expect(moveInFormTabCounts(forms)).toEqual({ intake: 2, "move-in": 1, "move-out": 2, other: 1 });
  });

  it("narrows by status", () => {
    expect(filterMoveInForms(forms, { tab: "intake", status: "submitted" })).toHaveLength(1);
    expect(filterMoveInForms(forms, { tab: "intake", status: "waiting" })).toHaveLength(1);
  });

  it("reads a copy sent before kinds existed as Other", () => {
    const legacy = form(undefined);
    expect(filterMoveInForms([legacy], { tab: "other" })).toHaveLength(1);
    expect(filterMoveInForms([legacy], { tab: "intake" })).toHaveLength(0);
  });

  it("orders late first, then waiting by due date, then submitted newest first", () => {
    const now = new Date("2026-10-03T19:00:00.000Z");
    const rows = [
      form("move-in", { id: "sub-old", ...submitted, submittedAt: "2026-09-20T17:00:00.000Z" }),
      form("move-in", { id: "sub-new", ...submitted, submittedAt: "2026-10-01T17:00:00.000Z" }),
      form("move-in", { id: "wait-late-soon", dueAt: "2026-10-04T20:00:00.000Z" }),
      form("move-in", { id: "wait-none", dueAt: null }),
      form("move-in", { id: "wait-later", dueAt: "2026-10-09T20:00:00.000Z" }),
      form("move-in", { id: "late-1", dueAt: "2026-10-02T20:00:00.000Z" }),
      form("move-in", { id: "late-5", dueAt: "2026-09-28T20:00:00.000Z" }),
    ];
    expect(filterMoveInForms(rows, { tab: "move-in" }, now).map((f) => f.id)).toEqual([
      "late-5",
      "late-1",
      "wait-late-soon",
      "wait-later",
      "wait-none",
      "sub-new",
      "sub-old",
    ]);
  });
});
