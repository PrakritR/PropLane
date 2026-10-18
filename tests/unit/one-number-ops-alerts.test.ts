import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ notify: vi.fn(), workspace: vi.fn() }));
vi.mock("@/lib/work-number-recipients.server", () => ({ notifyWorkNumberRecipients: mocks.notify }));
vi.mock("@/lib/one-number/link-destinations.server", () => ({ resolveWorkspaceForProperty: mocks.workspace }));

import { OPS_ALERT_KINDS, alertLine, alertPhonesOf } from "@/lib/one-number/ops-alerts.server";
import { isGsm7 } from "@/lib/one-number/segments";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.notify.mockResolvedValue({ texted: 1, emailed: 0 });
  mocks.workspace.mockResolvedValue("ws-from-house");
});

describe("alertPhonesOf", () => {
  it("covers the six spec alerts that the existing spine reaches the owner for", () => {
    expect([...OPS_ALERT_KINDS].sort()).toEqual(
      ["emergency_maintenance", "new_application", "payment_late", "payment_failed", "tour_booked", "unanswered_question"].sort(),
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
});
