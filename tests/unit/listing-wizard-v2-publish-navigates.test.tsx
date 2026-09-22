// @vitest-environment jsdom
//
// Publishing from the redesigned wizard must hand back the PUBLISHED LISTING ID,
// because the caller navigates to the listing the manager just made. Handing back
// the submission instead left them on whichever stage they started from — after
// publishing a draft that is the Drafts tab, which no longer holds the row, so
// finishing the wizard was rewarded with an empty list (PRP-429).
//
// It also pins the plan gate: a manager at their limit must be told, and must NOT
// be reported as having published.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

const publishDraft = vi.fn();
const submitPending = vi.fn();
const saveDraft = vi.fn();
const limitReached = vi.fn();

vi.mock("@/lib/demo-admin-property-inventory", () => ({
  publishManagerPropertyDraftToServer: (...a: unknown[]) => publishDraft(...a),
  saveManagerPropertyDraftToServer: (...a: unknown[]) => saveDraft(...a),
}));
vi.mock("@/lib/demo-property-pipeline", () => ({
  submitManagerPendingPropertyToServer: (...a: unknown[]) => submitPending(...a),
}));
vi.mock("@/lib/manager-access", () => ({
  managerTierPropertyLimitReached: (...a: unknown[]) => limitReached(...a),
  managerPropertyLimitMessage: () => "You've reached your plan limit of 2 properties.",
}));

import { LISTING_V2_STEPS, ListingEditorV2 } from "@/components/portal/listing-wizard-v2/listing-editor";
import {
  useListingPersistence,
  type ListingPersistenceResult,
} from "@/components/portal/listing-wizard-v2/use-listing-persistence";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import { LONG_TERM_LEASE_TERM } from "@/lib/rental-application/lease-terms";
import { WORKSPACE_PROPERTY_LIMIT_ERROR_CODE } from "@/lib/workspaces/types";

/** Drives the hook exactly as the wizard does, without mounting the whole flow. */
function Harness({
  onPublished,
  onMessage,
  onFailure,
  propertyCount = 0,
}: {
  onPublished: (id: string) => void;
  onMessage: (m: string) => void;
  /** The whole refusal, so a test can read the `kind` the save-failed dialog branches on. */
  onFailure?: (result: Extract<ListingPersistenceResult, { ok: false }>) => void;
  propertyCount?: number;
}) {
  const base = createDefaultListingSubmission();
  const sub = {
    ...base,
    address: "142 Test Ave",
    city: "Seattle",
    state: "WA",
    zip: "98101",
    listingPlaceCategoryId: "shared_home",
    allowedLeaseTerms: [LONG_TERM_LEASE_TERM],
    rooms: base.rooms.map((room) => ({ ...room, monthlyRent: 1_500 })),
  };
  const { publish, busy } = useListingPersistence({ userId: "mgr-1", skuTier: "starter", propertyCount });
  return (
    <ListingEditorV2
      title="Test"
      submission={sub}
      busy={busy}
      onChange={() => {}}
      onClose={() => {}}
      onSaveExit={() => {}}
      onPublish={async () => {
        const result = await publish(sub);
        if (!result.ok) {
          onMessage(result.message);
          onFailure?.(result);
        } else onPublished(result.id);
      }}
    />
  );
}

/**
 * Walk to the last step.
 *
 * Continue follows the SHORT path (listingV2PathStepIds) — a whole-place listing
 * is Basics → Pricing → Review, a by-the-room one adds Rooms — so this presses
 * Continue until it is gone rather than assuming every step is on the way. The
 * bound is the full step list, so a footer that never reaches Review still fails
 * loudly instead of looping. Driven by the stable `data-attr` rather than the
 * button's words — this test is about publishing, not about copy.
 */
async function goToReview() {
  for (let i = 0; i < LISTING_V2_STEPS.length; i++) {
    const next = document.querySelector('[data-attr="listing-v2-next"]');
    if (!next) break;
    fireEvent.click(next);
  }
  await waitFor(() => expect(document.querySelector('[data-attr="listing-v2-publish"]')).not.toBeNull());
}

/** The publish button, found by its stable attribute. */
function publishButton(): Element {
  const el = document.querySelector('[data-attr="listing-v2-publish"]');
  if (!el) throw new Error("publish button not rendered");
  return el;
}

