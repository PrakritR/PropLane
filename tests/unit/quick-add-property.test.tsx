// @vitest-environment jsdom
/**
 * Quick Add: four questions, one to a screen, and a property exists.
 *
 * These drive the flow the way a manager does — by hitting cards and typing a
 * rent — and check what it hands to the server, because the whole promise of
 * the flow is that the property it creates is the same row the long editor
 * would have made.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// The address field talks to a geocoder; the test types an address by hand.
vi.mock("@/components/portal/listing-address-autocomplete", () => ({
  ListingAddressAutocomplete: ({
    value,
    onChange,
    placeholder,
  }: {
    value: string;
    onChange: (v: string) => void;
    placeholder?: string;
  }) => (
    <input aria-label="Street address" placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

import { QuickAddProperty } from "@/components/portal/listing-wizard-v2/quick-add-property";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";

afterEach(() => cleanup());

const byAttr = (attr: string) => {
  const el = document.querySelector(`[data-attr="${attr}"]`);
  if (!el) throw new Error(`no element with data-attr="${attr}"`);
  return el;
};

function type(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function Harness({
  save,
  onOpenEditor = vi.fn(),
  onPublishNow = vi.fn(),
  onAddAnother = vi.fn(),
}: {
  save: (sub: ManagerListingSubmissionV1) => Promise<{ ok: true } | { ok: false; message: string }>;
  onOpenEditor?: (sub: ManagerListingSubmissionV1) => void;
  onPublishNow?: (sub: ManagerListingSubmissionV1) => void;
  onAddAnother?: () => void;
}) {
  return (
    <QuickAddProperty
      onCancel={() => {}}
      save={save}
      onOpenEditor={onOpenEditor}
      onPublishNow={onPublishNow}
      onAddAnother={onAddAnother}
    />
  );
}

/** Kind → address → by the room → 3 rooms → rents. */
async function walkByTheRoom() {
  fireEvent.click(byAttr("quick-add-kind-house"));
  type("Street address", "77 Overnight Ln");
  type("City", "Seattle");
  type("State", "wa");
  type("ZIP", "98103");
  fireEvent.click(byAttr("quick-add-continue"));
  fireEvent.click(byAttr("quick-add-model-room"));
  // Default is three rooms, already named.
  expect(screen.getByLabelText("Name for room 1")).toHaveProperty("value", "Room A");
  type("Name for room 2", "Attic");
  fireEvent.click(byAttr("quick-add-continue"));
  type("Monthly rent for Room A", "1150");
  fireEvent.click(byAttr("quick-add-fill-down"));
}

describe("Quick Add", () => {
  it("creates a by-the-room property from four answers, priced and named", async () => {
    const save = vi.fn(async () => ({ ok: true as const }));
    render(<Harness save={save} />);
    await walkByTheRoom();
    fireEvent.click(byAttr("quick-add-create"));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));

    const sub = save.mock.calls[0]![0] as ManagerListingSubmissionV1;
    expect(sub.address).toBe("77 Overnight Ln");
    expect(sub.city).toBe("Seattle");
    expect(sub.state).toBe("WA"); // upper-cased as typed
    expect(sub.zip).toBe("98103");
    expect(sub.listingPropertyTypeId).toBe("house");
    expect(sub.listingPlaceCategoryId).toBe("shared_home");
    expect(sub.rooms.map((r) => r.name)).toEqual(["Room A", "Attic", "Room C"]);
    expect(sub.rooms.map((r) => r.monthlyRent)).toEqual([1150, 1150, 1150]);

    // The property exists; the next screen offers what to do with it.
    await screen.findByText("What would you like to do next?");
  });

  it("creates a whole-place property with one rent and one room", async () => {
    const save = vi.fn(async () => ({ ok: true as const }));
    render(<Harness save={save} />);
    fireEvent.click(byAttr("quick-add-kind-apartment"));
    type("Street address", "9 Whole Pl");
    fireEvent.click(byAttr("quick-add-continue"));
    fireEvent.click(byAttr("quick-add-model-whole"));
    type("Monthly rent", "2400");
    fireEvent.click(byAttr("quick-add-create"));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const sub = save.mock.calls[0]![0] as ManagerListingSubmissionV1;
    expect(sub.listingPlaceCategoryId).toBe("entire_home");
    expect(sub.entireHomeMonthlyRent).toBe(2400);
    expect(sub.rooms).toHaveLength(1);
    expect(sub.rooms[0]!.monthlyRent).toBe(2400);
  });

  it("shows the server's own reason when a save is refused, and keeps the answers", async () => {
    const save = vi.fn(async () => ({
      ok: false as const,
      message: "This workspace has reached 10 property records, including drafts.",
    }));
    render(<Harness save={save} />);
    await walkByTheRoom();
    fireEvent.click(byAttr("quick-add-create"));
    await screen.findByText("This workspace has reached 10 property records, including drafts.");
    // Not a connection problem, and never described as one.
    expect(screen.queryByText(/connection/i)).toBeNull();
    // The rents are still there to try again with.
    expect(screen.getByLabelText("Monthly rent for Room A")).toHaveProperty("value", "1150");
  });

  it("will not create a property without a rent", async () => {
    const save = vi.fn(async () => ({ ok: true as const }));
    render(<Harness save={save} />);
    fireEvent.click(byAttr("quick-add-kind-house"));
    type("Street address", "1 No Rent St");
    fireEvent.click(byAttr("quick-add-continue"));
    fireEvent.click(byAttr("quick-add-model-whole"));
    expect((byAttr("quick-add-create") as HTMLButtonElement).disabled).toBe(true);
  });

  it("hands the created property to the editor for photos and details", async () => {
    const save = vi.fn(async () => ({ ok: true as const }));
    const onOpenEditor = vi.fn();
    render(<Harness save={save} onOpenEditor={onOpenEditor} />);
    await walkByTheRoom();
    fireEvent.click(byAttr("quick-add-create"));
    await screen.findByText("What would you like to do next?");
    fireEvent.click(byAttr("quick-add-next-details"));
    expect(onOpenEditor).toHaveBeenCalledTimes(1);
    expect((onOpenEditor.mock.calls[0]![0] as ManagerListingSubmissionV1).address).toBe("77 Overnight Ln");
  });
});
