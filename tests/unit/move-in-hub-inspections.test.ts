import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { routeResolves } from "../helpers/route-resolves";
import { PORTAL_NAV_GROUPS, groupNavItems } from "@/lib/portals/nav-groups";
import { proPortal } from "@/lib/portals/pro";
import { NATIVE_BOTTOM_NAV_PRO_MANAGER_ORDER } from "@/lib/native/portal-bottom-nav";
import { PORTAL_SECTION_CO_MANAGER_PERMISSION } from "@/lib/co-manager-permissions";
import { moveInFormTabs } from "@/components/portal/move-in-forms/manager-move-in-forms-panel";
import {
  inspectionDetailHref,
  RESIDENT_MOVE_IN_TABS,
  RESIDENT_MOVE_IN_TAB_LABELS,
  isMoveInFormTabSlug,
  moveInFormListHref,
  moveInInspectionsHref,
  residentDetailTabsForStage,
} from "@/lib/portal-detail-routes";
import {
  filterMoveInForms,
  moveInFormTabCounts,
  moveInFormTabGroups,
} from "@/lib/move-in-forms/manager-rows";
import type { MoveInFormKind, MoveInFormSummary } from "@/lib/move-in-forms/types";

/**
 * The manager's one Move-in page: one tab per form the manager has added (grouped by form name). There
 * is no Inspections tab or sidebar row; the inspections list addresses redirect to Move-in, and a single
 * report keeps its address so the resident record's Inspections tab still opens it.
 */

const CONFIG = readFileSync(join(process.cwd(), "next.config.ts"), "utf8");

function redirectFor(source: string): { destination: string; permanent: string } | null {
  const escaped = source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`source:\\s*"${escaped}",\\s*destination:\\s*"([^"]+)",\\s*permanent:\\s*(true|false)`).exec(CONFIG);
  return match ? { destination: match[1]!, permanent: match[2]! } : null;
}

describe("Move-in page tabs come from the manager's forms", () => {
  it("the sidebar registry has no fixed tabs and no Inspections tab", () => {
    const section = proPortal.sections.find((s) => s.section === "move-in");
    expect(section?.tabs).toEqual([]);
  });

  it("the bare address is the first tab; a form's tab address is its slug", () => {
    expect(moveInFormListHref("/portal")).toBe("/portal/move-in");
    expect(moveInFormListHref("/portal", "intake-form")).toBe("/portal/move-in/intake-form");
    expect(isMoveInFormTabSlug("intake-form")).toBe(true);
    expect(isMoveInFormTabSlug("pet-agreement-2")).toBe(true);
    for (const bad of ["", "Intake Form", "a/b", "-x", "x-", "a--b", "x".repeat(71)]) expect(isMoveInFormTabSlug(bad)).toBe(false);
  });

  it("the page serves the bare address and a slug, and sends the inspections list to Move-in", () => {
    const source = readFileSync(join(process.cwd(), "src/lib/render-portal-section.tsx"), "utf8");
    expect(source).not.toContain("move-in/move-in");
    expect(source).not.toContain('tabParts[0] === "waiting"');
    expect(source).toContain("isMoveInFormTabSlug(moveInTab)");
    expect(source).toContain('if (!tabParts?.[2]) redirect(`${def.basePath}/move-in`)');
    // The manager has no Inspections section handler any more; only the resident one remains.
    expect(source).not.toMatch(/\n {4}if \(section === "inspections"\)/);
    expect(source).toContain('kind === "resident" && section === "inspections"');
  });
});

describe("the page's tab row", () => {
  const groups = moveInFormTabGroups(["Pet agreement", "Intake form", "Key receipt"], []);

  it("is one tab per form, alphabetical, each with its own link and count", () => {
    const tabs = moveInFormTabs("/portal", groups, { "intake-form": 2, "key-receipt": 0, "pet-agreement": 3 });
    expect(tabs.map((t) => t.label)).toEqual(["Intake form", "Key receipt", "Pet agreement"]);
    expect(tabs.map((t) => t.id)).toEqual(["intake-form", "key-receipt", "pet-agreement"]);
    expect(tabs.map((t) => t.count)).toEqual([2, 0, 3]);
    expect(tabs.map((t) => t.href)).toEqual(["/portal/move-in/intake-form", "/portal/move-in/key-receipt", "/portal/move-in/pet-agreement"]);
  });

  it("has no Inspections tab, however many forms there are", () => {
    expect(moveInFormTabs("/portal", groups, {}).map((t) => t.id)).not.toContain("inspections");
    expect(moveInFormTabs("/portal", [], {})).toEqual([]);
  });
});

