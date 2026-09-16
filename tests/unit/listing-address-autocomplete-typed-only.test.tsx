/**
 * @vitest-environment jsdom
 *
 * PLAN-0915-2012 — "have street address constant saved unless edited; every time
 * I open it has it as drop down."
 *
 * The search effect used to run on every `value` change, and the saved address
 * arriving from the record counted as one. Opening a listing therefore searched
 * its own address and popped the suggestion list over City / State / ZIP with
 * nothing clicked or typed. The list may only open for text the manager typed
 * in this session, and only while the box has focus.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { ListingAddressAutocomplete } from "@/components/portal/listing-address-autocomplete";

const SAVED = "5257 Brooklyn Avenue Northeast";
const SUGGESTION = {
  id: "s1",
  label: "5257 Brooklyn Avenue Northeast, Seattle, WA 98105",
  address: "5257 Brooklyn Avenue Northeast",
  city: "Seattle",
  state: "WA",
  zip: "98105",
};

let resolveFetch: (() => void) | null = null;

/** Mirrors the wizard: the record's address is already in state on mount. */
function Harness({ initial = SAVED, prefillTo }: { initial?: string; prefillTo?: string }) {
  const [address, setAddress] = useState(initial);
  return (
    <>
      <ListingAddressAutocomplete value={address} onChange={setAddress} onSelect={(s) => setAddress(s.address)} />
      {prefillTo ? (
        <button type="button" onClick={() => setAddress(prefillTo)}>
          prefill
        </button>
      ) : null}
    </>
  );
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  resolveFetch = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise((resolve) => {
          resolveFetch = () => resolve({ json: async () => ({ suggestions: [SUGGESTION] }) });
        }),
    ) as unknown as typeof fetch,
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("street address suggestions open only for typed text", () => {
  it("mounts with the saved address and neither searches nor opens the list", async () => {
    render(<Harness />);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.queryByText("Searching addresses…")).toBeNull();
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe(SAVED);
  });

  it("clicking into the box without typing still shows nothing", async () => {
    render(<Harness />);
    const input = screen.getByRole("textbox");
    fireEvent.focus(input);
    fireEvent.click(input);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("searches and opens the list once the manager types", async () => {
    render(<Harness />);
    const input = screen.getByRole("textbox");
    input.focus();
    fireEvent.change(input, { target: { value: `${SAVED} A` } });
    await vi.advanceTimersByTimeAsync(400);
    expect(fetch).toHaveBeenCalledTimes(1);
    resolveFetch?.();
    await waitFor(() => expect(screen.getByRole("listbox")).toBeTruthy());
  });

  it("a value written by the parent (prefill / reload) does not open the list", async () => {
    render(<Harness initial="" prefillTo="4709A 8th Ave NE" />);
    fireEvent.click(screen.getByText("prefill"));
    await vi.advanceTimersByTimeAsync(1000);
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("4709A 8th Ave NE");
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("a slow reply that lands after the manager left the box does not reopen it", async () => {
    render(<Harness />);
    const input = screen.getByRole("textbox");
    input.focus();
    fireEvent.change(input, { target: { value: `${SAVED} A` } });
    await vi.advanceTimersByTimeAsync(400);
    expect(fetch).toHaveBeenCalledTimes(1);
    input.blur();
    resolveFetch?.();
    await vi.advanceTimersByTimeAsync(100);
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});
