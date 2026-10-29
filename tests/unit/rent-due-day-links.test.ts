// "Rent is due today. Check your texts for your pay link." must be true: each resident with rent due today
// and a verified phone gets their own text with their own phone-bound link.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";

const mocks = vi.hoisted(() => ({ send: vi.fn(), mint: vi.fn() }));
vi.mock("@/lib/payments/rent-text-send.server", () => ({ sendResidentRentText: mocks.send }));
vi.mock("@/lib/payments/rent-reminder-links.server", () => ({ mintRentReminderPayLink: mocks.mint }));

import { sendRentDueDayLinks } from "@/lib/automations/rent-due-links.server";
import type { HouseSubject, LeaseSubject } from "@/lib/automations/moments";

const house = { ownerUserId: "mgr", workspaceId: "ws", propertyId: "prop-1", propertyLabel: "5259 Brooklyn", roomSecrets: [] } as HouseSubject;
const lease = (over: Partial<LeaseSubject> = {}): LeaseSubject => ({
  leaseId: "l1", ownerUserId: "mgr", workspaceId: "ws", propertyId: "prop-1", propertyLabel: "5259 Brooklyn", roomLabel: null,
  residentName: "Maya Lee", firstName: "Maya", residentUserId: "res-1", residentEmail: "maya@example.com", phoneKey: "2065550142",
  signedKey: null, moveIn: null, moveOut: null, ...over,
});
const charge = (id: string, over: Record<string, unknown> = {}) => ({
  id, kind: "rent", residentUserId: "res-1", propertyId: "prop-1", amountLabel: "$850.00", balanceLabel: "$850.00",
  rentMonth: "2026-11", dueDay: 1, status: "pending", ...over,
});
const db = (charges: unknown[], profile: Record<string, unknown> = {}) =>
  createMemoryDb({
    portal_household_charge_records: charges.map((c) => ({ id: (c as { id: string }).id, property_id: "prop-1", status: "pending", row_data: c })),
    profiles: [{ id: "res-1", phone: "(206) 555-0142", phone_verified_at: "2026-09-01T00:00:00Z", ...profile }],
  }) as never;

beforeEach(() => {
  mocks.send.mockReset().mockResolvedValue({ ok: true });
  mocks.mint.mockReset().mockResolvedValue({ kind: "phone_bound", url: "https://proplane.ai/l/Zk3T9v1q8mY2nB7cX4wR6pD0sL5hJ1aF3gU9eO8iKt" });
});

describe("sendRentDueDayLinks", () => {
  it("texts a resident with rent due today their own amount and their own link", async () => {
    expect(await sendRentDueDayLinks(db([charge("c1")]), { house, roster: [lease()], todayKey: "2026-11-01" })).toEqual({ sent: 1, skipped: 0 });
    expect(mocks.mint).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ ownerUserId: "mgr", phoneVerifiedAt: "2026-09-01T00:00:00Z" }));
    const text = mocks.send.mock.calls[0]![1];
    expect(text.body).toBe("Rent of $850.00 for 5259 Brooklyn is due today.\nPay here:\nhttps://proplane.ai/l/Zk3T9v1q8mY2nB7cX4wR6pD0sL5hJ1aF3gU9eO8iKt");
    expect(text).toMatchObject({ purpose: "rent_due_link", sendClass: "automated", propertyId: "prop-1", residentUserId: "res-1", idempotencyKey: "rent-due-link:2026-11-01:c1" });
  });

  it("texts no one for a charge due another day, a resident with no charge, no phone or an unverified phone", async () => {
    expect(await sendRentDueDayLinks(db([charge("c1", { dueDay: 5 })]), { house, roster: [lease()], todayKey: "2026-11-01" })).toEqual({ sent: 0, skipped: 1 });
    expect(await sendRentDueDayLinks(db([charge("c1")]), { house, roster: [lease({ residentUserId: "res-2" })], todayKey: "2026-11-01" })).toEqual({ sent: 0, skipped: 1 });
    expect(await sendRentDueDayLinks(db([charge("c1")]), { house, roster: [lease({ phoneKey: null })], todayKey: "2026-11-01" })).toEqual({ sent: 0, skipped: 1 });
    expect(await sendRentDueDayLinks(db([charge("c1")], { phone_verified_at: null }), { house, roster: [lease()], todayKey: "2026-11-01" })).toEqual({ sent: 0, skipped: 1 });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("a refused text (no consent, STOP, no line) is skipped, never thrown", async () => {
    mocks.send.mockResolvedValue({ ok: false, error: "recipient_opted_out" });
    expect(await sendRentDueDayLinks(db([charge("c1")]), { house, roster: [lease()], todayKey: "2026-11-01" })).toEqual({ sent: 0, skipped: 1 });
  });
});