describe("resident My home", () => {
  it("keeps the forms tab first and labels it Move-in", () => {
    expect(RESIDENT_MOVE_IN_TABS[0]).toBe("forms");
    expect(RESIDENT_MOVE_IN_TAB_LABELS.forms).toBe("Move-in");
  });
});

describe("resident record › Move-in", () => {
  it("is a tab at every stage, potential included; Services stays hidden for a prospect", () => {
    for (const stage of ["potential", "current", "past"] as const) {
      expect(residentDetailTabsForStage(stage)).toContain("move-in");
    }
    expect(residentDetailTabsForStage("potential")).not.toContain("services");
    expect(residentDetailTabsForStage("current")).toContain("services");
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

describe("old inspection URLs redirect to Move-in", () => {
  it("sends every inspections list address to /portal/move-in", () => {
    for (const source of ["/portal/inspections", "/portal/inspections/:kind(move-in|move-out)", "/portal/move-in/inspections", "/portal/move-in/inspections/:kind(move-in|move-out)"]) {
      const hit = redirectFor(source);
      expect(hit?.destination, source).toBe("/portal/move-in");
      expect(hit?.permanent, source).toBe("false");
    }
  });

  it("keeps a single report's address, so an old report link and the resident record still open it", () => {
    const deep = redirectFor("/portal/inspections/:kind(move-in|move-out)/:path+");
    expect(deep?.destination).toBe("/portal/move-in/inspections/:kind/:path+");
    expect(redirectFor("/portal/move-in/inspections/:path*")).toBeNull();
  });

  it("lands on routes that exist", () => {
    const id = "0b2f6a54-9c1d-4e3a-8d2e-7a1f5b6c8d90";
    expect(routeResolves("/portal/move-in")).toBe(true);
    expect(routeResolves(`/portal/move-in/inspections/move-out/${id}`)).toBe(true);
  });

  it("leaves the resident's own /resident/inspections alone", () => {
    expect(redirectFor("/resident/inspections")).toBeNull();
    expect(redirectFor("/resident/inspections/:path*")).toBeNull();
  });
});

describe("inspection record URLs", () => {
  it("keep the kind segment under the Move-in page", () => {
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

describe("A form's tab", () => {
  const submitted = { status: "submitted" as const, submittedAt: "2026-09-29T17:00:00.000Z" };
  const forms = [
    form("intake", { id: "i1", formName: "Intake form" }),
    form("intake", { id: "i2", formName: " intake FORM", ...submitted }),
    form("move-out", { id: "o1", formName: "Move-out form" }),
    form("other", { id: "k1", formName: "Key receipt" }),
    form("intake", { id: "i3", formName: "Intake form", status: "cancelled" }),
  ];

  it("lists sent and submitted copies of one name together, never a cancelled one", () => {
    expect(filterMoveInForms(forms, { formName: "Intake form" }).map((f) => f.id).sort()).toEqual(["i1", "i2"]);
    expect(filterMoveInForms(forms, { formName: "Move-out form" })).toHaveLength(1);
    expect(filterMoveInForms(forms, { formName: "Nothing like it" })).toHaveLength(0);
  });

  it("counts per tab id, with a zero for a form nobody has been sent", () => {
    const groups = moveInFormTabGroups(["Intake form", "Pet agreement"], forms);
    expect(moveInFormTabCounts(groups, forms)).toEqual({ "intake-form": 2, "key-receipt": 1, "move-out-form": 1, "pet-agreement": 0 });
  });

  it("narrows by status", () => {
    expect(filterMoveInForms(forms, { formName: "Intake form", status: "submitted" }).map((f) => f.id)).toEqual(["i2"]);
    expect(filterMoveInForms(forms, { formName: "Intake form", status: "waiting" }).map((f) => f.id)).toEqual(["i1"]);
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
    expect(filterMoveInForms(rows, { formName: "A form" }, now).map((f) => f.id)).toEqual([
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
