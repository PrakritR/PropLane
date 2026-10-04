/** @vitest-environment jsdom */
// Round 1 of the property redesign: one title, one fee, one label set, a Services tab that loads, one room
// order, quiet Forms rows and Pricing rows. Each block below pins one fix.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { PropertyServicesOffersPanel } from "@/components/portal/property-services-offers-panel";
import { ManagerPropertyRoomMoveInPanel } from "@/components/portal/pro-property-room-move-in-panel";
import { PropertyPricingPanel } from "@/components/portal/property-pricing-panel";
import { MoveInFormChooser } from "@/components/portal/move-in-forms/move-in-form-chooser";
import { moveInFormRowFacts } from "@/components/portal/move-in-forms/move-in-form-model";
import { composePropertyTitle } from "@/lib/property-title";
import { buildMockPropertyFromDraft } from "@/lib/demo-property-pipeline";
import { applicationFeeFactForTerms, resolvedFormFees } from "@/lib/form-resolved-fee";
import { placementFeeOptionsFor, resolvePlacementStandardFees } from "@/lib/listing-placement-standard-fees";
import { roomIndicesInListingOrder } from "@/lib/listing-floor-order";
import { buildLeaseTemplateSeeds } from "@/lib/property-lease-template-sync";
import { PROPERTY_LEASE_TYPE_OPTIONS } from "@/lib/property-lease-templates";
import {
  formatPricingMoney,
  propertyPricingBundleTitle,
  propertyPricingRoomDepositFact,
  propertyPricingTermsFact,
} from "@/lib/property-pricing-summary";
import {
  LONG_TERM_LEASE_TERM,
  SHORT_TERM_LEASE_TERM,
  leaseTermDisplayLabel,
  leaseTypeDisplayLabels,
} from "@/lib/rental-application/lease-terms";
import {
  createDefaultListingSubmission,
  createManagerListingServiceOption,
  normalizeManagerListingSubmissionV1,
  type ManagerListingSubmissionV1,
  type ManagerRoomSubmission,
} from "@/lib/manager-listing-submission";
import type { MoveInFormTemplate } from "@/lib/move-in-forms/types";

vi.mock("next/navigation", () => ({
  usePathname: () => "/portal/properties/listed/p1/requests",
  useRouter: () => ({ push: () => {}, replace: () => {} }),
}));
vi.mock("@/lib/demo-property-pipeline", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo-property-pipeline")>()),
  updateExtraListingFromSubmission: vi.fn(() => true),
  updatePendingManagerProperty: vi.fn(() => true),
}));
vi.mock("@/lib/demo-admin-property-inventory", () => ({ updateRequestChangeProperty: vi.fn(() => true) }));

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ json: async () => ({}) })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");

function listing(rooms: Partial<ManagerRoomSubmission>[], extra: Partial<ManagerListingSubmissionV1> = {}) {
  const sub = createDefaultListingSubmission();
  const base = sub.rooms[0]!;
  sub.rooms = rooms.map((room, i) => ({ ...base, id: `room-${i + 1}`, name: `Room ${i + 1}`, monthlyRent: 1300, ...room }) as ManagerRoomSubmission);
  return normalizeManagerListingSubmissionV1({ ...sub, ...extra });
}

/* 1 ─ the title */
describe("the property title never repeats its room count", () => {
  it("does not append a count the name already carries", () => {
    expect(composePropertyTitle("Magnolia House — 5 rooms", "5 rooms")).toBe("Magnolia House — 5 rooms");
    expect(composePropertyTitle("Magnolia House", "5 rooms")).toBe("Magnolia House · 5 rooms");
    expect(composePropertyTitle("Magnolia House", "Unit 4")).toBe("Magnolia House · Unit 4");
    expect(composePropertyTitle("", "2 rooms")).toBe("Property · 2 rooms");
  });

  it("the Preview tab and the public listing share one title (buildMockPropertyFromDraft)", () => {
    const mock = buildMockPropertyFromDraft(
      { id: "d1", buildingName: "Magnolia House — 5 rooms", unitLabel: "5 rooms", address: "1 Main", zip: "98105", neighborhood: "U District", beds: 5, baths: 2, monthlyRent: 1300, petFriendly: false, tagline: "" } as never,
      "l1",
    );
    expect(mock.title).toBe("Magnolia House — 5 rooms");
    expect(mock.title).not.toMatch(/rooms? · \d+ rooms?/);
  });
});

