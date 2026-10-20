// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BookingsEditSheet } from "@/components/portal/bookings-edit-sheet";
import type { PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";
import { AppUiProvider } from "@/components/providers/app-ui-provider";

const request: PropertyBookingEntry = {
  source: "block", propertyId: "house", propertyLabel: "Cedar Court", roomId: "room", roomLabel: "Attic Nook", summary: "Priya N.",
  residentName: "Priya N.", blockId: "block-1", start: "2099-10-20", end: "2099-10-22", rate: 140, rateBasis: "daily", bookingStatus: "hold",
  reason: "Short-stay request", stayDetails: { source: "guest_portal", holdExpiresAt: "2099-10-15T00:00:00Z" },
};

const sheet = (entry: PropertyBookingEntry, onClose = vi.fn()) =>
  render(<AppUiProvider><BookingsEditSheet entry={entry} entries={[entry]} onClose={onClose} onSave={vi.fn()} /></AppUiProvider>);

beforeEach(() => vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("a guest's request in the booking sheet", () => {
  it("shows Approve and Decline as icon actions (the word is the label only) and no Status menu to confirm it by hand", () => {
    sheet(request);
    const approve = screen.getByRole("button", { name: "Approve" });
    const decline = screen.getByRole("button", { name: "Decline" });
    expect(approve.textContent?.trim()).toBe("");
    expect(decline.textContent?.trim()).toBe("");
    expect(approve.getAttribute("data-slot")).toBe("portal-icon-action");
  });

  it("Approve posts the decision for this block and closes", async () => {
    const onClose = vi.fn();
    sheet(request, onClose);
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/portal/bookings/short-stay-decision");
    expect(JSON.parse(String(init.body))).toEqual({ blockId: "block-1", decision: "approve" });
  });

  it("Decline posts decline, and a refusal is shown without closing", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Response(JSON.stringify({ error: "That request was already answered." }), { status: 409 }));
    const onClose = vi.fn();
    sheet(request, onClose);
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    expect(await screen.findByText("That request was already answered.")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    expect(JSON.parse(String((fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1].body))).toEqual({ blockId: "block-1", decision: "decline" });
  });

  it("a public-card request gets the same two actions", () => {
    sheet({ ...request, stayDetails: { source: "public_short_stay_request" } });
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
  });

  it("offers neither on a manager's own hold, a confirmed stay or a cancelled one", () => {
    for (const entry of [
      { ...request, stayDetails: { source: "Direct" } },
      { ...request, bookingStatus: "confirmed" as const },
      { ...request, bookingStatus: "cancelled" as const },
    ]) {
      sheet(entry);
      expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Decline" })).toBeNull();
      cleanup();
    }
  });
});

describe("the guest's booking application on the hold", () => {
  it("shows purpose, who else is staying, the message and the house-rules agreement to the host", () => {
    const withApplication: PropertyBookingEntry = {
      ...request,
      stayDetails: {
        ...request.stayDetails,
        application: { purpose: "work", message: "Landing at 9 pm.", guestNames: ["Sam Lee"], rulesAgreedAt: "2099-10-14T00:00:00Z" },
      },
    };
    sheet(withApplication);
    const facts = document.querySelector('[data-attr="bookings-stay-application"]')!;
    expect(facts.textContent).toContain("Work or business");
    expect(facts.textContent).toContain("Sam Lee");
    expect(facts.textContent).toContain("Landing at 9 pm.");
    expect(facts.textContent).toContain("Agreed");
  });

  it("draws nothing for a hold that carries no application (a text or older request)", () => {
    sheet(request);
    expect(document.querySelector('[data-attr="bookings-stay-application"]')).toBeNull();
  });
});
