// @vitest-environment jsdom
//
// The Bathrooms count on Basics makes the bathroom cards, the way the
// Bedrooms count already makes the rooms — so the Bathrooms step never opens
// empty and a room never has to say "Add a bathroom first".
import { afterEach, describe, expect, it, vi } from "vitest";
import React, { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/lib/demo-admin-property-inventory", () => ({
  publishManagerPropertyDraftToServer: vi.fn(),
  saveManagerPropertyDraftToServer: vi.fn(),
}));
vi.mock("@/lib/demo-property-pipeline", () => ({ submitManagerPendingPropertyToServer: vi.fn() }));

import { ListingEditorV2 } from "@/components/portal/listing-wizard-v2/listing-editor";
import { submissionFromAddProperty } from "@/components/portal/listing-wizard-v2";
import { createDefaultListingSubmission, emptyBathroom, type ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";

afterEach(() => cleanup());

function Editor({ initial, onChange }: { initial: ManagerListingSubmissionV1; onChange?: (sub: ManagerListingSubmissionV1) => void }) {
  const [sub, setSub] = useState(initial);
  return (
    <ListingEditorV2
      title="New listing"
      submission={sub}
      onChange={(next) => {
        setSub(next);
        onChange?.(next);
      }}
      onClose={() => {}}
      onSaveExit={() => {}}
      onPublish={() => {}}
    />
  );
}

describe("bathrooms come from Basics", () => {
  it("2.5 bathrooms opens the Bathrooms step with two full baths and one half, and lowering removes untouched cards", () => {
    const seen: ManagerListingSubmissionV1[] = [];
    render(<Editor initial={{ ...createDefaultListingSubmission(), listingTotalBathroomsId: "1", bathrooms: [] }} onChange={(s) => seen.push(s)} />);
    fireEvent.click(document.querySelector('[data-attr="listing-v2-rail-basics"]')!);
    const more = () => fireEvent.click(screen.getByRole("button", { name: "More bathrooms" }));
    more();
    more();
    more();
    const sub = seen.at(-1)!;
    expect(sub.listingTotalBathroomsId).toBe("2.5");
    expect(sub.bathrooms.map((b) => b.name)).toEqual(["Bathroom 1", "Bathroom 2", "Bathroom 3"]);
    expect(sub.bathrooms.map((b) => b.shower)).toEqual([true, true, false]);
    expect(sub.bathrooms[2]!.sink).toBe(true);
    fireEvent.click(document.querySelector('[data-attr="listing-v2-rail-bathrooms"]')!);
    expect(document.querySelectorAll('[data-attr="listing-v2-bath-card"]').length).toBe(3);
    expect(screen.getAllByText("3 bathrooms").length).toBeGreaterThan(0);
    fireEvent.click(document.querySelector('[data-attr="listing-v2-rail-rooms"]')!);
    expect(document.querySelector('[data-attr="listing-v2-add-bathroom-first"]')).toBeNull();
    fireEvent.click(document.querySelector('[data-attr="listing-v2-rail-basics"]')!);
    fireEvent.click(screen.getByRole("button", { name: "Fewer bathrooms" }));
    expect(seen.at(-1)!.bathrooms).toHaveLength(2);
    expect(seen.at(-1)!.listingTotalBathroomsId).toBe("2");
  });

  it("a filled-in last bathroom stays when the count drops, and the number agrees with the cards", () => {
    const seen: ManagerListingSubmissionV1[] = [];
    const base = createDefaultListingSubmission();
    const bathrooms = [
      { ...base.bathrooms[0], id: "b1", name: "Bathroom 1", location: "", amenitiesText: "", photoDataUrls: [], videoDataUrl: null, assignedRoomIds: [], allResidents: false, toilet: true, sink: true, shower: true, bathtub: true },
      { id: "b2", name: "Hall bath", location: "2nd floor", amenitiesText: "", photoDataUrls: [], videoDataUrl: null, assignedRoomIds: [], allResidents: false, toilet: true, sink: true, shower: true, bathtub: false },
    ] as ManagerListingSubmissionV1["bathrooms"];
    render(<Editor initial={{ ...base, listingTotalBathroomsId: "2", bathrooms }} onChange={(s) => seen.push(s)} />);
    fireEvent.click(document.querySelector('[data-attr="listing-v2-rail-basics"]')!);
    fireEvent.click(screen.getByRole("button", { name: "Fewer bathrooms" }));
    // The count follows the cards, as Bedrooms follows Rooms: two full baths read 2, not 1.5.
    expect(seen.at(-1)!.listingTotalBathroomsId).toBe("2");
    expect(seen.at(-1)!.bathrooms).toHaveLength(2);
  });

  it("the Bathrooms counter on Basics is the bathroom list, not a stale stored count", () => {
    const base = createDefaultListingSubmission();
    const full = (n: number) => ({ ...emptyBathroom(n), id: `b${n}`, name: `Bathroom ${n + 1}`, bathtub: true });
    render(<Editor initial={{ ...base, listingTotalBathroomsId: "1", bathrooms: [full(0), full(1), full(2)] }} onChange={() => {}} />);
    fireEvent.click(document.querySelector('[data-attr="listing-v2-rail-basics"]')!);
    const stepper = document.querySelector('[data-attr="listing-v2-bathrooms"]')!.closest("div")!.parentElement!;
    expect(stepper.textContent).toContain("3");
    // ...and the Bathrooms step lists the same three.
    fireEvent.click(document.querySelector('[data-attr="listing-v2-rail-bathrooms"]')!);
    expect(document.querySelectorAll('[data-attr="listing-v2-bath-card"]').length).toBe(3);
  });

  it("adding a bathroom card on its step moves the Basics count; Floors follows the floors in use", () => {
    const seen: ManagerListingSubmissionV1[] = [];
    const base = createDefaultListingSubmission();
    render(
      <Editor
        initial={{ ...base, listingTotalBathroomsId: "1", listingStoriesId: "1", bathrooms: [{ ...emptyBathroom(0), id: "b0" }], rooms: [{ ...base.rooms[0]!, floor: "3rd floor" }] }}
        onChange={(s) => seen.push(s)}
      />,
    );
    fireEvent.click(document.querySelector('[data-attr="listing-v2-rail-bathrooms"]')!);
    fireEvent.click(document.querySelector('[data-attr="listing-v2-add-bath-icon"]')!);
    expect(seen.at(-1)!.bathrooms).toHaveLength(2);
    expect(seen.at(-1)!.listingTotalBathroomsId).toBe("2");
    // a room already sits on the 3rd floor, so the home has at least three
    expect(seen.at(-1)!.listingStoriesId).toBe("3");
  });

  it("a brand-new listing starts with one bathroom card, so the Rooms step never asks for one first", () => {
    const sub = submissionFromAddProperty({
      address: "142 Ash St",
      city: "Seattle",
      state: "WA",
      zip: "98105",
      neighborhood: "",
      unitLabel: "",
      propertyTypeId: "house",
      rentByRoom: true,
      bedrooms: 3,
    } as Parameters<typeof submissionFromAddProperty>[0]);
    expect(sub.rooms).toHaveLength(3);
    expect(sub.bathrooms).toHaveLength(1);
    expect(sub.bathrooms[0]!.name).toBe("Bathroom 1");
    render(<Editor initial={sub} />);
    fireEvent.click(document.querySelector('[data-attr="listing-v2-rail-rooms"]')!);
    expect(document.querySelector('[data-attr="listing-v2-add-bathroom-first"]')).toBeNull();
  });
});
