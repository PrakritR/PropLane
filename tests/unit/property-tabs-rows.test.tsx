/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { PropertyServicesOffersPanel, offerPriceFact } from "@/components/portal/property-services-offers-panel";
import { ZillowRentalNetworkRow } from "@/components/portal/zillow-rental-network-row";
import { LocalDestinationNav } from "@/components/ui/destination-nav";
import { createDefaultListingSubmission, createManagerListingServiceOption } from "@/lib/manager-listing-submission";

vi.mock("next/navigation", () => ({ usePathname: () => "/portal/properties/all/p1", useRouter: () => ({ push: () => {} }) }));

afterEach(cleanup);

const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");

describe("Services tab rows (studio-redesign property-tabs)", () => {
  function servicesSub() {
    const sub = createDefaultListingSubmission();
    sub.serviceRequestOptions = [
      { ...createManagerListingServiceOption(), id: "s1", name: "Cleaning", price: "$40", billingCadence: "per_request", available: true },
      { ...createManagerListingServiceOption(), id: "s2", name: "Parking", price: "$100", billingCadence: "monthly", available: false },
    ];
    return sub;
  }

  it("a service row is tile · title · price fact · exactly one ⋯, under one header card", () => {
    const { container } = render(
      <PropertyServicesOffersPanel
        sub={servicesSub()}
        saveTarget={{ mode: "listing", saveId: "p1" }}
        managerUserId="mgr-1"
        propertyLabel="Alder"
        onUpdated={() => {}}
        showToast={() => {}}
      />,
    );
    expect(container.querySelectorAll('[data-slot="portal-list-control-stack"]')).toHaveLength(1);
    const row = container.querySelector(".portal-property-row")!;
    expect(row.querySelector('[data-slot="portal-row-icon-tile"]')).toBeTruthy();
    expect(row.querySelector('[data-attr="record-row-facts"]')!.textContent).toContain("$40 · Per request");
    expect(row.querySelectorAll('button[aria-label^="Actions for"]')).toHaveLength(1);
    expect(within(container).getByRole("button", { name: "Services" })).toBeTruthy();
    expect(within(container).queryByRole("button", { name: "Service settings" })).toBeNull();
    const rows = container.querySelectorAll(".portal-property-row");
    expect(rows.length).toBe(2);
    expect([...rows].some((r) => r.textContent?.includes("Turned off"))).toBe(true);
  });

  it("price fact never invents a price", () => {
    expect(offerPriceFact({ ...createManagerListingServiceOption(), price: "", billingCadence: "monthly" })).toBe("Monthly");
    expect(offerPriceFact({ ...createManagerListingServiceOption(), price: " $9 ", billingCadence: "one_time" })).toBe("$9 · One time");
  });
});

describe("Listing sites row (Promotion tab)", () => {
  it("variant=row is a normal list row with one ⋯ and no inline toggle", () => {
    const { container } = render(
      <ZillowRentalNetworkRow
        variant="row"
        propertyTitle="Alder"
        sub={createDefaultListingSubmission()}
        onToggle={() => {}}
      />,
    );
    const row = container.querySelector(".portal-property-row")!;
    expect(row.querySelector('[data-slot="portal-row-icon-tile"]')).toBeTruthy();
    expect(row.querySelectorAll('button[aria-label^="Actions for"]')).toHaveLength(1);
    expect(container.querySelector('[role="switch"]')).toBeNull();
  });

  it("the listing editor keeps its on/off switch (default variant)", () => {
    const { container } = render(
      <ZillowRentalNetworkRow propertyTitle="Alder" sub={createDefaultListingSubmission()} onToggle={() => {}} />,
    );
    expect(container.querySelector('[role="switch"], input[type="checkbox"], button[aria-pressed]')).toBeTruthy();
  });
});

describe("LocalDestinationNav tight (House details' six tabs)", () => {
  it("trims tab padding and gap, and stays the auto layout", () => {
    const items = ["a", "b", "c"].map((id) => ({ id, label: id.toUpperCase(), count: 1 }));
    const { container } = render(
      <LocalDestinationNav items={items} activeId="a" onChange={() => {}} appearance="command" tight />,
    );
    const nav = container.querySelector("nav")!;
    expect(nav.className).toContain("gap-0");
    expect(nav.className).not.toContain("auto-cols-fr");
    expect(nav.querySelector("button")!.className).toContain("px-1.5");
    expect(nav.querySelector("button")!.className).not.toContain("px-2.5");
  });

  it("leaves the default command tabs alone", () => {
    const { container } = render(
      <LocalDestinationNav items={[{ id: "a", label: "A" }]} activeId="a" onChange={() => {}} appearance="command" />,
    );
    expect(container.querySelector("button")!.className).toContain("px-2.5");
  });
});

describe("property tabs carry no pills and no subtext", () => {
  const FILES = [
    "src/components/portal/pro-property-house-details-panel.tsx",
    "src/components/portal/property-house-details-list-panel.tsx",
    "src/components/portal/house-printables-card.tsx",
    "src/components/portal/pro-property-room-move-in-panel.tsx",
    "src/components/portal/property-services-offers-panel.tsx",
    "src/components/portal/pro-property-ai-info-panel.tsx",
    "src/components/portal/property-promotion-builtin-row.tsx",
  ];
  for (const file of FILES) {
    it(`${file} has no badge pill and no dashed explainer`, () => {
      const src = read(file);
      expect(src).not.toMatch(/portal-badge-(info|notice)/);
      expect(src).not.toContain("border-dashed");
      expect(src).not.toContain("Residents also see");
      expect(src).not.toContain("Made from the details above");
    });
  }

  it("House details' earlier-notes section no longer wears a 'Residents only' pill", () => {
    expect(read("src/components/portal/pro-property-house-details-panel.tsx")).not.toContain("Residents only");
  });

  it("rows never pass a second summary sentence next to the facts", () => {
    for (const file of FILES) expect(read(file), file).not.toMatch(/\bsummary=\{/);
  });
});

describe("Move-in no longer renders a second, empty header card", () => {
  it("does not mount PortalPropertySectionToolbar", () => {
    expect(read("src/components/portal/pro-property-room-move-in-panel.tsx")).not.toContain("<PortalPropertySectionToolbar");
  });
});
