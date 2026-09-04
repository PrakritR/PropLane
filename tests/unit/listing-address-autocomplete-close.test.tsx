/**
 * @vitest-environment jsdom
 *

 * AXI-142 — "in the drop down for street address even when select it is always
 * stays open."
 *
 * Choosing a suggestion settles the field over MORE than one render: the parent
 * writes the sanitized street address and the city / state / ZIP it filled in
 * from the same suggestion. The old one-shot `skipNextFetch` flag was consumed
 * by the first of those renders, so a later one re-ran the search and reopened
 * the list on top of the address the manager had just chosen.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { ListingAddressAutocomplete } from "@/components/portal/listing-address-autocomplete";

const SUGGESTION = {
  id: "s1",
  label: "4709A 8th Ave NE, Seattle, WA 98105",
  address: "4709A 8th Ave NE",
  city: "Seattle",
  state: "WA",
  zip: "98105",
};

/** Mirrors the wizard: onSelect writes the address AND the city/state/zip. */
function Harness() {
  const [address, setAddress] = useState("");
  const [, setCity] = useState("");
  return (
    <ListingAddressAutocomplete
      value={address}
      onChange={setAddress}
      onSelect={(s) => {
        setAddress(s.address);
        setCity(s.city ?? "");
      }}
    />
  );
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      json: async () => ({ suggestions: [SUGGESTION] }),
    })) as unknown as typeof fetch,
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function openSuggestions() {
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: "4709A 8th" } });
  await vi.advanceTimersByTimeAsync(400);
  return input;
}

describe("street address suggestions close when one is chosen", () => {
  it("stays closed after a pick, even though the parent re-renders again", async () => {
    render(<Harness />);
    await openSuggestions();
    await waitFor(() => expect(screen.getByRole("listbox")).toBeTruthy());

    fireEvent.click(screen.getByText(SUGGESTION.address));

    // Let every debounce window that a follow-up render could have scheduled expire.
    await vi.advanceTimersByTimeAsync(1000);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("searches again once the manager edits the chosen address", async () => {
    render(<Harness />);
    await openSuggestions();
    await waitFor(() => expect(screen.getByRole("listbox")).toBeTruthy());
    fireEvent.click(screen.getByText(SUGGESTION.address));
    await vi.advanceTimersByTimeAsync(1000);
    expect(screen.queryByRole("listbox")).toBeNull();

    // Editing releases the guard — the field is searchable again.
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "1234 Different Ave" } });
    await vi.advanceTimersByTimeAsync(400);
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeTruthy());
  });
});
