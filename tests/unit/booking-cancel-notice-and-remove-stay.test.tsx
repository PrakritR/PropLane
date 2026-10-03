// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AppUiProvider } from "@/components/providers/app-ui-provider";
import { BookingsRemoveStayDialog } from "@/components/portal/bookings-remove-stay-dialog";
import { bookingCancelNoticeBody, canNotifyBookingGuest, sendBookingCancelNotice } from "@/lib/channel-calendar/booking-cancel-notice";
import { canRemoveChannelStay } from "@/lib/channel-calendar/booking-presentation";
import type { PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";

afterEach(cleanup);

const block: PropertyBookingEntry = { source: "block", propertyId: "prop-1", propertyLabel: "Alder House", roomId: "r2", roomLabel: "Room 2", summary: "Taylor Brooks", residentName: "Taylor Brooks", residentEmail: "Taylor@Example.test", blockId: "block-1", start: "2099-01-01", end: "2099-01-05" };
const channel: PropertyBookingEntry = { source: "airbnb", propertyId: "prop-1", propertyLabel: "Alder House", roomId: "r2", roomLabel: "Room 2", summary: "Marcus", start: "2099-02-01", end: "2099-02-04", connectionId: "conn-1", sourceUid: "uid-marcus" };

describe("Notify guest sends through the authorized inbox send", () => {
  it("is available only when there is an email to reach the guest on", () => {
    expect(canNotifyBookingGuest(block)).toBe(true);
    expect(canNotifyBookingGuest({ residentEmail: "  " })).toBe(false);
    expect(canNotifyBookingGuest({})).toBe(false);
  });

  it("names the guest, place and dates in the notice", () => {
    const { subject, text } = bookingCancelNoticeBody(block);
    expect(subject).toContain("Alder House");
    expect(text).toContain("Taylor Brooks");
    expect(text).toContain("Alder House · Room 2");
    expect(text).toMatch(/2099/);
  });

  it("posts to /api/portal/send-inbox-message with the booking recordRef and reports the route's answer", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/profile") return new Response(JSON.stringify({ fullName: "Pat Manager", email: "pat@example.test" }), { status: 200 });
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await sendBookingCancelNotice(block, fetchImpl);
    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("/api/portal/send-inbox-message");
    expect(calls[0]!.body).toMatchObject({
      toEmails: ["taylor@example.test"],
      deliverToPortalInbox: true,
      deliverViaEmail: true,
      fromName: "Pat Manager",
      senderPortal: "manager",
      recordRef: { kind: "booking", id: "block:block-1", label: "Taylor Brooks" },
    });
  });

  it("surfaces a refused send and never claims it went out", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url === "/api/profile" ? new Response("{}", { status: 200 }) : new Response(JSON.stringify({ ok: false, error: "Not allowed" }), { status: 403 }),
    ) as unknown as typeof fetch;
    expect(await sendBookingCancelNotice(block, fetchImpl)).toEqual({ ok: false, error: "Not allowed" });
  });

  it("sends nothing when the guest has no email", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    expect((await sendBookingCancelNotice({ ...block, residentEmail: undefined }, fetchImpl)).ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("Remove stay (channel feed reservation)", () => {
  it("is offered only for a feed reservation with a connection and a UID", () => {
    expect(canRemoveChannelStay(channel)).toBe(true);
    expect(canRemoveChannelStay({ ...channel, sourceUid: undefined })).toBe(false);
    expect(canRemoveChannelStay(block)).toBe(false);
    expect(canRemoveChannelStay({ ...channel, blockId: "b" })).toBe(false);
  });

  it("asks once, removes by connection + UID, then Undo restores the same stay", async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const restore = vi.fn().mockResolvedValue(undefined);
    const onChanged = vi.fn();
    const onClose = vi.fn();
    render(<AppUiProvider><BookingsRemoveStayDialog entry={channel} onClose={onClose} onChanged={onChanged} remove={remove} restore={restore} /></AppUiProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Remove stay" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy());
    expect(remove).toHaveBeenCalledWith({ connectionId: "conn-1", sourceUid: "uid-marcus" });
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(restore).toHaveBeenCalledWith({ connectionId: "conn-1", sourceUid: "uid-marcus" }));
    expect(onChanged).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenCalled();
  });

  it("a failed removal shows the error and does not claim the stay is gone", async () => {
    const remove = vi.fn().mockRejectedValue(new Error("Forbidden."));
    render(<AppUiProvider><BookingsRemoveStayDialog entry={channel} onClose={() => {}} onChanged={() => {}} remove={remove} restore={vi.fn()} /></AppUiProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Remove stay" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Forbidden."));
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });
});
