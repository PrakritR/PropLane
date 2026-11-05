import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ notify: vi.fn(), workspace: vi.fn(), service: vi.fn() }));
vi.mock("@/lib/service/service-manager-alerts.server", () => ({ alertServiceManagerFromNotice: mocks.service }));
vi.mock("@/lib/work-number-recipients.server", () => ({ notifyWorkNumberRecipients: mocks.notify }));
vi.mock("@/lib/one-number/link-destinations.server", () => ({ resolveWorkspaceForProperty: mocks.workspace }));

import { OPS_ALERT_KINDS, alertLine, alertPhonesOf } from "@/lib/one-number/ops-alerts.server";
import { isGsm7 } from "@/lib/one-number/segments";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.notify.mockResolvedValue({ texted: 1, emailed: 0 });
  mocks.workspace.mockResolvedValue("ws-from-house");
  mocks.service.mockResolvedValue("sent");
});

describe("alertPhonesOf", () => {
  it("covers the six spec alerts that the existing spine reaches the owner for", () => {
    expect([...OPS_ALERT_KINDS].sort()).toEqual(
      [
        "emergency_maintenance", "new_application", "payment_late", "payment_failed", "tour_booked", "unanswered_question",
        "checkin_checkout_today", "booking_created", "tour_requested", "tour_cancelled", "application_started",
      ].sort(),
    );
  });

  it("texts only the owner's listed alert phones, from the workspace the house belongs to, once per event", async () => {
    const out = await alertPhonesOf({} as never, { ownerUserId: "owner", kind: "tour_booked", entityId: "tour-1", propertyId: "p1", text: "Tour confirmed: Sam at 5259." });
    expect(out).toEqual({ texted: 1, emailed: 0 });
    expect(mocks.workspace).toHaveBeenCalledWith(expect.anything(), "p1", "owner");
    expect(mocks.notify).toHaveBeenCalledWith(expect.anything(), {
      ownerUserId: "owner",
      workspaceId: "ws-from-house",
      subject: "Tour booked",
      text: "Tour confirmed: Sam at 5259.",
      idempotencyKey: "ops-alert:tour_booked:tour-1",
    });
  });

  it("prefers a workspace it was handed and passes a link through", async () => {
    await alertPhonesOf({} as never, { ownerUserId: "owner", workspaceId: "ws-x", kind: "new_application", entityId: "app-1", text: "New application.", url: "https://x.test/portal/applications" });
    expect(mocks.workspace).not.toHaveBeenCalled();
    expect(mocks.notify.mock.calls[0]![1]).toMatchObject({ workspaceId: "ws-x", url: "https://x.test/portal/applications" });
  });

  it("never sends a card or bank number, and keeps the text a plain GSM-7 line", () => {
    const line = alertLine("Paid with 4242 4242 4242 4242 — it’s “done” \n now");
    expect(line).not.toContain("4242 4242");
    expect(isGsm7(line)).toBe(true);
    expect(line).not.toContain("\n");
  });

  it("sends nothing for an empty event and never throws into the event it follows", async () => {
    expect(await alertPhonesOf({} as never, { ownerUserId: "owner", kind: "payment_failed", entityId: "", text: "x" })).toEqual({ texted: 0, emailed: 0 });
    expect(await alertPhonesOf({} as never, { ownerUserId: "", kind: "payment_failed", entityId: "c1", text: "x" })).toEqual({ texted: 0, emailed: 0 });
    expect(await alertPhonesOf({} as never, { ownerUserId: "owner", kind: "payment_failed", entityId: "c1", text: "   " })).toEqual({ texted: 0, emailed: 0 });
    expect(mocks.notify).not.toHaveBeenCalled();
    mocks.notify.mockRejectedValue(new Error("down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await alertPhonesOf({} as never, { ownerUserId: "owner", kind: "payment_failed", entityId: "c1", text: "Payment failed." })).toEqual({ texted: 0, emailed: 0 });
    spy.mockRestore();
  });

  it("tells the Service-settings phone only the kinds the notice spine never carried to it", async () => {
    await alertPhonesOf({} as never, { ownerUserId: "owner", kind: "checkin_checkout_today", entityId: "p1:2026-11-04", propertyId: "p1", text: "Today 4709A - check-in Room 4 (Anthony)." });
    expect(mocks.service).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ workspaceId: "ws-from-house", idempotencyKey: "ops-alert:checkin_checkout_today:p1:2026-11-04" }));
    mocks.service.mockClear();
    await alertPhonesOf({} as never, { ownerUserId: "owner", kind: "application_started", entityId: "app-1", propertyId: "p1", text: "Application started - Sam P." });
    expect(mocks.service).toHaveBeenCalledTimes(1);
    mocks.service.mockClear();
    for (const kind of ["booking_created", "tour_requested", "tour_cancelled", "new_application", "tour_booked"] as const) {
      await alertPhonesOf({} as never, { ownerUserId: "owner", kind, entityId: `${kind}-1`, propertyId: "p1", text: "x event." });
    }
    expect(mocks.service).not.toHaveBeenCalled();
  });

  it("keeps the digest whole up to three segments while other alerts stay one short line", () => {
    const long = "Today 4709A - " + "check-in Room 4 (Anthony, Airbnb, 3 PM), ".repeat(8);
    expect(alertLine(long).length).toBe(220);
    expect(alertLine(long, 440).length).toBeGreaterThan(220);
  });

  it("a digest for the same house and day is one idempotency key, a different day or house another", async () => {
    const run = (entityId: string) => alertPhonesOf({} as never, { ownerUserId: "owner", kind: "checkin_checkout_today", entityId, propertyId: "p1", text: "Today 4709A - check-in Room 4 (Anthony)." });
    await run("p1:2026-11-04");
    await run("p1:2026-11-04");
    await run("p1:2026-11-05");
    await run("p2:2026-11-04");
    const keys = mocks.notify.mock.calls.map((call) => (call[1] as { idempotencyKey: string }).idempotencyKey);
    expect(keys[0]).toBe(keys[1]);
    expect(new Set(keys).size).toBe(3);
  });

  it("shares the bus notice's key for an event that also rides the action-event bus, so the phones hear it once", async () => {
    await alertPhonesOf({} as never, { ownerUserId: "owner", kind: "booking_created", entityId: "native:b1:booking_created", propertyId: "p1", idempotencyKey: "action-event:native:b1:booking_created:manager", text: "New booking - 5259 Room 2." });
    expect(mocks.notify.mock.calls[0]![1]).toMatchObject({ idempotencyKey: "action-event:native:b1:booking_created:manager" });
  });
});
