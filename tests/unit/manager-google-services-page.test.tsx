// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const replace = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => new URLSearchParams(),
}));

import ManagerGoogleServicesPage from "@/app/auth/manager/connect-google/page";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  replace.mockClear();
});

describe("manager Google services page", () => {
  it("PRP-130: offers Calendar consent and a non-blocking skip, and no longer offers Gmail", async () => {
    // `gmail.readonly` is a RESTRICTED Google scope — verification plus a paid
    // annual security assessment — and it exists only to match Zelle/Venmo
    // receipts, which are being recorded by hand for now. Removing the card is
    // what takes PropLane out of that tier; `calendar.events` is merely
    // sensitive.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("google-calendar")) {
          return new Response(JSON.stringify({ connected: false, email: null, configured: true }), {
            status: 200,
          });
        }
        return new Response(
          JSON.stringify({ status: { connected: false, email: null, configured: true } }),
          { status: 200 },
        );
      }),
    );

    render(<ManagerGoogleServicesPage />);

    await waitFor(() => expect(screen.getByText("Connect Calendar")).toBeTruthy());
    expect(screen.queryByText("Connect Gmail")).toBeNull();
    expect(screen.queryByText("Gmail payment receipts")).toBeNull();
    expect(screen.getByRole("button", { name: "Skip for now" })).toBeTruthy();

    const calendarLink = screen.getByText("Connect Calendar").closest("a");
    expect(calendarLink?.getAttribute("href")).toContain("/api/portal/google-calendar/connect");
  });
});
