// @vitest-environment jsdom
//
// The "About this home" box on the Promotion tab (PRP-426): the manager types the
// Facebook ad title / house notes, Save writes `marketingNotes` onto the listing
// submission through the same server-confirmed persist the lease panel uses,
// and a background re-sync never clobbers an unsaved draft.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createDefaultListingSubmission, type ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";

const persist = vi.fn();
const resolve = vi.fn();
vi.mock("@/lib/manager-property-save-target", () => ({
  persistManagerListingSubmissionOnServer: (...args: unknown[]) => persist(...args),
  resolveManagerListingSubmissionForPropertyId: (...args: unknown[]) => resolve(...args),
}));

import { PromotionHouseNotesCard } from "@/components/portal/promotion-house-notes";

function subWith(notes: string): ManagerListingSubmissionV1 {
  return { ...createDefaultListingSubmission(), buildingName: "4709A 8th Ave NE", marketingNotes: notes };
}

beforeEach(() => {
  persist.mockReset();
  resolve.mockReset();
  resolve.mockReturnValue({ sub: subWith(""), saveTarget: { mode: "listing", saveId: "p1" } });
});
afterEach(() => cleanup());

describe("PromotionHouseNotesCard", () => {
  it("saves typed notes as marketingNotes on the listing submission", async () => {
    persist.mockResolvedValue(true);
    const showToast = vi.fn();
    const onUpdated = vi.fn();
    render(<PromotionHouseNotesCard propertyId="p1" managerUserId="mgr-1" showToast={showToast} onUpdated={onUpdated} />);

    const box = screen.getByLabelText("Notes about this home for the texting assistant");
    const save = screen.getByRole("button", { name: "Save notes" });
    expect(save).toBeDisabled();

    fireEvent.change(box, { target: { value: "  Facebook: Private locked room near University of Washington  " } });
    expect(save).toBeEnabled();
    fireEvent.click(save);

    await waitFor(() => expect(persist).toHaveBeenCalledTimes(1));
    const [target, managerId, next] = persist.mock.calls[0]! as [unknown, string, ManagerListingSubmissionV1];
    expect(target).toEqual({ mode: "listing", saveId: "p1" });
    expect(managerId).toBe("mgr-1");
    expect(next.marketingNotes).toBe("Facebook: Private locked room near University of Washington");
    expect(next.buildingName).toBe("4709A 8th Ave NE");
    await waitFor(() => expect(onUpdated).toHaveBeenCalled());
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining("Notes saved"));
  });

  it("keeps the manager's unsaved draft when the property re-syncs, and Discard restores the saved text", () => {
    resolve.mockReturnValue({ sub: subWith("Saved notes"), saveTarget: { mode: "listing", saveId: "p1" } });
    const { rerender } = render(
      <PromotionHouseNotesCard propertyId="p1" managerUserId="mgr-1" revision={0} showToast={() => {}} />,
    );
    const box = screen.getByLabelText("Notes about this home for the texting assistant") as HTMLTextAreaElement;
    expect(box.value).toBe("Saved notes");
    fireEvent.change(box, { target: { value: "Half-typed edit" } });

    resolve.mockReturnValue({ sub: subWith("Saved notes v2"), saveTarget: { mode: "listing", saveId: "p1" } });
    rerender(<PromotionHouseNotesCard propertyId="p1" managerUserId="mgr-1" revision={1} showToast={() => {}} />);
    expect(box.value).toBe("Half-typed edit");

    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(box.value).toBe("Saved notes v2");
    expect(screen.getByRole("button", { name: "Save notes" })).toBeDisabled();
  });

  it("reports a failed save and keeps the draft", async () => {
    persist.mockResolvedValue(false);
    const showToast = vi.fn();
    render(<PromotionHouseNotesCard propertyId="p1" managerUserId="mgr-1" showToast={showToast} />);
    const box = screen.getByLabelText("Notes about this home for the texting assistant") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "Ad title" } });
    fireEvent.click(screen.getByRole("button", { name: "Save notes" }));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.stringContaining("Could not save")));
    expect(box.value).toBe("Ad title");
  });

  it("renders nothing when the property cannot be resolved for this manager", () => {
    resolve.mockReturnValue(null);
    const { container } = render(<PromotionHouseNotesCard propertyId="p1" managerUserId="mgr-1" showToast={() => {}} />);
    expect(container.querySelector('[data-testid="promotion-house-notes"]')).toBeNull();
  });
});
