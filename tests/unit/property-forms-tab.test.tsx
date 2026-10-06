/** @vitest-environment jsdom */
// A property's Forms tab (leasing rail: Applications · Lease · Forms · Move-in · Pricing): the
// move-in forms moved out of Move-in. Its header card is the shared underline nav (the Long term /
// Short term stay tabs, with counts), then the gear and the round blue +.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, within } from "@testing-library/react";
import { ManagerPropertyFormsPanel } from "@/components/portal/pro-property-forms-panel";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import { PROPERTY_DETAIL_TABS, parsePropertyDetailTab, propertyDetailTopNavId } from "@/lib/portal-detail-routes";
import { recordSections } from "@/lib/portals/record-sections";

vi.mock("@/hooks/use-portal-session", () => ({
  usePortalSession: () => ({ userId: "mgr-1", email: "m@example.com", ready: true }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/portal/properties/all/p1/forms",
  useSearchParams: () => new URLSearchParams(),
}));

afterEach(() => cleanup());

const read = (file: string) => readFileSync(file, "utf8");

describe("property Forms tab", () => {
  it("is a rail item in Leasing right after Lease, before Move-in", () => {
    const leasing = recordSections("manager", "property").groups.find((group) => group.label === "Leasing")!;
    expect(leasing.items.map((item) => item.id)).toEqual(["application", "lease", "forms", "move-in", "pricing"]);
    expect(leasing.items.find((item) => item.id === "forms")!.label).toBe("Forms");
  });

  it("is a routed detail tab; the old move-in/forms and ?tab=forms links redirect to it", () => {
    expect(PROPERTY_DETAIL_TABS).toContain("forms");
    expect(parsePropertyDetailTab("forms")).toBe("forms");
    expect(propertyDetailTopNavId("forms")).toBe("forms");
    const src = read("src/lib/render-portal-section.tsx");
    expect(src).toContain('propertyDetailTabRaw === "move-in"');
    expect(src).toContain('tabParts[3] === "forms"');
    expect(src).toContain('firstSearchParam(searchParams, "tab") === "forms"');
    expect(src).toMatch(/\/forms`\);/);
  });

  it("draws one header card: stay tabs with counts, the gear and the round + — no search, no Whole house", () => {
    const { container } = render(
      <ManagerPropertyFormsPanel
        sub={createDefaultListingSubmission()}
        saveTarget={{ mode: "listing", saveId: "mgr-test" }}
        managerUserId="mgr-1"
        canEdit
        onUpdated={() => {}}
        showToast={() => {}}
      />,
    );
    const stacks = container.querySelectorAll('[data-slot="portal-list-control-stack"]');
    expect(stacks).toHaveLength(1);
    const stack = stacks[0] as HTMLElement;
    expect(within(stack).getByRole("button", { name: /^Long term/ })).toBeTruthy();
    expect(within(stack).queryByRole("button", { name: /Whole house|Rooms/ })).toBeNull();
    expect(within(stack).getByRole("button", { name: "Move-in settings" })).toBeTruthy();
    expect(within(stack).getByRole("button", { name: "Add move-in form" })).toBeTruthy();
  });

  it("the property record renders the panel for the forms tab, and Move-in no longer mounts forms", () => {
    const record = read("src/components/portal/pro-house-properties-panel.tsx");
    expect(record).toContain('activeDetailTab === "forms"');
    expect(record).toContain("<ManagerPropertyFormsPanel");
    const moveIn = read("src/components/portal/pro-property-room-move-in-panel.tsx");
    expect(moveIn).not.toContain("PropertyMoveInFormsPanel");
    expect(moveIn).not.toContain("formStay");
  });
});
