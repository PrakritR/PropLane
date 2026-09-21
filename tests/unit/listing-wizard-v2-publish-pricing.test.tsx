// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import React, { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ListingEditorV2 } from "@/components/portal/listing-wizard-v2/listing-editor";
import { createDefaultListingSubmission, type ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { AIRBNB_LEASE_TERM, LONG_TERM_LEASE_TERM, SHORT_TERM_LEASE_TERM } from "@/lib/rental-application/lease-terms";

afterEach(() => cleanup());

function readyBase(): ManagerListingSubmissionV1 {
  const base = createDefaultListingSubmission();
  return {
    ...base,
    address: "142 Ash St",
    city: "Brooklyn",
    state: "NY",
    zip: "11201",
    listingPlaceCategoryId: "shared_home",
    rooms: [{ ...base.rooms[0]!, name: "Room 1", monthlyRent: 0 }],
  };
}

function mount(submission: ManagerListingSubmissionV1) {
  const onPublish = vi.fn();
  function Harness() {
    const [sub, setSub] = useState(submission);
    return (
      <ListingEditorV2
        title="Ash Flats"
        submission={sub}
        onChange={setSub}
        onClose={() => {}}
        onPublish={onPublish}
        initialStep="pricing"
      />
    );
  }
  render(<Harness />);
  return onPublish;
}

function publish() {
  fireEvent.click(screen.getByRole("button", { name: "Publish" }));
}

describe("V2 publish pricing readiness", () => {
  it("accepts a short-term-only nightly price entered through the V2 control", () => {
    const onPublish = mount({
      ...readyBase(),
      allowedLeaseTerms: [SHORT_TERM_LEASE_TERM],
      shortTermRentalsAllowed: true,
    });

    fireEvent.change(screen.getByLabelText("Rent per night for every room"), { target: { value: "85" } });
    publish();

    expect(onPublish).toHaveBeenCalledTimes(1);
  });

  it("accepts a short-term-only weekly V2 price with no monthly rent", () => {
    const base = readyBase();
    const onPublish = mount({
      ...base,
      allowedLeaseTerms: [SHORT_TERM_LEASE_TERM],
      shortTermRentalsAllowed: true,
      rooms: [{ ...base.rooms[0]!, weeklyRentPrice: 425 }],
    });

    publish();

    expect(onPublish).toHaveBeenCalledTimes(1);
  });

  it("accepts an Airbnb-only offered stay with a nightly V2 price", () => {
    const base = readyBase();
    const onPublish = mount({
      ...base,
      allowedLeaseTerms: [AIRBNB_LEASE_TERM],
      airbnbRentalsAllowed: true,
      rooms: [{ ...base.rooms[0]!, shortTermRent: "90" }],
    });

    publish();

    expect(onPublish).toHaveBeenCalledTimes(1);
  });

  it("accepts a whole-home Airbnb offer with its supported positive rent", () => {
    const onPublish = mount({
      ...readyBase(),
      listingPlaceCategoryId: "entire_home",
      allowedLeaseTerms: [AIRBNB_LEASE_TERM],
      airbnbRentalsAllowed: true,
      entireHomeMonthlyRent: 3200,
    });

    publish();

    expect(onPublish).toHaveBeenCalledTimes(1);
  });

  it("accepts monthly pricing on an enabled term-specific lease tab", () => {
    const base = readyBase();
    const onPublish = mount({
      ...base,
      allowedLeaseTerms: ["Month-to-Month"],
      rooms: [{ ...base.rooms[0]!, termPricing: { "Month-to-Month": { monthlyRent: 1800 } } }],
    });

    publish();

    expect(onPublish).toHaveBeenCalledTimes(1);
  });

  it("rejects a price that exists only on a disabled lease term", () => {
    const base = readyBase();
    const onPublish = mount({
      ...base,
      allowedLeaseTerms: [LONG_TERM_LEASE_TERM],
      rooms: [{ ...base.rooms[0]!, termPricing: { "Month-to-Month": { monthlyRent: 1800 } } }],
    });

    publish();

    expect(onPublish).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Add a rent before publishing.");
  });

  it("rejects stale nightly and weekly rates when short-term is disabled", () => {
    const base = readyBase();
    const onPublish = mount({
      ...base,
      allowedLeaseTerms: [LONG_TERM_LEASE_TERM],
      rooms: [{ ...base.rooms[0]!, shortTermRent: "85", weeklyRentPrice: 425 }],
    });

    publish();

    expect(onPublish).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Add a rent before publishing.");
  });

  it("rejects nightly pricing when no short-term lease is offered", () => {
    const base = readyBase();
    const onPublish = mount({
      ...base,
      allowedLeaseTerms: [LONG_TERM_LEASE_TERM],
      rooms: [{ ...base.rooms[0]!, shortTermRent: "85" }],
    });

    publish();

    expect(onPublish).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Add a rent before publishing.");
  });

  it("does not treat negative V2 nightly or weekly rates as rent", () => {
    const base = readyBase();
    const onPublish = mount({
      ...base,
      allowedLeaseTerms: [SHORT_TERM_LEASE_TERM],
      shortTermRentalsAllowed: true,
      rooms: [{ ...base.rooms[0]!, shortTermRent: "-85", weeklyRentPrice: -425 }],
    });

    publish();

    expect(onPublish).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Add a rent before publishing.");
  });

  it("rejects an otherwise complete listing with no offered lease type", () => {
    const onPublish = mount(readyBase());

    publish();

    expect(onPublish).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Choose a lease type before publishing.");
  });

  it("keeps a truly unpriced offered listing blocked", () => {
    const onPublish = mount({
      ...readyBase(),
      allowedLeaseTerms: [LONG_TERM_LEASE_TERM],
    });

    publish();

    expect(onPublish).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Add a rent before publishing.");
  });
});