/* 2 ─ application fee parity */
describe("an Applications row shows the fee the listing shows", () => {
  const sub = listing([{}, {}], { applicationFee: "50" });

  it("is the resolver's number, not 'No fee'", () => {
    const fact = applicationFeeFactForTerms(sub, [LONG_TERM_LEASE_TERM]);
    const shown = resolvedFormFees(sub, "application", [LONG_TERM_LEASE_TERM])[0]!;
    expect(shown.maxCents).toBe(5000);
    expect(fact).toBe("Application fee $50");
    // The same cents the checkout charges for that room and stay type.
    const charged = resolvePlacementStandardFees(sub, placementFeeOptionsFor(sub, { room: sub.rooms[0]!, leaseTerm: LONG_TERM_LEASE_TERM })).applicationFee;
    expect(fact).toBe(`Application fee $${charged}`);
  });

  it("is a range when rooms differ and 'No fee' only when the resolver says 0", () => {
    const ranged = listing([
      { occupancyPrices: [{ count: 1, applicationFee: "25" }] },
      { occupancyPrices: [{ count: 1, applicationFee: "45" }] },
    ]);
    expect(applicationFeeFactForTerms(ranged, [LONG_TERM_LEASE_TERM])).toBe("Application fee $25-$45");
    const free = listing([{ occupancyPrices: [{ count: 1, applicationFee: "0" }] }], { applicationFee: "0" });
    expect(applicationFeeFactForTerms(free, [LONG_TERM_LEASE_TERM])).toBe("No fee");
  });

  it("the row reads the fee from the resolver, not the account setting alone", () => {
    const src = read("src/components/portal/pro-property-application-questions-panel.tsx");
    expect(src).toContain("applicationFeeFactForTerms");
    expect(src).not.toContain('"No fee"');
  });
});

