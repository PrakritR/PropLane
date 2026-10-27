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
const auth = vi.hoisted(() => ({ current: { ready: true, userId: null as string | null, hasResidentRole: false } }));
vi.mock("@/hooks/use-prospect-contact-autofill", () => ({ useProspectContactAutofill: () => auth.current }));
vi.mock("@/lib/sheet-sync/dates", async (orig) => ({ ...(await orig<typeof import("@/lib/sheet-sync/dates")>()), pacificTodayKey: () => "2026-10-12" }));

import { ShortStayBookingBlock, ShortStayProvider, useShortStay } from "@/components/marketing/short-stay-booking";

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

function PickRoom() {
  const stay = useShortStay();
  return <button type="button" onClick={() => stay?.setRoomId("r3")}>pick room 3</button>;
}

beforeEach(() => vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 }))));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); auth.current = { ready: true, userId: null, hasResidentRole: false }; });

describe("short-stay booking card", () => {
  it("has no verdicts until a valid range is picked, then dims only the booked room", async () => {
    render(<ShortStayProvider property={property}><Probe /></ShortStayProvider>);
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual(["no-range", "no-range"]);
    fireEvent.click(screen.getByText("pick dates"));
    await waitFor(() => expect(document.querySelector('[data-room="r1"]')?.textContent).toBe("Booked Oct 21 – Oct 23 · free from Oct 23"));
    expect(document.querySelector('[data-room="r3"]')?.textContent).toBe("free");
  });

  it("is absent when disabled (the manager's own preview) or the listing offers no short stay", () => {
    const { container, rerender } = render(<ShortStayProvider property={property} disabled><ShortStayBookingBlock /></ShortStayProvider>);
    expect(container.querySelector('[data-attr="short-stay-block"]')).toBeNull();
    rerender(<ShortStayProvider property={{ ...property, listingSubmission: { v: 1, rooms: [{ id: "r1" }] } } as unknown as MockProperty}><ShortStayBookingBlock /></ShortStayProvider>);
    expect(container.querySelector('[data-attr="short-stay-block"]')).toBeNull();
  });

  it("prints no price header of its own (the card's one price line sits above it), and never a dash", () => {
    render(<ShortStayProvider property={property}><ShortStayBookingBlock /></ShortStayProvider>);
    expect(screen.queryByText("/ night")).toBeNull();
    expect(document.body.textContent).not.toContain("—");
  });

  it("shows the live total; Request to book waits for a room and never offers a text link, a number or Quick book", async () => {
    render(<ShortStayProvider property={property}><ShortStayBookingBlock /><Probe /></ShortStayProvider>);
    const request = screen.getByRole("button", { name: "Request to book" }) as HTMLButtonElement;
    expect(request.disabled).toBe(true);
    fireEvent.click(screen.getByText("pick dates"));
    await waitFor(() => expect(screen.getByText("$55 × 4 nights")).toBeTruthy());
    expect(screen.getByText("$220")).toBeTruthy();
    expect(request.disabled).toBe(true);
    expect(document.querySelector('a[href^="sms:"], a[href^="tel:"]')).toBeNull();
    expect(screen.queryByText(/Text us|Quick book/)).toBeNull();
    expect(document.body.textContent).not.toMatch(/\(814\)|8146793694/);
    expect(document.body.textContent).not.toContain("— / night");
  });

  it("a signed-out visitor's Request to book makes a resident account, then opens the portal's stay request with the picks", async () => {
    render(
      <ShortStayProvider property={property}>
        <ShortStayBookingBlock />
        <Probe />
        <PickRoom />
      </ShortStayProvider>,
    );
    fireEvent.click(screen.getByText("pick dates"));
    fireEvent.click(screen.getByText("pick room 3"));
    const book = await screen.findByRole("link", { name: "Request to book" });
    const href = book.getAttribute("href")!;
    expect(href.startsWith("/auth/create-account?mode=create&role=resident&next=")).toBe(true);
    expect(decodeURIComponent(href.split("next=")[1]!)).toBe("/resident/applications/stay?listing=prop-1&room=r3&checkIn=2026-10-20&checkOut=2026-10-24&guests=1");
    // Nothing is sent from the public card: no form, no request.
    expect(screen.queryByLabelText("Your name")).toBeNull();
    expect(fetch).not.toHaveBeenCalledWith("/api/public/short-stay-request", expect.anything());
  });

  it("a signed-in resident goes straight to the portal's stay request", async () => {
    auth.current = { ready: true, userId: "u1", hasResidentRole: true };
    render(
      <ShortStayProvider property={property}>
        <ShortStayBookingBlock />
        <Probe />
        <PickRoom />
      </ShortStayProvider>,
    );
    fireEvent.click(screen.getByText("pick dates"));
    fireEvent.click(screen.getByText("pick room 3"));
    const book = await screen.findByRole("link", { name: "Request to book" });
    expect(book.getAttribute("href")).toBe("/resident/applications/stay?listing=prop-1&room=r3&checkIn=2026-10-20&checkOut=2026-10-24&guests=1");
  });
});
