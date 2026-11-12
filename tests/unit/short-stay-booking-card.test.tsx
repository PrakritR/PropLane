// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { MockProperty } from "@/data/types";

vi.mock("@/hooks/use-listing-public-occupancy", () => ({
  useListingPublicOccupancy: () => ({
    loading: false,
    rooms: [{ roomChoice: "prop-1::r1", spans: [{ start: "2026-10-21", end: "2026-10-22", count: 1 }] }],
  }),
}));
vi.mock("@/lib/sheet-sync/dates", async (orig) => ({ ...(await orig<typeof import("@/lib/sheet-sync/dates")>()), pacificTodayKey: () => "2026-10-12" }));

import { ShortStayProvider, useShortStay } from "@/components/marketing/short-stay-booking";

const property = {
  id: "prop-1",
  title: "5257 Brooklyn Ave",
  contactSmsPhone: "+18146793694",
  listingSubmission: {
    v: 1,
    shortTermRentalsAllowed: true,
    shortTermDailyCost: "55",
    rooms: [
      { id: "r1", name: "Room 1", occupancyCapacity: 1 },
      { id: "r3", name: "Room 3", occupancyCapacity: 2 },
    ],
  },
} as unknown as MockProperty;

function Probe() {
  const stay = useShortStay();
  return (
    <ul>
      {["r1", "r3"].map((id) => {
        const verdict = stay?.verdictFor(id);
        return <li key={id} data-room={id}>{verdict ? (verdict.free ? "free" : verdict.label) : "no-range"}</li>;
      })}
      <button type="button" onClick={() => { stay?.setCheckIn("2026-10-20"); stay?.setCheckOut("2026-10-24"); }}>pick dates</button>
    </ul>
  );
}

beforeEach(() => vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 }))));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("short-stay verdicts", () => {
  it("has no verdicts until a valid range is picked, then dims only the booked room", async () => {
    render(<ShortStayProvider property={property}><Probe /></ShortStayProvider>);
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual(["no-range", "no-range"]);
    fireEvent.click(screen.getByText("pick dates"));
    await waitFor(() => expect(document.querySelector('[data-room="r1"]')?.textContent).toBe("Booked Oct 21 – Oct 23 · free from Oct 23"));
    expect(document.querySelector('[data-room="r3"]')?.textContent).toBe("free");
  });

  it("offers no stay when disabled (the manager's own preview) or the listing has no short-stay rate", () => {
    function Read() { return <span data-offered={String(useShortStay()?.offered)} />; }
    const offered = (p: MockProperty, disabled = false) => {
      const { container, unmount } = render(<ShortStayProvider property={p} disabled={disabled}><Read /></ShortStayProvider>);
      const value = container.querySelector("[data-offered]")?.getAttribute("data-offered") === "true";
      unmount();
      return value;
    };
    expect(offered(property)).toBe(true);
    expect(offered(property, true)).toBe(false);
    expect(offered({ ...property, listingSubmission: { v: 1, rooms: [{ id: "r1" }] } } as unknown as MockProperty)).toBe(false);
  });

  it("no longer exports a booking block: the listing page has no short-stay entry point (captain, Nov 12)", async () => {
    const mod = await import("@/components/marketing/short-stay-booking");
    expect(Object.keys(mod)).not.toContain("ShortStayBookingBlock");
    render(<ShortStayProvider property={property}><Probe /></ShortStayProvider>);
    expect(document.querySelector('[data-attr="short-stay-block"], [data-attr="short-stay-request"]')).toBeNull();
  });
});
