// @vitest-environment jsdom
//
// The room pricing popup (property Pricing tab -> Edit pricing): Month-to-month surcharge, Custom start
// surcharge and Partial months follow the lease types the room is OFFERED on, and Application fee / Lease fee
// sit on the step they belong to (captain, Oct 3).
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import { PropertyRoomPricingWorkspace } from "@/components/portal/property-room-pricing-workspace";
import {
  createDefaultListingSubmission,
  emptyRoom,
  normalizeManagerListingSubmissionV1,
  type ManagerListingSubmissionV1,
  type ManagerRoomSubmission,
} from "@/lib/manager-listing-submission";

beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  window.HTMLElement.prototype.scrollIntoView ??= () => {};
});

afterEach(() => cleanup());

function listing(
  roomOver: Partial<ManagerRoomSubmission> = {},
  subOver: Partial<ManagerListingSubmissionV1> = {},
): ManagerListingSubmissionV1 {
  return normalizeManagerListingSubmissionV1({
    ...createDefaultListingSubmission(),
    allowedLeaseTerms: ["Long-term", "Month-to-Month", "Custom"],
    shortTermRentalsAllowed: true,
    rooms: [{ ...emptyRoom(0), id: "room-7", name: "Room 7", monthlyRent: 800, ...roomOver }],
    ...subOver,
  });
}

function open(sub: ManagerListingSubmissionV1) {
  return render(
    <PropertyRoomPricingWorkspace
      open
      onClose={() => {}}
      subject={{ kind: "room", roomId: "room-7" }}
      sub={sub}
      saveTarget={{ mode: "pending", saveId: "t" }}
      managerUserId="mgr"
      propertyLabel="Test house"
      onSaved={() => {}}
      showToast={vi.fn()}
    />,
  );
}

const rowLabel = (name: string) => screen.queryAllByText(name);

const tab = (id: string) => document.querySelector(`[data-attr="listing-v2-rail-${id}"]`) as HTMLElement | null;
const openTab = (id: string) => {
  expect(tab(id), `tab ${id}`).not.toBeNull();
  fireEvent.click(tab(id)!);
};
const tabLabels = () =>
  Array.from(document.querySelectorAll('[data-attr^="listing-v2-rail-"]'))
    .filter((node) => !["listing-v2-rail-finish", "listing-v2-rail-add-photos"].includes(node.getAttribute("data-attr")!))
    .map((node) => node.querySelector("span.truncate")?.textContent);

describe("room pricing popup rows follow what the room offers", () => {
  it("shows Custom start surcharge and Partial months on the Long-term tab; Month-to-month has no surcharge", () => {
    open(listing());
    expect(rowLabel("Custom start surcharge").length).toBeGreaterThan(0);
    expect(rowLabel("Partial months").length).toBeGreaterThan(0);
    expect(rowLabel("Month-to-month surcharge")).toHaveLength(0);
    openTab("Month-to-Month");
    expect(rowLabel("Month-to-month surcharge")).toHaveLength(0);
    expect(rowLabel("Custom start surcharge")).toHaveLength(0);
    expect(screen.queryByText(/^Fees$/)).toBeNull();
  });

  it("hides Custom start surcharge and Partial months when the room is not offered on Custom", () => {
    open(listing({ offeredLeaseTerms: ["Long-term", "Month-to-Month"] }));
    expect(rowLabel("Custom start surcharge")).toHaveLength(0);
    expect(rowLabel("Partial months")).toHaveLength(0);
    openTab("Month-to-Month");
    expect(rowLabel("Month-to-month surcharge")).toHaveLength(0);
  });

  it("hides the month-to-month surcharge when the room is not offered on Month-to-month", () => {
    open(listing({ offeredLeaseTerms: ["Long-term", "Custom"] }));
    expect(rowLabel("Month-to-month surcharge")).toHaveLength(0);
    expect(rowLabel("Custom start surcharge").length).toBeGreaterThan(0);
    expect(rowLabel("Partial months").length).toBeGreaterThan(0);
    openTab("Month-to-Month");
    expect(rowLabel("Month-to-month surcharge")).toHaveLength(0);
  });

  it("keeps Partial months out of a shared room's Long-term step unless Custom is offered", () => {
    open(listing({ occupancyCapacity: 2, offeredLeaseTerms: ["Long-term"] }));
    expect(rowLabel("Partial months")).toHaveLength(0);
  });
});

