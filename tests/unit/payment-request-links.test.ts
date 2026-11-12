import { beforeEach, describe, expect, it, vi } from "vitest";
import { inboxEventAction } from "@/lib/inbox-event-card";

describe("a payment request card's Pay opens that charge's pay sheet", () => {
  const ref = { kind: "payment", id: "hc_1", label: "Rent" } as never;

  it("resident Pay carries the charge id and start=1", () => {
    for (const kind of ["charge_created", "payment_failed", "late_fee_applied"] as const) {
      expect(inboxEventAction("resident", kind, ref)).toEqual({ label: "Pay", href: "/resident/payments?pay=hc_1&start=1" });
    }
  });

  it("encodes the id, and falls back to the list with no ref or another kind of ref", () => {
    expect(inboxEventAction("resident", "charge_created", { kind: "payment", id: "a b&c", label: "x" } as never)?.href)
      .toBe("/resident/payments?pay=a%20b%26c&start=1");
    expect(inboxEventAction("resident", "charge_created")?.href).toBe("/resident/payments");
    expect(inboxEventAction("resident", "charge_created", { kind: "lease", id: "l1", label: "x" } as never)?.href).toBe("/resident/payments");
  });

  it("the manager's card is untouched, and a paid card is a plain View", () => {
    expect(inboxEventAction("manager", "charge_created", ref)).toEqual({ label: "View", href: "/portal/payments" });
    expect(inboxEventAction("resident", "payment_received", ref)).toEqual({ label: "View", href: "/resident/payments" });
  });
});

const mint = vi.fn();
vi.mock("@/lib/payments/rent-reminder-links.server", () => ({ mintRentReminderPayLink: (...a: unknown[]) => mint(...a) }));
vi.mock("@/lib/app-url", () => ({ resolveEmailLinkBaseUrl: () => "https://proplane.ai" }));

import { chargeEventSmsWithPayLink, isPayRequestPaymentEvent } from "@/lib/payments/charge-event-pay-link.server";

function fakeDb(charge: Record<string, unknown> | null, profile: Record<string, unknown> | null = { phone: "+12065550100", phone_verified_at: "2026-01-01" }) {
  return {
    from(table: string) {
      const data = table === "profiles" ? profile : charge ? { row_data: charge, manager_user_id: "mgr_1" } : null;
      return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data }) }) }) };
    },
  } as never;
}
const CHARGE = { id: "hc_1", status: "pending", residentUserId: "res_1", residentEmail: "r@x.com", propertyId: "p1", title: "Rent", balanceLabel: "$1,500.00" };

describe("a charge text carries a link that opens that charge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mint.mockResolvedValue({ kind: "phone_bound", url: "https://proplane.ai/l/abc" });
  });

  it("names which payment events are requests to pay", () => {
    for (const e of ["charge_created", "payment_failed", "late_fee_applied", "partial_received"]) expect(isPayRequestPaymentEvent("payment", e)).toBe(true);
    expect(isPayRequestPaymentEvent("payment", "payment_received")).toBe(false);
    expect(isPayRequestPaymentEvent("lease", "charge_created")).toBe(false);
  });

  it("mints a phone-bound link from the STORED charge and composes the text around it", async () => {
    const text = await chargeEventSmsWithPayLink(fakeDb(CHARGE), {
      managerUserId: "mgr_1", chargeId: "hc_1", recipientUserId: "res_1", recipientEmail: "r@x.com", text: "A new $1,500.00 charge for Rent was added.",
    });
    expect(text).toContain("https://proplane.ai/l/abc");
    expect(text).toContain("Pay here:");
    expect(mint).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ ownerUserId: "mgr_1", phone: "+12065550100" }));
  });

  it("sends no link for someone else's charge, a paid charge, or a charge that cannot be read", async () => {
    const base = { managerUserId: "mgr_1", chargeId: "hc_1", text: "t" };
    expect(await chargeEventSmsWithPayLink(fakeDb(CHARGE), { ...base, recipientUserId: "someone_else" })).toBeNull();
    expect(await chargeEventSmsWithPayLink(fakeDb({ ...CHARGE, status: "paid" }), { ...base, recipientUserId: "res_1" })).toBeNull();
    expect(await chargeEventSmsWithPayLink(fakeDb(null), { ...base, recipientUserId: "res_1" })).toBeNull();
    expect(mint).not.toHaveBeenCalled();
  });

  it("never throws: a failing link service leaves the ordinary text", async () => {
    mint.mockRejectedValue(new Error("rate limited"));
    expect(await chargeEventSmsWithPayLink(fakeDb(CHARGE), { managerUserId: "mgr_1", chargeId: "hc_1", recipientUserId: "res_1", text: "t" })).toBeNull();
  });
});