/* 3 ─ one label set */
describe("one lease-type label set", () => {
  it("maps every stored spelling to Long-term / Short-term, display only", () => {
    expect(leaseTermDisplayLabel(SHORT_TERM_LEASE_TERM)).toBe("Short-term");
    expect(leaseTermDisplayLabel("Short term")).toBe("Short-term");
    expect(leaseTermDisplayLabel("short_term")).toBe("Short-term");
    expect(leaseTermDisplayLabel("Short term lease")).toBe("Short-term");
    expect(leaseTermDisplayLabel(LONG_TERM_LEASE_TERM)).toBe("Long-term");
    expect(leaseTermDisplayLabel("12-Month")).toBe("Long-term");
    expect(leaseTermDisplayLabel("Month-to-Month")).toBe("Month-to-month");
    expect(leaseTermDisplayLabel("Custom")).toBe("Custom dates");
    // The stored keys themselves never change.
    expect(SHORT_TERM_LEASE_TERM).toBe("Short-Term Stay");
    expect(LONG_TERM_LEASE_TERM).toBe("Long-term");
  });

  it("collapses terms into lease types without repeats", () => {
    expect(leaseTypeDisplayLabels([LONG_TERM_LEASE_TERM, "Month-to-Month", "Custom", SHORT_TERM_LEASE_TERM])).toEqual(["Long-term", "Short-term"]);
    expect(leaseTypeDisplayLabels([SHORT_TERM_LEASE_TERM])).toEqual(["Short-term"]);
  });

  it("default lease templates read 'Long-term lease' / 'Short-term lease'", () => {
    const seeds = buildLeaseTemplateSeeds(listing([{}]));
    expect(seeds.map((seed) => seed.label)).toEqual(expect.arrayContaining(["Long-term lease", "Short-term lease"]));
    expect(PROPERTY_LEASE_TYPE_OPTIONS.find((option) => option.id === "short-term")).toMatchObject({ label: "Short-term", defaultLabel: "Short-term lease" });
  });

  it("no property-record source spells the short type any other way", () => {
    const files = [
      "src/lib/property-lease-templates.ts",
      "src/lib/property-lease-template-sync.ts",
      "src/lib/property-form-stay-type-routing.ts",
      "src/components/portal/property-room-pricing-workspace.tsx",
      "src/components/portal/pro-property-lease-panel.tsx",
      "src/components/portal/property-lease-form-modal.tsx",
      "src/components/portal/property-pricing-panel.tsx",
      "src/components/marketing/listing-detail-tables-client.tsx",
    ];
    for (const file of files) {
      const withoutKnownAliases = read(file).replace(/"Short term lease", "Short-term stay lease"/g, "");
      expect(withoutKnownAliases, file).not.toMatch(/(label|return|push\()[^\n]*"Short term/);
    }
  });
});

/* 4 ─ Services leaves loading */
describe("the Services tab leaves its loading state", () => {
  function servicesSub() {
    const sub = createDefaultListingSubmission();
    sub.serviceRequestOptions = [{ ...createManagerListingServiceOption(), id: "s1", name: "Cleaning", price: "$40", billingCadence: "per_request", available: true }];
    return sub;
  }

  it("shows its rows at once - no loading placeholder, no status region", () => {
    const { container } = render(
      <PropertyServicesOffersPanel sub={servicesSub()} saveTarget={{ mode: "listing", saveId: "p1" }} managerUserId="mgr-1" propertyLabel="Alder" onUpdated={() => {}} showToast={() => {}} />,
    );
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector(".animate-pulse")).toBeNull();
    expect(screen.getByText("Cleaning")).toBeTruthy();
  });

  it("an empty catalog says so instead of loading", () => {
    const { container } = render(
      <PropertyServicesOffersPanel sub={createDefaultListingSubmission()} saveTarget={{ mode: "listing", saveId: "p1" }} managerUserId="mgr-1" propertyLabel="Alder" onUpdated={() => {}} showToast={() => {}} />,
    );
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(screen.getByText("No services yet")).toBeTruthy();
  });

  it("a property route whose portfolio sync never settles stops on 'could not load', not a skeleton", () => {
    const src = read("src/components/portal/pro-house-properties-panel.tsx");
    expect(src).toContain("PORTFOLIO_SYNC_SETTLE_MS");
    expect(src).toMatch(/setPortfolioLoad\(\(state\) => \(state === "pending" \? "failed" : state\)\)/);
  });
});

/* 5 ─ room order */
describe("Move-in → Rooms lists rooms in the listing's own order", () => {
  it("keeps the stored order, whatever floors the rooms are on", () => {
    expect(roomIndicesInListingOrder([{}, {}, {}])).toEqual([0, 1, 2]);
    const sub = listing(
      [
        { name: "Room 1", floor: "3rd floor" },
        { name: "Room 2", floor: "3rd floor" },
        { name: "Room 3", floor: "2nd floor" },
        { name: "Room 4", floor: "2nd floor" },
        { name: "Room 5", floor: "Basement" },
      ],
    );
    render(
      <ManagerPropertyRoomMoveInPanel sub={sub} saveTarget={{ mode: "listing", saveId: "p1" }} managerUserId="mgr-1" canEdit onUpdated={() => {}} showToast={() => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Rooms/ }));
    const titles = [...document.querySelectorAll(".portal-property-row")].map((row) => (row.textContent ?? "").match(/Room \d/)?.[0]);
    expect(titles).toEqual(["Room 1", "Room 2", "Room 3", "Room 4", "Room 5"]);
  });
});

