/**
 * @vitest-environment jsdom
 *
 * PRP-492 — a cancelled in-flight suggest must clear “Searching addresses…”.
 * HTTP errors become an empty list plus an optional error line, never a stuck spinner.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { ListingAddressAutocomplete } from "@/components/portal/listing-address-autocomplete";

function Harness() {
  const [address, setAddress] = useState("");
  return <ListingAddressAutocomplete value={address} onChange={setAddress} onSelect={(s) => setAddress(s.address)} />;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("street address lookup loading and errors", () => {
  it("clears Searching addresses… when the query changes mid-flight", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise(() => {
            /* hang until cancelled */
          }),
      ) as unknown as typeof fetch,
    );

    render(<Harness />);
    const input = screen.getByRole("textbox");
    input.focus();
    fireEvent.change(input, { target: { value: "123 Main St" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(fetch).toHaveBeenCalled();
    expect(screen.getByText("Searching addresses…")).toBeTruthy();

    fireEvent.change(input, { target: { value: "123 Main Street" } });
    expect(screen.queryByText("Searching addresses…")).toBeNull();
  });

  it("treats an HTTP error as empty plus an error line", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 502,
        json: async () => ({ error: "Address lookup failed." }),
      })) as unknown as typeof fetch,
    );

    render(<Harness />);
    const input = screen.getByRole("textbox");
    input.focus();
    fireEvent.change(input, { target: { value: "123 Main St" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    await waitFor(() =>
      expect(screen.getByText("Address lookup failed. Type the street, city, state, and ZIP.")).toBeTruthy(),
    );
    expect(screen.queryByText("Searching addresses…")).toBeNull();
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});
