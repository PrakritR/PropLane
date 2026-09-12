// @vitest-environment jsdom
//
// The listing editor's shell on an EDIT: the rail reads as a table of contents
// (each section says what it currently holds), a listing with gaps carries a
// "things to finish" card, the status block says the home is live, and saving
// is the primary action on every section rather than only at the end.
import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/lib/demo-admin-property-inventory", () => ({
  publishManagerPropertyDraftToServer: vi.fn(),
  saveManagerPropertyDraftToServer: vi.fn(),
}));
vi.mock("@/lib/demo-property-pipeline", () => ({ submitManagerPendingPropertyToServer: vi.fn() }));

import { ListingEditorV2 } from "@/components/portal/listing-wizard-v2/listing-editor";
import { createDefaultListingSubmission, type ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";

function subWith(over: Partial<ManagerListingSubmissionV1>): ManagerListingSubmissionV1 {
  return { ...createDefaultListingSubmission(), ...over };
}

function mount(sub: ManagerListingSubmissionV1, isEdit: boolean, onSaveExit = vi.fn(), onPublish = vi.fn()) {
  render(
    <ListingEditorV2
      title="Ash Flats 6"
      submission={sub}
      onChange={() => {}}
      onClose={() => {}}
      onSaveExit={onSaveExit}
      onPublish={onPublish}
      isEdit={isEdit}
    />,
  );
  return { onSaveExit, onPublish };
}

afterEach(() => cleanup());

describe("the rail on an edit", () => {
  it("says what each section holds, not just its name", () => {
    const sub = subWith({ address: "142 Ash St, Seattle, WA 98166" });
    sub.rooms = sub.rooms.map((r, i) => ({ ...r, monthlyRent: 1160 + i * 50 }));
    mount(sub, true);
    const rail = screen.getByRole("navigation", { name: "Listing sections" });
    expect(rail.textContent).toContain("142 Ash St · By the room");
    expect(rail.textContent).toContain("From $1,160 a month");
    expect(rail.textContent).toMatch(/\d room/);
  });

  it("carries a 'things to finish' card that opens the review, and drops it when nothing is open", () => {
    mount(subWith({ address: "" }), true);
    const finish = document.querySelector('[data-attr="listing-v2-rail-finish"]');
    expect(finish).not.toBeNull();
    expect(finish!.textContent).toMatch(/\d things? to finish/);
    fireEvent.click(finish!);
    expect(screen.getByText(/things? need attention|thing needs attention|Ready to publish/)).toBeTruthy();
  });

  it("states the listing is live, and a new listing is a draft", () => {
    mount(subWith({}), true);
    expect(screen.getByText("Renters can see this home and apply.")).toBeTruthy();
    cleanup();
    mount(subWith({}), false);
    expect(screen.getByText("Not visible to renters until you publish.")).toBeTruthy();
  });

  it("offers to add photos when the listing has none", () => {
    mount(subWith({ housePhotoDataUrls: [] }), true);
    expect(document.querySelector('[data-attr="listing-v2-rail-add-photos"]')).not.toBeNull();
  });
});

describe("the footer on an edit", () => {
  it("saves from the first section — the manager did not come to walk six screens", () => {
    const { onSaveExit } = mount(subWith({}), true);
    const save = screen.getByRole("button", { name: "Save changes" });
    fireEvent.click(save);
    expect(onSaveExit).toHaveBeenCalledWith(0);
    // The next section is still on offer, as a secondary action.
    expect(screen.getByRole("button", { name: /^Next: Rooms$/ })).toBeTruthy();
  });

  it("publishes from the review, as before", () => {
    const { onPublish } = mount(subWith({}), true);
    fireEvent.click(document.querySelector('[data-attr="listing-v2-rail-review"]')!);
    fireEvent.click(screen.getByRole("button", { name: "Publish changes" }));
    expect(onPublish).toHaveBeenCalled();
  });

  it("keeps the linear flow for a NEW listing", () => {
    mount(subWith({}), false);
    expect(screen.getByRole("button", { name: /^Continue to Rooms$/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save & exit" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
  });
});
