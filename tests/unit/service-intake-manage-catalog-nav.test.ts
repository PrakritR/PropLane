import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { propertyDetailHref, propertyServicesCatalogHref } from "@/lib/portal-detail-routes";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

describe("propertyServicesCatalogHref", () => {
  it("routes a listed house to the Services tab", () => {
    expect(propertyServicesCatalogHref("/portal", "mgr-seed-5257-brooklyn-ave-ne", { mode: "listing" })).toBe(
      propertyDetailHref("/portal", "listed", "mgr-seed-5257-brooklyn-ave-ne", "requests"),
    );
  });

  it("routes a pending draft to drafts/requests", () => {
    expect(propertyServicesCatalogHref("/portal", "draft-1", { mode: "pending" })).toBe(
      "/portal/properties/drafts/draft-1/requests",
    );
  });

  it("returns null without a property or save target", () => {
    expect(propertyServicesCatalogHref("/portal", "", { mode: "listing" })).toBeNull();
    expect(propertyServicesCatalogHref("/portal", "house-1", null)).toBeNull();
  });
});

describe("Add service manage-catalog control", () => {
  it("closes intake and navigates instead of stacking the catalog modal", () => {
    const form = read("src/components/portal/pro-legacy-service-intake-form.tsx");
    expect(form).toContain("propertyServicesCatalogHref");
    expect(form).toContain("onLeaveForCatalog");
    expect(form).not.toContain("ServiceRequestCatalogModal");
    expect(form).not.toContain("setCatalogModalOpen");
    const modal = read("src/components/portal/pro-create-service-request-modal.tsx");
    expect(modal).toContain("onLeaveForCatalog={onClose}");
    expect(modal).not.toContain("onCatalogOpenChange");
  });
});