/* 6 ─ Forms rows */
describe("Move-in → Forms rows are a title and one fact line", () => {
  const rooms = [{ id: "r1", label: "Room 1" }];
  const base = {
    source: "built",
    questions: new Array(15).fill(null),
    audience: { kind: "every-room" },
    trigger: "application-submitted",
    moveOutDaysBefore: 14,
    linkedApplicationTemplateIds: [] as string[],
    linkedLeaseTemplateIds: [] as string[],
  } as unknown as Pick<MoveInFormTemplate, "source" | "questions" | "audience" | "trigger" | "moveOutDaysBefore" | "linkedApplicationTemplateIds" | "linkedLeaseTemplateIds">;

  it("is questions · when it sends - no source, no 'Every room', no default link", () => {
    expect(moveInFormRowFacts(base, rooms, [], []).map((fact) => fact.text)).toEqual(["15 questions", "After application is submitted"]);
  });

  it("adds who only when it is not every room, PDF only for an uploaded form, and links only when set", () => {
    const facts = moveInFormRowFacts(
      { ...base, source: "upload", audience: { kind: "whole-house" }, linkedApplicationTemplateIds: ["a1"] },
      rooms,
      [{ id: "a1", label: "Standard application" }],
      [],
    );
    expect(facts.map((fact) => fact.id)).toEqual(["questions", "audience", "sends", "source", "linked"]);
    expect(facts.find((fact) => fact.id === "source")!.text).toBe("PDF");
    expect(facts.find((fact) => fact.id === "linked")!.text).toBe("Standard application");
  });

  it("the New form popup has no empty left column and no 'Preview: No changes'", () => {
    const { baseElement } = render(<MoveInFormChooser open onClose={() => {}} copySources={[]} onPick={() => {}} />);
    expect(baseElement.querySelector("[data-popup-preview]")).toBeNull();
    expect(baseElement.textContent).not.toContain("No changes");
    expect(read("src/components/portal/move-in-forms/move-in-form-chooser.tsx")).toMatch(/contextPanel=\{null\}[\s\S]*preview=\{null\}/);
  });
});

/* 7 ─ Pricing rows */
describe("Pricing rows are a title, one fact line, and the rent", () => {
  const sub = listing(
    [
      { name: "Room 4", securityDeposit: "1300", monthlyRent: 1300 },
      { name: "Room 5", monthlyRent: 900 },
    ],
    {
      allowedLeaseTerms: [LONG_TERM_LEASE_TERM, SHORT_TERM_LEASE_TERM],
      shortTermRentalsAllowed: true,
      bundles: [{ id: "b1", label: "Two or more rooms", price: "$2,200", includedRoomIds: ["room-1", "room-2"], roomsLine: "" } as never],
    },
  );

  function renderPanel() {
    return render(
      <PropertyPricingPanel
        submission={sub}
        saveTarget={{ mode: "listing", saveId: "p1" }}
        managerUserId="mgr-1"
        propertyLabel="Magnolia House"
        onUpdated={() => {}}
        showToast={() => {}}
        workspacePricingDefaults={{ currency: "usd" } as never}
      />,
    );
  }

  it("formats money with grouping", () => {
    expect(formatPricingMoney(1300)).toBe("$1,300");
    expect(formatPricingMoney(1300.5)).toBe("$1,300.50");
  });

  it("a room row names the terms offered then the deposit - nothing about utilities, move-in or signing", () => {
    expect(propertyPricingTermsFact(sub)).toBe("Long-term · Short-term");
    expect(propertyPricingRoomDepositFact(sub.rooms[0]!, sub)).toBe("$1,300 deposit");
    renderPanel();
    const row = document.querySelector('[data-attr="property-pricing-room-row"]')!.closest(".portal-property-row") ?? document.querySelector(".portal-property-row")!;
    const text = row.textContent ?? "";
    expect(text).toContain("Long-term · Short-term");
    expect(text).toContain("$1,300 deposit");
    expect(text).not.toMatch(/est\.|move-in|at signing|Short-Term Stay/);
  });

  it("the Bundles tab is 'Room bundles' and a bundle row is titled by its rooms", () => {
    expect(propertyPricingBundleTitle(sub.bundles![0]!, sub)).toBe("Room 4 + Room 5");
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /Room bundles/ }));
    const row = document.querySelector(".portal-property-row")!;
    expect(within(row as HTMLElement).getByText("Room 4 + Room 5")).toBeTruthy();
    expect(row.textContent).not.toContain("Two or more rooms");
  });

  it("the Whole house row has no stray dash", () => {
    const notOffered = listing([{ name: "Room 1" }, { name: "Room 2" }], { entireHomeOffered: false });
    render(
      <PropertyPricingPanel submission={notOffered} saveTarget={{ mode: "listing", saveId: "p1" }} managerUserId="mgr-1" propertyLabel="X" onUpdated={() => {}} showToast={() => {}} workspacePricingDefaults={{ currency: "usd" } as never} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Whole house/ }));
    const row = document.querySelector('[data-attr="property-pricing-whole-row"]')!;
    expect(row.textContent).toContain("Not offered");
    expect(row.textContent).not.toContain("—");
  });
});
