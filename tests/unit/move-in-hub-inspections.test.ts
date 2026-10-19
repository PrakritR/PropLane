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
  RESIDENT_MOVE_IN_TABS,
  RESIDENT_MOVE_IN_TAB_LABELS,
  formsListHref,
  isMoveInFormTabSlug,
  parseFormsBucket,
  moveInInspectionsHref,
  residentDetailTabsForStage,
} from "@/lib/portal-detail-routes";
/**
 * The manager's Forms page replaced the Move-in page: Pending · Completed, one list of every form sent to a
 * resident. Move-in keeps no page of its own: the bare address and any old form tab redirect to Forms, and a
 * single inspection report keeps its address so the resident record's Inspections tab still opens it.
 */

const CONFIG = readFileSync(join(process.cwd(), "next.config.ts"), "utf8");

function redirectFor(source: string): { destination: string; permanent: string } | null {
  const escaped = source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`source:\\s*"${escaped}",\\s*destination:\\s*"([^"]+)",\\s*permanent:\\s*(true|false)`).exec(CONFIG);
  return match ? { destination: match[1]!, permanent: match[2]! } : null;
}

describe("Forms page addresses", () => {
  it("the sidebar registry has a Forms section with no fixed tabs, and Move-in is no longer a nav row", () => {
    expect(proPortal.sections.find((s) => s.section === "forms")).toMatchObject({ label: "Forms", tabs: [] });
    expect(PORTAL_NAV_GROUPS.pro.flatMap((g) => g.sections)).not.toContain("move-in");
  });

  it("the bare address is Pending; Completed is its own segment; nothing else is a bucket", () => {
    expect(formsListHref("/portal")).toBe("/portal/forms");
    expect(formsListHref("/portal", "pending")).toBe("/portal/forms");
    expect(formsListHref("/portal", "completed")).toBe("/portal/forms/completed");
    expect(parseFormsBucket("completed")).toBe("completed");
    expect(parseFormsBucket("intake-form")).toBeNull();
    expect(isMoveInFormTabSlug("intake-form")).toBe(true);
    for (const bad of ["", "Intake Form", "a/b", "-x", "x-", "a--b", "x".repeat(71)]) expect(isMoveInFormTabSlug(bad)).toBe(false);
  });

  it("serves Forms, sends the old Move-in page to it, and inspections lists to the Residents list", () => {
    const source = readFileSync(join(process.cwd(), "src/lib/render-portal-section.tsx"), "utf8");
    expect(source).toContain('if (section === "forms")');
    expect(source).toContain("!parseFormsBucket(bucket)");
    expect(source).toContain("redirect(`${def.basePath}/forms`)");
    // An inspections list address is NOT Forms: it belongs with the residents whose records hold them.
    expect(source).toContain('if (!tabParts?.[2]) redirect(`${def.basePath}/residents/current`)');
    // The manager has no Inspections section handler any more; only the resident one remains.
    expect(source).not.toMatch(/\n {4}if \(section === "inspections"\)/);
    expect(source).toContain('kind === "resident" && section === "inspections"');
  });
});

describe("resident My home", () => {
  it("has no Forms tab (Forms is its own section) and opens on the placement", () => {
    expect(RESIDENT_MOVE_IN_TABS as readonly string[]).not.toContain("forms");
    expect(RESIDENT_MOVE_IN_TABS[0]).toBe("placement");
  });

  it("carries Inspections as its own tab, last", () => {
    expect(RESIDENT_MOVE_IN_TABS.at(-1)).toBe("inspections");
    expect(RESIDENT_MOVE_IN_TAB_LABELS.inspections).toBe("Inspections");
  });
});

describe("resident record › Forms and Move in", () => {
  it("are tabs at every stage, potential included, Forms right after Lease; Services stays hidden for a prospect", () => {
    for (const stage of ["potential", "current", "past"] as const) {
      const tabs = residentDetailTabsForStage(stage);
      expect(tabs).toContain("move-in");
      expect(tabs[tabs.indexOf("lease") + 1]).toBe("forms");
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
    expect(PORTAL_SECTION_CO_MANAGER_PERMISSION.forms).toBe("residents");
  });

  it("groups Forms with the leasing paperwork (right after Leases), and the native bar still lists it right after Residents", () => {
    // Phase 1 shell regroup: the sidebar's Leasing group is Tours, Application, Leases, Forms.
    const grouped = groupNavItems("pro", [{ section: "residents" }, { section: "forms" }, { section: "leases" }]);
    expect(grouped.find((g) => g.id === "leasing")?.items.map((i) => i.section)).toEqual(["leases", "forms"]);
    expect(grouped.find((g) => g.id === "people")?.items.map((i) => i.section)).toEqual(["residents"]);
    const order = NATIVE_BOTTOM_NAV_PRO_MANAGER_ORDER as readonly string[];
    expect(order[order.indexOf("residents") + 1]).toBe("forms");
  });

  it("moved the resident's Inspections row into My home", () => {
    expect(PORTAL_NAV_GROUPS.resident.flatMap((g) => g.sections)).not.toContain("inspections");
    expect(PORTAL_NAV_GROUPS.resident.find((g) => g.id === "my-home")?.sections).toContain("move-in");
  });
});

describe("old inspection URLs redirect to the Residents list in one hop", () => {
  it("sends every inspections list address straight to /portal/residents/current", () => {
    for (const source of ["/portal/inspections", "/portal/inspections/:kind(move-in|move-out)", "/portal/move-in/inspections", "/portal/move-in/inspections/:kind(move-in|move-out)"]) {
      const hit = redirectFor(source);
      // One hop, and never Forms: inspections live on a resident's own record now.
      expect(hit?.destination, source).toBe("/portal/residents/current");
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
    expect(routeResolves("/portal/residents/current")).toBe(true);
    expect(routeResolves("/portal/forms")).toBe(true);
    expect(routeResolves("/portal/forms/completed")).toBe(true);
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
