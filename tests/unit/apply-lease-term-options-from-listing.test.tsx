/**
 * @vitest-environment jsdom
 *
 * Step 1 of the application ("Your lease"), driven through the real wizard step.
 *
 * The applicant picks Long-term or Short-term (a toggle that shows only when the property offers both), and the
 * fields that type needs appear right under it: Long-term asks Move-in and a Length (the property's fixed
 * lengths, Custom dates, and Month-to-month only when the property offers it); Short-term asks check-in,
 * check-out, the times and the house rules. The STORED term is translated at this edge, so leases, pricing and
 * the one fee resolver read the same values they always did.
 */
import { afterEach, describe, expect, it } from "vitest";
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { RentalWizardStepBody, type WizardStepsProps } from "@/components/marketing/rental-wizard-steps";
import { createInitialRentalWizardState } from "@/lib/rental-application/state";
import { cachePublicExtraListings } from "@/lib/demo-property-pipeline";
import {
  createDefaultListingSubmission,
  normalizeManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import type { MockProperty } from "@/data/types";

const PID = "prop-lease-terms";
/** Exactly what the manager's screenshot showed a listing storing. */
const LEGACY_STORED = ["3-Month", "6-Month", "9-Month", "12-Month", "Long-term"];

let rentByRoom = false;

function seedListing(allowedLeaseTerms: string[], shortTerm = false, lengths: number[] = []): void {
  const sub = createDefaultListingSubmission();
  if (rentByRoom) {
    sub.listingPlaceCategoryId = "shared_home";
    sub.rentalModelStamp = "shared_home";
    sub.rooms = [{ ...sub.rooms[0]!, id: "room-a", name: "Room A" }];
  }
  sub.allowedLeaseTerms = allowedLeaseTerms;
  sub.shortTermRentalsAllowed = shortTerm;
  sub.longTermLengthsOffered = lengths;
  const property: MockProperty = {
    id: PID,
    title: "Legacy Terms House",
    tagline: "Test",
    address: "1 Test St, Seattle, WA",
    zip: "98101",
    neighborhood: "Test",
    beds: 3,
    baths: 1,
    rentLabel: "$1,200/mo",
    available: "Now",
    petFriendly: false,
    buildingId: "b1",
    buildingName: "Legacy Terms House",
    unitLabel: "3 rooms",
    adminPublishLive: true,
    managerUserId: "mgr-lease-terms",
    listingSubmission: normalizeManagerListingSubmissionV1(sub),
  };
  cachePublicExtraListings([property], { silent: true });
}

/** Step 1 carries the lease type and its dates; render it exactly as the apply page does. */
function renderLeaseTermStep(
  allowedLeaseTerms: string[],
  leaseTerm = "",
  shortTerm = false,
  patch: (next: Record<string, unknown>) => void = () => {},
  extra: Record<string, unknown> = {},
  lengths: number[] = [],
) {
  seedListing(allowedLeaseTerms, shortTerm, lengths);
  const noop = () => {};
  return render(
    <RentalWizardStepBody
      step={1}
      form={{ ...createInitialRentalWizardState(), propertyId: PID, leaseTerm, ...extra }}
      errors={{}}
      mode="public"
      propertyOptions={[]}
      patch={patch as WizardStepsProps["patch"]}
      applicationFeeGate={undefined as unknown as WizardStepsProps["applicationFeeGate"]}
      occupancySyncEpoch={0}
      showAvailabilityWarnings={false}
      setPhone={noop}
      setLandlordPhone={noop}
      setPrevLandlordPhone={noop}
      setSupervisorPhone={noop}
      setRef1Phone={noop}
      setRef2Phone={noop}
      setSsn={noop}
      goToStep={noop}
      editFromReview={noop}
    />,
  );
}

const CHECK_GLYPH = /^[✓✔]\s*/;

/** The Long-term / Short-term toggle a person sees, as the labels of its two buttons ([] when there is none). */
function toggleLabels(): string[] {
  return screen.queryAllByRole("radio").map((node) => (node.textContent ?? "").trim());
}

function selectedToggle(): string | null {
  const on = screen.queryAllByRole("radio").find((node) => node.getAttribute("aria-checked") === "true");
  return on ? (on.textContent ?? "").trim() : null;
}

/** The Length dropdown renders a menu rather than a native <select>: open it the way a person would. */
function lengthTrigger(): HTMLElement | null {
  const label = screen.queryByText(/^Length/);
  return (label?.closest("div")?.querySelector("button") as HTMLElement | null) ?? null;
}

function openLengthMenu(): string[] {
  const trigger = lengthTrigger();
  if (!trigger) return [];
  fireEvent.click(trigger);
  return Array.from(document.querySelectorAll('[role="option"]'))
    .map((el) => (el.textContent ?? "").replace(CHECK_GLYPH, "").trim())
    .filter((t) => t && !/^pick a length/i.test(t));
}

/** Custom dates / Month-to-month are checkboxes under Long-term, present only when the property allows them. */
function longTermChecks(): HTMLInputElement[] {
  const group = document.querySelector('[data-wizard-field="longTermOptions"]');
  return group ? (Array.from(group.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[]) : [];
}

function longTermCheckLabels(): string[] {
  return longTermChecks().map((box) => (box.closest("label")?.textContent ?? "").trim());
}

function tickLongTerm(label: string) {
  const box = longTermChecks().find((node) => (node.closest("label")?.textContent ?? "").trim() === label)!;
  fireEvent.click(box);
}

function pickLength(label: string) {
  const option = screen
    .getAllByRole("option")
    .find((node) => (node.textContent ?? "").replace(CHECK_GLYPH, "").trim() === label)!;
  fireEvent.pointerDown(option, { pointerId: 1, clientX: 0, clientY: 0 });
  fireEvent.pointerUp(option, { pointerId: 1, clientX: 0, clientY: 0 });
}

afterEach(() => cleanup());

describe("Your lease: the toggle lists only the sides the property offers", () => {
  it("shows no toggle for a long-term-only property, whatever it stores", () => {
    renderLeaseTermStep(LEGACY_STORED);
    expect(toggleLabels()).toEqual([]);
    cleanup();
    renderLeaseTermStep(["12-Month", "Month-to-Month", "Custom"]);
    expect(toggleLabels()).toEqual([]);
  });

  it("offers Short-term only when the listing permits a short stay", () => {
    renderLeaseTermStep(["12-Month"], "", true);
    expect(toggleLabels()).toEqual(["Long-term", "Short-term"]);
    cleanup();
    renderLeaseTermStep(["12-Month"], "", false);
    expect(toggleLabels()).toEqual([]);
  });

  it("shows no toggle for a property that only offers short stays", () => {
    renderLeaseTermStep(["Short-Term Stay"], "Short-Term Stay", true);
    expect(toggleLabels()).toEqual([]);
  });

  it("keeps a resumed draft's own stored answer selected", () => {
    renderLeaseTermStep(LEGACY_STORED, "12-Month", true);
    expect(selectedToggle()).toBe("Long-term");
    cleanup();
    renderLeaseTermStep(["Long-term", "Short-Term Stay"], "Short-Term Stay", true, () => {}, { rentalType: "short_term" });
    expect(selectedToggle()).toBe("Short-term");
    cleanup();
    renderLeaseTermStep(["Long-term", "Short-Term Stay"], "", true);
    expect(selectedToggle()).toBeNull();
  });
});

describe("Your lease: the Length list under Long-term", () => {
  it("lists the property's fixed lengths; Custom dates and Month-to-month are checkboxes shown only when it allows them", () => {
    renderLeaseTermStep(["Long-term"], "Long-term", false, () => {}, {}, [6, 12]);
    expect(openLengthMenu()).toEqual(["6 months", "12 months"]);
    expect(longTermCheckLabels()).toEqual([]);
    cleanup();
    renderLeaseTermStep(["Long-term", "Month-to-Month"], "Long-term", false, () => {}, {}, [6, 12]);
    expect(openLengthMenu()).toEqual(["6 months", "12 months"]);
    expect(longTermCheckLabels()).toEqual(["Month-to-month"]);
    cleanup();
    renderLeaseTermStep(["Long-term", "Custom", "Month-to-Month"], "Long-term", false, () => {}, {}, [6, 12]);
    expect(longTermCheckLabels()).toEqual(["Custom dates", "Month-to-month"]);
  });

  it("never offers a retired length a listing still stores", () => {
    renderLeaseTermStep(LEGACY_STORED, "Long-term");
    // No fixed lengths and no month-to-month: the dates decide, so there is no Length to pick.
    expect(lengthTrigger()).toBeNull();
    expect(document.getElementById("leaseEnd")).not.toBeNull();
  });

  it("offers Month-to-month on a property that does not offer long-term lengths; Long-term then asks its move-out date", () => {
    renderLeaseTermStep(["Long-term", "Month-to-Month"], "Long-term");
    expect(lengthTrigger()).toBeNull();
    expect(longTermCheckLabels()).toEqual(["Month-to-month"]);
    expect(document.getElementById("leaseEnd")).not.toBeNull();
  });

  it("has no Length at all when Month-to-month is the only thing offered", () => {
    renderLeaseTermStep(["Month-to-Month"], "Month-to-Month");
    expect(lengthTrigger()).toBeNull();
    expect(document.getElementById("leaseStart")).not.toBeNull();
    expect(document.getElementById("leaseEnd")).toBeNull();
  });
});

describe("Your lease: the date fields follow the type", () => {
  it("Custom dates asks a move-out date; Month-to-month asks only the move-in date", () => {
    renderLeaseTermStep(["Long-term", "Custom"], "Custom");
    expect(document.getElementById("leaseStart")).not.toBeNull();
    expect(document.getElementById("leaseEnd")).not.toBeNull();
    expect(screen.getByText(/^Move-out date/)).toBeTruthy();
    cleanup();
    renderLeaseTermStep(["Long-term", "Month-to-Month"], "Month-to-Month");
    expect(document.getElementById("leaseStart")).not.toBeNull();
    expect(document.getElementById("leaseEnd")).toBeNull();
  });

  it("a fixed length shows the move-in date and the length, with no move-out field", () => {
    renderLeaseTermStep(
      ["Long-term"],
      "Long-term",
      false,
      () => {},
      { leaseStart: "2099-01-01", leaseEnd: "2099-06-30" },
      [6, 12],
    );
    expect(document.getElementById("leaseStart")).not.toBeNull();
    expect(lengthTrigger()?.textContent).toContain("6 months");
    expect(document.getElementById("leaseEnd")).toBeNull();
  });

  it("Short-term asks check-in, check-out, the times and the house rules", () => {
    renderLeaseTermStep(["Long-term", "Short-Term Stay"], "Short-Term Stay", true, () => {}, { rentalType: "short_term" });
    expect(screen.getByText(/^Check-in date/)).toBeTruthy();
    expect(screen.getByText(/^Check-out date/)).toBeTruthy();
    expect(document.getElementById("shortTermCheckInTime")).not.toBeNull();
    expect(document.getElementById("shortTermCheckOutTime")).not.toBeNull();
    expect(document.getElementById("shortTermRulesAck")).not.toBeNull();
    // None of the long-term fields.
    expect(screen.queryByText(/^Move-in date/)).toBeNull();
    expect(lengthTrigger()).toBeNull();
  });

  it("Long-term never asks for the short-stay times or the house rules", () => {
    renderLeaseTermStep(["Long-term", "Short-Term Stay"], "Long-term", true);
    expect(document.getElementById("shortTermCheckInTime")).toBeNull();
    expect(document.getElementById("shortTermRulesAck")).toBeNull();
  });
});

describe("Your lease: a pick writes the existing stored term", () => {
  const all = ["Long-term", "Month-to-Month", "Custom", "Short-Term Stay"];

  it("switching sides sets the stored term and stay type, and clears only the dates", () => {
    const patched: Record<string, unknown>[] = [];
    renderLeaseTermStep(all, "Long-term", true, (next) => patched.push(next), {
      leaseStart: "2099-01-01",
      leaseEnd: "2099-06-30",
    });
    fireEvent.click(screen.getByRole("radio", { name: "Short-term" }));
    expect(patched.at(-1)).toMatchObject({
      leaseTerm: "Short-Term Stay",
      rentalType: "short_term",
      leaseStart: "",
      leaseEnd: "",
    });
    // The property and rooms are not touched.
    expect(patched.at(-1)).not.toHaveProperty("propertyId");
    expect(patched.at(-1)).not.toHaveProperty("roomChoice1");
    cleanup();
    patched.length = 0;
    renderLeaseTermStep(all, "Short-Term Stay", true, (next) => patched.push(next), {
      rentalType: "short_term",
      leaseStart: "2099-01-01",
      leaseEnd: "2099-01-05",
    });
    fireEvent.click(screen.getByRole("radio", { name: "Long-term" }));
    expect(patched.at(-1)).toMatchObject({ leaseTerm: "Long-term", rentalType: "standard", leaseStart: "", leaseEnd: "" });
  });

  it("each Length / checkbox writes Long-term, Custom or Month-to-Month, with the end date that follows", () => {
    const patched: Record<string, unknown>[] = [];
    const picks: [string, "length" | "check", Record<string, unknown>][] = [
      ["6 months", "length", { leaseTerm: "Long-term", rentalType: "standard", leaseEnd: "2099-06-30" }],
      ["Custom dates", "check", { leaseTerm: "Custom", rentalType: "standard" }],
      ["Month-to-month", "check", { leaseTerm: "Month-to-Month", rentalType: "standard", leaseEnd: "" }],
    ];
    for (const [label, how, expected] of picks) {
      renderLeaseTermStep(all, "Long-term", true, (next) => patched.push(next), { leaseStart: "2099-01-01" }, [6, 12]);
      fireEvent.click(screen.getByRole("radio", { name: "Long-term" }));
      patched.length = 0;
      if (how === "length") {
        openLengthMenu();
        pickLength(label);
      } else {
        tickLongTerm(label);
      }
      expect(patched.at(-1)).toMatchObject(expected);
      cleanup();
    }
  });

  it("a Long-term property with no Custom dates never offers it: the move-out date is asked directly and stores Long-term", () => {
    renderLeaseTermStep(["Long-term"], "Long-term", false, () => {}, { leaseStart: "2099-01-01" });
    expect(longTermCheckLabels()).toEqual([]);
    expect(document.getElementById("leaseEnd")).not.toBeNull();
    cleanup();
    renderLeaseTermStep(["Long-term", "Month-to-Month"], "Long-term", false, () => {}, { leaseStart: "2099-01-01" });
    expect(longTermCheckLabels()).not.toContain("Custom dates");
  });
});

describe("apply wizard — step labels", () => {
  it("room choices read '1st choice / 2nd choice / 3rd choice' in sentence case, and required fields carry no asterisk", () => {
    rentByRoom = true;
    renderLeaseTermStep(["Long-term", "Short-Term Stay"], "Long-term", true);
    rentByRoom = false;
    for (const label of ["1st choice", "2nd choice", "3rd choice"]) {
      const node = screen.getByText(label);
      expect(node.className).not.toContain("uppercase");
    }
    expect(document.body.textContent).not.toMatch(/\*/);
    // The lease term label says "(required)" to assistive tech only.
    expect(screen.getByText(/^Lease term/i).textContent).not.toContain("*");
  });
});