describe("Application fee and Lease fee per option", () => {
  it("each option's tab binds its own boxes", () => {
    const sub = listing({
      occupancyPrices: [{ count: 1, applicationFee: "50", leaseFee: "100", shortTermApplicationFee: "20", shortTermLeaseFee: "40" }],
    });
    open(sub);
    const lt = screen.getByLabelText("Private room long-term lease fee") as HTMLInputElement;
    expect(lt.value).toBe("100");
    expect((screen.getByLabelText("Private room long-term application fee") as HTMLInputElement).value).toBe("50");
    // Only the open tab's fields are on the page.
    expect(screen.queryByLabelText("Private room short term lease fee")).toBeNull();
    openTab("Short-Term Stay");
    expect((screen.getByLabelText("Private room short term lease fee") as HTMLInputElement).value).toBe("40");
    expect((screen.getByLabelText("Private room short term application fee") as HTMLInputElement).value).toBe("20");
    expect(screen.queryByLabelText("Private room long-term lease fee")).toBeNull();
  });

  it("a room with no fee of its own shows the application's and the lease's fee as its greyed default, and an override can be reset", () => {
    const sub = listing(
      {},
      {
        propertyApplicationTemplates: [
          { id: "a1", kind: "long-term", formVariant: "standard", listingSeedKey: "primary", label: "Long-term application", feeCentsOverride: 4500, linkedLeaseTemplateId: "l1", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" },
        ] as never,
        propertyApplicationTemplatesExplicit: true,
        propertyLeaseTemplates: [
          { id: "l1", kind: "long-term", label: "Long-term lease", listingSeedKey: "primary", applicationLeaseTerms: ["Long-term"], leaseConfigMode: "standard", leaseCustomKind: "terms", customLeaseTerms: "", leaseTemplateDocUrl: null, leaseTemplateDocName: "", leaseFeeCents: 20000, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" },
        ] as never,
      },
    );
    open(sub);
    const app = screen.getByLabelText("Private room long-term application fee") as HTMLInputElement;
    const lease = screen.getByLabelText("Private room long-term lease fee") as HTMLInputElement;
    expect([app.value, app.placeholder, lease.value, lease.placeholder]).toEqual(["", "45", "", "200"]);
    expect(document.querySelector("[data-attr='listing-v2-cell-reset']")).toBeNull();
    fireEvent.focus(app);
    fireEvent.change(app, { target: { value: "60" } });
    fireEvent.blur(app);
    const reset = document.querySelector("[data-attr='listing-v2-cell-reset']") as HTMLElement;
    expect(reset).not.toBeNull();
    expect(reset.getAttribute("title")).toBe("Back to the application's fee");
    fireEvent.click(reset);
    const back = screen.getByLabelText("Private room long-term application fee") as HTMLInputElement;
    expect([back.value, back.placeholder]).toEqual(["", "45"]);
  });
});

describe("the pricing popup's left rail lists the property's leasing options", () => {
  it("lists exactly the offered options, as tabs of one screen with no step numbers", () => {
    open(listing());
    expect(tabLabels()).toEqual(["Long-term", "Short-term", "Month-to-month"]);
    // Tabs, not steps: a single Save, no Continue, no Back, no counter, no custom-dates tab.
    expect(screen.getAllByRole("button", { name: "Save" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /^Continue/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    expect(
      screen.queryAllByText(/Step \d+ of \d+/).filter((node) => !node.closest('[data-attr="workspace-step-picker"]')),
    ).toHaveLength(0);
    expect(screen.queryAllByRole("button", { name: /^Custom/ })).toHaveLength(0);
  });

  it("opens on the first option and shows only that option's fields; clicking a tab swaps them", () => {
    open(listing());
    const section = (id: string) => document.querySelector(`[data-attr="property-pricing-section-${id}"]`);
    expect(section("long-term")).not.toBeNull();
    expect(section("short-term-stay")).toBeNull();
    expect(within(section("long-term") as HTMLElement).getByRole("heading", { name: "Long-term" })).toBeTruthy();
    expect(screen.queryByLabelText("Nightly rate")).toBeNull();
    openTab("Short-Term Stay");
    expect(section("long-term")).toBeNull();
    expect(section("short-term-stay")).not.toBeNull();
    expect(screen.getByLabelText("Nightly rate")).toBeTruthy();
    expect(screen.queryByLabelText("Rent")).toBeNull();
  });

  it("an option without month-to-month has no Month-to-month tab", () => {
    open(listing({}, { allowedLeaseTerms: ["Long-term", "Custom"] }));
    expect(tabLabels()).toEqual(["Long-term", "Short-term"]);
    expect(tab("Month-to-Month")).toBeNull();
  });

  it("leaves the Short-term tab out when short stays are not offered", () => {
    open(listing({}, { shortTermRentalsAllowed: false, allowedLeaseTerms: ["Long-term"] }));
    expect(tabLabels()).toEqual(["Long-term"]);
  });

  it("What a resident pays follows the selected tab", () => {
    open(listing());
    // The receipt panel: the nearest block holding the "What a resident pays" heading.
    const receipt = () => {
      const heading = screen.getAllByText(/What a resident pays/i)[0]!;
      let node: HTMLElement | null = heading as HTMLElement;
      while (node && !/\$/.test(node.textContent ?? "")) node = node.parentElement;
      return node?.textContent ?? "";
    };
    const before = receipt();
    openTab("Short-Term Stay");
    const after = receipt();
    expect(after).not.toBe(before);
    expect(after).toMatch(/night|stay/i);
    openTab("Long-term");
    expect(receipt()).toBe(before);
  });
});
