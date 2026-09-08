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
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

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

import { ListingEditorV2 } from "@/components/portal/listing-wizard-v2/listing-editor";
import { useListingPersistence } from "@/components/portal/listing-wizard-v2/use-listing-persistence";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";

/** Drives the hook exactly as the wizard does, without mounting the whole flow. */
function Harness({
  onPublished,
  onMessage,
  propertyCount = 0,
}: {
  onPublished: (id: string) => void;
  onMessage: (m: string) => void;
  propertyCount?: number;
}) {
  const sub = createDefaultListingSubmission();
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
        if (!result.ok) onMessage(result.message);
        else onPublished(result.id);
      }}
    />
  );
}

async function goToReview() {
  for (let i = 0; i < 5; i++) {
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
  }
  await screen.findByText("Ready to publish");
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
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(onPublished).toHaveBeenCalledWith("mgr-test-ave-unit-abc123"));
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("refuses at the plan limit, and does not report a publish that never happened", async () => {
    limitReached.mockReturnValue(true);
    const onPublished = vi.fn();
    const onMessage = vi.fn();
    render(<Harness onPublished={onPublished} onMessage={onMessage} propertyCount={2} />);
    await goToReview();
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(onMessage).toHaveBeenCalledWith(expect.stringContaining("plan limit")));
    expect(onPublished).not.toHaveBeenCalled();
    expect(submitPending).not.toHaveBeenCalled();
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
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(onMessage).toHaveBeenCalledWith("Upgrade your plan to add another property."));
    expect(onPublished).not.toHaveBeenCalled();
  });
});
