// @vitest-environment jsdom
/**
 * Every requirement Publish checks must be settable in the place the refusal
 * sends the manager. A brand-new manager used to be told "Add a rent before
 * publishing." and sent to Rooms, which has no rent field, while a draft had no
 * Pricing tab to set it on — so a new account could never publish.
 *
 *   lease type -> Rooms ("Leases offered")           -> the editor jumps there
 *   rent       -> the property's Pricing tab         -> "Set rent in Pricing"
 *   rent on a DRAFT must be savable from that tab    -> updateManagerPropertyDraftSubmission
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { ListingEditorV2 } from "@/components/portal/listing-wizard-v2/listing-editor";
import { createDefaultListingSubmission, type ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { LONG_TERM_LEASE_TERM } from "@/lib/rental-application/lease-terms";
import {
  listingV2PublishPricingBlocker,
  PUBLISH_BLOCKER_LEASE_TYPE,
  PUBLISH_BLOCKER_RENT,
} from "@/lib/listing-wizard-validation";
import {
  readAdminPropertyRows,
  saveManagerPropertyDraftToServer,
  updateManagerPropertyDraftSubmission,
} from "@/lib/demo-admin-property-inventory";
import { persistManagerListingSubmission } from "@/lib/manager-property-save-target";

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

function mount(submission: ManagerListingSubmissionV1, onOpenPricing?: () => void) {
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
        onOpenPricing={onOpenPricing}
        initialStep="review"
      />
    );
  }
  render(<Harness />);
  return onPublish;
}

function publish() {
  fireEvent.click(document.querySelector('[data-attr="listing-v2-rail-review"]')!);
  fireEvent.click(screen.getByRole("button", { name: "Publish" }));
}

describe("a missing rent is fixed on Pricing, not on a step with no rent field", () => {
  it("offers Set rent in Pricing, saves nothing, and publishes nothing", () => {
    const onOpenPricing = vi.fn();
    const onPublish = mount({ ...readyBase(), allowedLeaseTerms: [LONG_TERM_LEASE_TERM] }, onOpenPricing);

    publish();

    expect(onPublish).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(PUBLISH_BLOCKER_RENT);
    // Stays on Review: Rooms has nothing that would satisfy the refusal.
    expect(document.querySelector('[data-attr="listing-v2-rail-review"]')?.getAttribute("aria-current")).toBe("step");
    fireEvent.click(screen.getByRole("button", { name: "Set rent in Pricing" }));
    expect(onOpenPricing).toHaveBeenCalledTimes(1);
  });

  it("without a host that can open Pricing, keeps the old jump and offers no dead button", () => {
    const onPublish = mount({ ...readyBase(), allowedLeaseTerms: [LONG_TERM_LEASE_TERM] });

    publish();

    expect(onPublish).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Set rent in Pricing" })).toBeNull();
  });

  it("a missing lease type still goes to Rooms, where Leases offered lives", () => {
    const onOpenPricing = vi.fn();
    const onPublish = mount(readyBase(), onOpenPricing);

    publish();

    expect(onPublish).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(PUBLISH_BLOCKER_LEASE_TYPE);
    expect(screen.queryByRole("button", { name: "Set rent in Pricing" })).toBeNull();
    expect(document.querySelector('[data-attr="listing-v2-rail-rooms"]')?.getAttribute("aria-current")).toBe("step");
  });
});

describe("a draft can be priced before it publishes", () => {
  let seq = 0;
  beforeEach(() => {
    window.history.replaceState(null, "", "/portal/properties");
    window.sessionStorage.clear();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ records: [] }) }) as unknown as Response),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("writes the rent onto the same draft, keeps it a draft, and clears the rent blocker", async () => {
    const manager = `mgr-publish-reach-${(seq += 1)}`;
    const unpriced: ManagerListingSubmissionV1 = { ...readyBase(), buildingName: "Ash Flats", allowedLeaseTerms: [LONG_TERM_LEASE_TERM] };
    expect(listingV2PublishPricingBlocker(unpriced)).toBe(PUBLISH_BLOCKER_RENT);

    const id = await saveManagerPropertyDraftToServer(unpriced, manager, { stepIndex: 4, maxStepReached: 4 });
    expect(id).toBeTruthy();

    const priced: ManagerListingSubmissionV1 = {
      ...unpriced,
      rooms: unpriced.rooms.map((room) => ({ ...room, monthlyRent: 1050 })),
    };
    // The Pricing tab saves through the draft target, not a listing target.
    expect(persistManagerListingSubmission({ mode: "draft", saveId: id! }, manager, priced)).toBe(true);

    const drafts = readAdminPropertyRows(5, manager);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.adminRefId).toBe(id);
    expect(drafts[0]!.submission?.rooms[0]?.monthlyRent).toBe(1050);
    expect(drafts[0]!.draftStepIndex).toBe(4);
    expect(listingV2PublishPricingBlocker(drafts[0]!.submission!)).toBeNull();

    const mirrored = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map(([, init]) => JSON.parse((init as { body: string }).body) as { id: string; status: string })
      .filter((body) => body.id === id);
    expect(mirrored.at(-1)?.status).toBe("draft");
  });

  it("refuses a draft id it does not hold rather than inventing a record", () => {
    expect(updateManagerPropertyDraftSubmission("mgr-missing", "mgr-nobody", readyBase())).toBe(false);
  });

  it("the draft detail page offers a Pricing tab and renders it with the draft target", () => {
    const panel = readFileSync("src/components/portal/pro-house-properties-panel.tsx", "utf8");
    expect(panel).toMatch(/bucket === 5\s*\?[^\]]*\["preview", "pricing"\]/s);
    expect(panel).toMatch(/activeDetailTab === "pricing" && bucket === 5[\s\S]{0,200}saveTarget=\{\{ mode: "draft"/);
    // Pricing is the only draft tab that saves through the draft target; the
    // lease / house-details panels stay hidden so a draft is never mirrored live.
    expect(panel).toMatch(/activeDetailTab === "lease" && bucket !== 3 && bucket !== 5/);
  });
});
