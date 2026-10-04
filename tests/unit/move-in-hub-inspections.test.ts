import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { routeResolves } from "../helpers/route-resolves";
import { PORTAL_NAV_GROUPS, groupNavItems } from "@/lib/portals/nav-groups";
import { proPortal } from "@/lib/portals/pro";
import { NATIVE_BOTTOM_NAV_PRO_MANAGER_ORDER } from "@/lib/native/portal-bottom-nav";
import { PORTAL_SECTION_CO_MANAGER_PERMISSION } from "@/lib/co-manager-permissions";
import {
  inspectionDetailHref,
  moveInFormListHref,
  moveInInspectionsHref,
  MOVE_IN_FORM_LIST_TABS,
  parseMoveInFormListTab,
} from "@/lib/portal-detail-routes";
import {
  filterMoveInForms,
  moveInFormKindLabel,
  MOVE_IN_FORM_KIND_OPTIONS,
} from "@/lib/move-in-forms/manager-rows";
import type { MoveInFormKind, MoveInFormSummary } from "@/lib/move-in-forms/types";

/**
 * The manager's one Move-in page: Waiting | Submitted | Inspections. There is no Inspections sidebar
 * row; the old URLs redirect into the tab and keep the report id so a deep link still opens it.
 */

const CONFIG = readFileSync(join(process.cwd(), "next.config.ts"), "utf8");

function redirectFor(source: string): { destination: string; permanent: string } | null {
  const escaped = source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`source:\\s*"${escaped}",\\s*destination:\\s*"([^"]+)",\\s*permanent:\\s*(true|false)`).exec(CONFIG);
  return match ? { destination: match[1]!, permanent: match[2]! } : null;
}

describe("Move-in hub tab order", () => {
  it("is Waiting, Submitted, Inspections, in the sidebar registry and the route helpers", () => {
    const section = proPortal.sections.find((s) => s.section === "move-in");
    expect(section?.tabs.map((t) => t.id)).toEqual(["waiting", "submitted", "inspections"]);
    expect([...MOVE_IN_FORM_LIST_TABS]).toEqual(["waiting", "submitted", "inspections"]);
  });

  it("opens on Waiting", () => {
    expect(parseMoveInFormListTab(undefined)).toBe("waiting");
    expect(parseMoveInFormListTab("nonsense")).toBe("waiting");
    expect(parseMoveInFormListTab("submitted")).toBe("submitted");
    expect(parseMoveInFormListTab("inspections")).toBe("inspections");
    expect(moveInFormListHref("/portal")).toBe("/portal/move-in/waiting");
    expect(moveInFormListHref("/portal", "submitted")).toBe("/portal/move-in/submitted");
    expect(moveInFormListHref("/portal", "inspections")).toBe("/portal/move-in/inspections");
  });

  it("the page renders the hub for waiting, submitted and inspections, and Waiting is the bare-URL default", () => {
    const source = readFileSync(join(process.cwd(), "src/lib/render-portal-section.tsx"), "utf8");
    expect(source).toContain("redirect(`${def.basePath}/move-in/waiting`)");
    expect(source).toContain('moveInTab === "inspections"');
    // The manager has no Inspections section handler any more; only the resident one remains.
    expect(source).not.toMatch(/\n {4}if \(section === "inspections"\)/);
    expect(source).toContain('kind === "resident" && section === "inspections"');
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

describe("Form filter by kind", () => {
  const forms = [
    form("intake"),
    form("move-in"),
    form("move-out"),
    form("other"),
    form("intake", { status: "submitted", submittedAt: "2026-09-29T17:00:00.000Z" }),
    form("move-out", { status: "submitted", submittedAt: "2026-09-29T17:00:00.000Z" }),
  ];

  it("offers Intake, Move-in, Move-out, Other in that order", () => {
    expect(MOVE_IN_FORM_KIND_OPTIONS.map((o) => o.label)).toEqual(["Intake", "Move-in", "Move-out", "Other"]);
    expect(moveInFormKindLabel("move-out")).toBe("Move-out");
    expect(moveInFormKindLabel(undefined)).toBe("Other");
  });

  it("narrows each tab to one kind", () => {
    expect(filterMoveInForms(forms, { tab: "waiting", kind: "intake" }).map((f) => f.kind)).toEqual(["intake"]);
    expect(filterMoveInForms(forms, { tab: "waiting", kind: "move-out" }).map((f) => f.kind)).toEqual(["move-out"]);
    expect(filterMoveInForms(forms, { tab: "submitted", kind: "move-out" })).toHaveLength(1);
    expect(filterMoveInForms(forms, { tab: "submitted", kind: "move-in" })).toHaveLength(0);
    expect(filterMoveInForms(forms, { tab: "waiting" })).toHaveLength(4);
  });

  it("reads a copy sent before kinds existed as Other", () => {
    const legacy = form(undefined);
    expect(filterMoveInForms([legacy], { tab: "waiting", kind: "other" })).toHaveLength(1);
    expect(filterMoveInForms([legacy], { tab: "waiting", kind: "intake" })).toHaveLength(0);
  });
});