beforeEach(() => {
  publishDraft.mockReset();
  submitPending.mockReset();
  saveDraft.mockReset();
  limitReached.mockReset().mockReturnValue(false);
});
afterEach(() => cleanup());

describe("publishing from the redesigned wizard", () => {
  it("hands the caller the new listing id, so it can open the listing", async () => {
    submitPending.mockResolvedValue("mgr-test-ave-unit-abc123");
    const onPublished = vi.fn();
    const onMessage = vi.fn();
    render(<Harness onPublished={onPublished} onMessage={onMessage} />);
    await goToReview();
    fireEvent.click(publishButton());
    await waitFor(() => expect(onPublished).toHaveBeenCalledWith("mgr-test-ave-unit-abc123"));
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("refuses at the plan limit, and does not report a publish that never happened", async () => {
    limitReached.mockReturnValue(true);
    const onPublished = vi.fn();
    const onMessage = vi.fn();
    render(<Harness onPublished={onPublished} onMessage={onMessage} propertyCount={2} />);
    await goToReview();
    fireEvent.click(publishButton());
    await waitFor(() => expect(onMessage).toHaveBeenCalledWith(expect.stringContaining("plan limit")));
    expect(onPublished).not.toHaveBeenCalled();
    expect(submitPending).not.toHaveBeenCalled();
  });

  it("marks the workspace record cap as a plan_limit, so Publish reaches the upgrade prompt too", async () => {
    // The very same 10-record cap the draft save hits: a brand-new listing
    // published without ever being saved inserts its first row here, and a
    // toast with no way out is the dead end PLAN-0921-1648 set out to remove.
    submitPending.mockImplementation(
      async (
        _sub: unknown,
        _user: unknown,
        opts: { onError: (m: string, code?: string, status?: number, limitInfo?: unknown) => void },
      ) => {
        opts.onError("This workspace has reached 10 property records, including drafts.", WORKSPACE_PROPERTY_LIMIT_ERROR_CODE, 403, {
          limit: 10,
          current: 10,
          draftCount: 4,
        });
        return null;
      },
    );
    const onFailure = vi.fn();
    render(<Harness onPublished={vi.fn()} onMessage={vi.fn()} onFailure={onFailure} />);
    await goToReview();
    fireEvent.click(publishButton());
    await waitFor(() => expect(onFailure).toHaveBeenCalled());
    const result = onFailure.mock.calls[0]![0] as Extract<ListingPersistenceResult, { ok: false }>;
    expect(result.kind).toBe("plan_limit");
    expect(result.limitInfo).toEqual({ limit: 10, current: 10, draftCount: 4 });
  });

  it("leaves an ordinary server refusal without a plan_limit kind", async () => {
    submitPending.mockImplementation(
      async (_sub: unknown, _user: unknown, opts: { onError: (m: string) => void }) => {
        opts.onError("Select an owned workspace before adding a property.");
        return null;
      },
    );
    const onFailure = vi.fn();
    render(<Harness onPublished={vi.fn()} onMessage={vi.fn()} onFailure={onFailure} />);
    await goToReview();
    fireEvent.click(publishButton());
    await waitFor(() => expect(onFailure).toHaveBeenCalled());
    const result = onFailure.mock.calls[0]![0] as Extract<ListingPersistenceResult, { ok: false }>;
    expect(result.kind).toBeUndefined();
    expect(result.limitInfo).toBeUndefined();
  });

  it("surfaces the server's own refusal rather than a generic failure", async () => {
    // A flattened "Could not submit listing" reads as a broken button; the
    // server's wording tells the manager what to do about it.
    submitPending.mockImplementation(async (_sub: unknown, _user: unknown, opts: { onError: (m: string) => void }) => {
      opts.onError("Upgrade your plan to add another property.");
      return null;
    });
    const onPublished = vi.fn();
    const onMessage = vi.fn();
    render(<Harness onPublished={onPublished} onMessage={onMessage} />);
    await goToReview();
    fireEvent.click(publishButton());
    await waitFor(() => expect(onMessage).toHaveBeenCalledWith("Upgrade your plan to add another property."));
    expect(onPublished).not.toHaveBeenCalled();
  });
});
