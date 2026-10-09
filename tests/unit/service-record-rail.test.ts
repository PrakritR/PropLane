import { describe, expect, it } from "vitest";
import { recordSections } from "@/lib/portals/record-sections";
import {
  DEFAULT_SERVICE_DETAIL_TAB,
  SERVICE_DETAIL_TABS,
  parseServiceDetailTab,
  workOrderDetailHref,
} from "@/lib/portal-detail-routes";

describe("manager service record rail", () => {
  it("is Service · Vendors · (Linked) Incoming payments · Outgoing payments · Communication", () => {
    const sections = recordSections("manager", "service", { basePath: "/portal", serviceKind: "work-order", serviceBucket: "open" });
    const flat = sections.groups.flatMap((group) => group.items.map((item) => `${group.label}|${item.id}|${item.label}`));
    expect(flat).toEqual([
      "Service|service|Service",
      "Service|vendors|Vendors",
      "Linked|incoming-payments|Incoming payments",
      "Linked|outgoing-payments|Outgoing payments",
      "|communication|Communication",
    ]);
    expect(sections.groups.flatMap((g) => g.items.map((i) => i.id))).not.toContain("photos");
    expect(sections.groups.flatMap((g) => g.items.map((i) => i.id))).not.toContain("overview");
  });

  it("routes each rail item to a tab the route parser accepts", () => {
    const sections = recordSections("manager", "service", { basePath: "/portal", serviceKind: "work-order", serviceBucket: "open" });
    for (const item of sections.groups.flatMap((g) => g.items)) {
      expect(parseServiceDetailTab(item.id)).toBe(item.id);
      expect(item.href("wo-1")).toContain("/services/work-orders/open/wo-1");
    }
    expect([...SERVICE_DETAIL_TABS]).toEqual(["service", "vendors", "incoming-payments", "outgoing-payments", "communication"]);
  });

  it("the header is one shape for both kinds: Edit, then the ONE red trash - no Message, Cancel, Delete, Assign or Schedule icon", () => {
    const sections = recordSections("manager", "service", { basePath: "/portal", serviceKind: "request", serviceBucket: "pending" });
    expect(sections.headerActions.map((a) => a.id)).toEqual(["edit", "trash"]);
    expect(sections.headerActions.filter((a) => a.tone === "danger").map((a) => a.id)).toEqual(["trash"]);
    // The add-on rail is the same rail, vendors included.
    expect(sections.groups.flatMap((g) => g.items.map((i) => i.id))).toEqual(["service", "vendors", "incoming-payments", "outgoing-payments", "communication"]);
  });

  it("the Service tab is the bare record URL", () => {
    expect(workOrderDetailHref("/portal", "open", "wo-1")).toBe("/portal/services/work-orders/open/wo-1");
    expect(workOrderDetailHref("/portal", "open", "wo-1", "outgoing-payments")).toBe("/portal/services/work-orders/open/wo-1/outgoing-payments");
  });
});

describe("old service links keep working", () => {
  it("resolves overview and photos to Service, payments and invoice to Incoming payments", () => {
    expect(parseServiceDetailTab("overview")).toBe("service");
    expect(parseServiceDetailTab("photos")).toBe("service");
    expect(parseServiceDetailTab("documents")).toBe("service");
    expect(parseServiceDetailTab("payments")).toBe("incoming-payments");
    expect(parseServiceDetailTab("invoice")).toBe("incoming-payments");
    expect(parseServiceDetailTab("vendor-bids")).toBe("vendors");
    expect(parseServiceDetailTab("schedule")).toBe("vendors");
    expect(parseServiceDetailTab("vendor-schedule")).toBe("vendors");
  });

  it("falls back to the default tab for nothing or nonsense", () => {
    expect(parseServiceDetailTab(undefined)).toBe(DEFAULT_SERVICE_DETAIL_TAB);
    expect(parseServiceDetailTab("nope")).toBe("service");
  });
});
