/**
 * A room shows one rate per lease type the LISTING offers, and no others.
 *
 * An empty "rent / night" beside a long-term room invites a manager to type a
 * number nothing will ever bill: the application flow refuses a lease type the
 * listing does not offer, so the rate has no way to reach a charge. The field
 * appears only once the type that uses it does.
 */
import { describe, expect, it } from "vitest";
import { roomRateVisibility } from "@/components/portal/listing-wizard-v2/listing-editor";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";

const sub = (over: Partial<ManagerListingSubmissionV1>) => over as ManagerListingSubmissionV1;

describe("which rates a room may show", () => {
  it("hides the nightly rate on a plain long-term listing", () => {
    expect(roomRateVisibility(sub({}))).toEqual({ nightly: false, shortStayCharges: false });
  });

  it("shows it once short-term stays are offered", () => {
    expect(roomRateVisibility(sub({ shortTermRentalsAllowed: true }))).toEqual({
      nightly: true,
      shortStayCharges: true,
    });
  });

  it("shows a nightly rate for Airbnb, but not the short-stay charges", () => {
    // Airbnb stays are booked off PropLane and raise no rent charges here, so
    // the short-stay deposit and move-in fee would have nothing to attach to.
    expect(roomRateVisibility(sub({ airbnbRentalsAllowed: true }))).toEqual({
      nightly: true,
      shortStayCharges: false,
    });
  });
});
