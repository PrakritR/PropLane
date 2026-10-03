// @vitest-environment jsdom
//
// Listing editor cards: the add button beside a step title is the round blue +
// (never a themed glyph), and every card's single ⋯ reads Edit, Duplicate, then
// a red Delete last — portaled so a card never clips it.
import { afterEach, describe, expect, it, vi } from "vitest";
import React, { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/lib/demo-admin-property-inventory", () => ({
  publishManagerPropertyDraftToServer: vi.fn(),
  saveManagerPropertyDraftToServer: vi.fn(),
}));
vi.mock("@/lib/demo-property-pipeline", () => ({ submitManagerPendingPropertyToServer: vi.fn() }));

import { ListingEditorV2 } from "@/components/portal/listing-wizard-v2/listing-editor";
import { createDefaultListingSubmission, type ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";

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

function openMenu(label: string) {
  fireEvent.keyDown(screen.getByRole("button", { name: label }), { key: "ArrowDown" });
}

async function menuLabels(): Promise<string[]> {
  const items = await screen.findAllByRole("menuitem");
  return items.map((item) => item.textContent?.trim() ?? "");
}

describe("listing editor: round + and the ⋯ menu", () => {
  it("Bathrooms: Add bathroom is the shared round +, and ⋯ is Edit, Duplicate, red Delete", async () => {
    const seen: ManagerListingSubmissionV1[] = [];
    const base = createDefaultListingSubmission();
    const bathrooms = [
      { ...base.bathrooms[0], id: "b1", name: "Bathroom 1" },
      { ...base.bathrooms[0], id: "b2", name: "Bathroom 2" },
    ] as ManagerListingSubmissionV1["bathrooms"];
    render(<Editor initial={{ ...base, bathrooms, listingTotalBathroomsId: "2" }} onChange={(s) => seen.push(s)} />);
    fireEvent.click(document.querySelector('[data-attr="listing-v2-rail-bathrooms"]')!);

    const add = screen.getByRole("button", { name: "Add bathroom" });
    expect(add.getAttribute("data-attr")).toBe("listing-v2-add-bath-icon");
    // The shared PortalPrimaryIconAction draws a plus, not the bath glyph.
    expect(add.querySelector("svg.lucide-plus")).not.toBeNull();
    expect(add.querySelector("svg.lucide-bath")).toBeNull();

    openMenu("Actions for Bathroom 2");
    expect(await menuLabels()).toEqual(["Edit", "Duplicate", "Delete"]);
    const del = screen.getByRole("menuitem", { name: "Delete" });
    expect(del.className).toContain("text-red-700");
    expect(del.closest("[data-radix-popper-content-wrapper]")).not.toBeNull();

    fireEvent.click(del);
    expect(seen.at(-1)!.bathrooms.map((b) => b.id)).toEqual(["b1"]);
  });

  it("Bathrooms: Edit opens that card", async () => {
    const base = createDefaultListingSubmission();
    const bathrooms = [{ ...base.bathrooms[0], id: "b1", name: "Bathroom 1" }] as ManagerListingSubmissionV1["bathrooms"];
    render(<Editor initial={{ ...base, bathrooms, listingTotalBathroomsId: "1" }} />);
    fireEvent.click(document.querySelector('[data-attr="listing-v2-rail-bathrooms"]')!);
    expect(document.querySelector('[data-attr="listing-v2-bath-editor"]')).toBeNull();
    openMenu("Actions for Bathroom 1");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
    expect(document.querySelector('[data-attr="listing-v2-bath-editor"]')).not.toBeNull();
  });

  it("Rooms: ⋯ is Edit, Duplicate, red Delete and Add room is the round +", async () => {
    render(<Editor initial={createDefaultListingSubmission()} />);
    fireEvent.click(document.querySelector('[data-attr="listing-v2-rail-rooms"]')!);
    const add = screen.getByRole("button", { name: /^Add (room|bedroom)$/ });
    expect(add.querySelector("svg.lucide-plus")).not.toBeNull();
    const trigger = document.querySelector('[data-attr="listing-v2-room-menu"]') as HTMLElement;
    expect(trigger).not.toBeNull();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(await menuLabels()).toEqual(["Edit", "Duplicate", "Delete"]);
    expect(screen.getByRole("menuitem", { name: "Delete" }).className).toContain("text-red-700");
  });

  it("Shared spaces: Add shared space is the round + and ⋯ is Edit, Duplicate, red Delete", async () => {
    const base = createDefaultListingSubmission();
    const space = {
      id: "s1", name: "Kitchen", spaceKind: "kitchen", location: "", detail: "", amenitiesText: "",
      photoDataUrls: [], videoDataUrl: null, roomAccessIds: [],
    } as unknown as NonNullable<ManagerListingSubmissionV1["sharedSpaces"]>[number];
    render(<Editor initial={{ ...base, sharedSpaces: [space] }} />);
    fireEvent.click(document.querySelector('[data-attr="listing-v2-rail-spaces"]')!);
    const add = screen.getByRole("button", { name: "Add shared space" });
    expect(add.querySelector("svg.lucide-plus")).not.toBeNull();
    expect(add.querySelector("svg.lucide-layout-grid")).toBeNull();
    openMenu("Actions for Kitchen");
    expect(await menuLabels()).toEqual(["Edit", "Duplicate", "Delete"]);
    expect(screen.getByRole("menuitem", { name: "Delete" }).className).toContain("text-red-700");
  });
});
