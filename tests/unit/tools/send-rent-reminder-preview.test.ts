import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HouseholdCharge } from "@/lib/household-charges";
import { sendRentReminderTool } from "@/lib/tools/domains/payments";
import { executeWrite, makeManagerRowsCtx, makeWritableCtx, managerRow, previewWrite } from "./fake-agent-ctx";

const { enqueueMock, portalDeliveryMock } = vi.hoisted(() => ({
  enqueueMock: vi.fn(),
  portalDeliveryMock: vi.fn(),
}));

vi.mock("@/lib/sms/owner-sms-dispatcher.server", () => ({ enqueueOwnerSms: enqueueMock }));
vi.mock("@/lib/portal-inbox-delivery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/portal-inbox-delivery")>()),
  deliverPortalMessageThreadSide: portalDeliveryMock,
}));

/**
 * PRP-270: "remind John about rent" must come back as a confirm card, through
 * the REAL preview gate (`previewWriteTool` via the fake-ctx `previewWrite`
 * helper) — Zod validation, ownership, overdue check, the fields the card
 * renders — not a direct call to the tool's `preview`.
 */
function charge(overrides: Partial<HouseholdCharge> & { id: string }): HouseholdCharge {
  return {
    createdAt: "2026-08-01T00:00:00.000Z",
    residentEmail: "john@example.com",
    residentName: "John Resident",
    residentUserId: null,
    propertyId: "cascade",
    propertyLabel: "Cascade Lofts",
    managerUserId: "manager_a",
    kind: "rent",
    title: "Rent — August 2026",
    amountLabel: "$1,200.00",
    balanceLabel: "$1,200.00",
    status: "pending",
    dueDateLabel: "Aug 1, 2026",
    ...overrides,
  } as HouseholdCharge;
}

const TABLE = "portal_household_charge_records";

beforeEach(() => {
  enqueueMock.mockReset();
  enqueueMock.mockResolvedValue({ ok: true, outboxId: "outbox_1", status: "queued", deduplicated: false });
  portalDeliveryMock.mockReset();
  portalDeliveryMock.mockResolvedValue(undefined);
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("RESEND_FROM", "PropLane <reminders@example.test>");
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true })));
});

describe("send_rent_reminder through the preview gate (PRP-270)", () => {
  it("produces a confirm card naming the resident, the charge and the balance", async () => {
    const ctx = makeManagerRowsCtx({
      [TABLE]: [managerRow("manager_a", charge({ id: "c_overdue" }))],
    });
    const res = await previewWrite(sendRentReminderTool, ctx, { chargeIds: ["c_overdue"] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.preview.title).toBe("Send rent reminder");
    expect(res.preview.confirmLabel).toBe("Send reminder");
    expect(res.preview.fields).toEqual([
      { label: "John Resident", value: "Rent — August 2026 ($1,200.00)" },
      { label: "Delivery", value: "portal + email" },
    ]);
    expect(res.preview.summary).toContain("John Resident");
    expect(res.preview.summary).toContain("$1,200.00");
  });

  it("refuses a charge that is paid, and one that is not yet due", async () => {
    const ctx = makeManagerRowsCtx({
      [TABLE]: [
        managerRow("manager_a", charge({ id: "c_paid", status: "paid", paidAt: "2026-08-02T00:00:00.000Z", balanceLabel: "$0.00" })),
        managerRow("manager_a", charge({ id: "c_future", dueDateLabel: "Jan 1, 2999" })),
      ],
    });
    expect((await previewWrite(sendRentReminderTool, ctx, { chargeIds: ["c_paid"] })).ok).toBe(false);
    expect((await previewWrite(sendRentReminderTool, ctx, { chargeIds: ["c_future"] })).ok).toBe(false);
  });

  it("never previews another landlord's charge, even with a valid id", async () => {
    const ctx = makeManagerRowsCtx({
      [TABLE]: [managerRow("manager_b", charge({ id: "c_theirs", managerUserId: "manager_b" }))],
    });
    const res = await previewWrite(sendRentReminderTool, ctx, { chargeIds: ["c_theirs"] });
    expect(res.ok).toBe(false);
  });

  it("batches several overdue charges into one card with a count", async () => {
    const ctx = makeManagerRowsCtx({
      [TABLE]: [
        managerRow("manager_a", charge({ id: "c1" })),
        managerRow("manager_a", charge({ id: "c2", residentName: "Olivia Brooks", residentEmail: "olivia@example.com" })),
      ],
    });
    const res = await previewWrite(sendRentReminderTool, ctx, { chargeIds: ["c1", "c2", "c1"] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.preview.title).toBe("Send rent reminders");
    expect(res.preview.confirmLabel).toBe("Send 2 reminders");
    expect(res.preview.fields).toHaveLength(3);
  });

  it("pins an explicit all-channel request into the confirmation and warns that SMS is queued", async () => {
    const ctx = makeManagerRowsCtx({ [TABLE]: [managerRow("manager_a", charge({ id: "c_sms" }))] });
    const res = await previewWrite(sendRentReminderTool, ctx, {
      chargeIds: ["c_sms"],
      channels: ["portal", "email", "sms"],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.input).toEqual({ chargeIds: ["c_sms"], channels: ["portal", "email", "sms"] });
    expect(res.preview.fields).toContainEqual({ label: "Delivery", value: "portal + email + SMS (queued)" });
    expect(res.preview.warnings?.join(" ")).toContain("does not prove provider delivery");
  });

  it("uses only the server-resolved verified resident profile and durable work-number outbox", async () => {
    const { ctx, store } = makeWritableCtx({
      [TABLE]: [managerRow("manager_a", charge({ id: "c_delivery", propertyId: "property_1" }))],
      profiles: [{ id: "resident_1", email: "john@example.com", phone: "+12065550123", phone_verified_at: "2026-08-01T00:00:00Z" }],
    });
    const result = await executeWrite(sendRentReminderTool, ctx, {
      chargeIds: ["c_delivery"],
      channels: ["portal", "email", "sms"],
    });


    expect(result.ok).toBe(true);
    expect(enqueueMock).toHaveBeenCalledWith(expect.objectContaining({
      managerUserId: "manager_a",
      actorUserId: "manager_a",
      recipientUserId: "resident_1",
      recipientEmail: "john@example.com",
      recipientPhone: "+12065550123",
      propertyId: "property_1",
      counterpartyRole: "resident",
      conversationKey: "manager_a:resident:resident_1",
      purpose: "manual_rent_reminder",
      sendClass: "transactional",
    }), expect.anything());
    expect(portalDeliveryMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      ownerUserId: "resident_1",
      scope: "axis_portal_inbox_resident_v1",
    }));
    expect(result.reply).toContain("portal sent for 1");
    expect(result.reply).toContain("email sent for 1");
    expect(result.reply).toContain("sms queued for 1");
    expect(store.audit_log).toHaveLength(1);
  });

  it("reports a failed SMS without suppressing the selected portal and email channels", async () => {
    enqueueMock.mockResolvedValue({ ok: false, error: "recipient_opted_out" });
    const { ctx } = makeWritableCtx({
      [TABLE]: [managerRow("manager_a", charge({ id: "c_sms_failed" }))],
      profiles: [{ id: "resident_1", email: "john@example.com", phone: "+12065550123", phone_verified_at: "2026-08-01T00:00:00Z" }],
    });
    const result = await executeWrite(sendRentReminderTool, ctx, {
      chargeIds: ["c_sms_failed"],
      channels: ["portal", "email", "sms"],
    });
    expect(result.ok).toBe(true);
    expect(result.reply).toContain("portal sent for 1");
    expect(result.reply).toContain("email sent for 1");
    expect(result.reply).toContain("sms failed for 1");
  });

  it("does not enqueue SMS for a resident without a verified phone", async () => {
    const { ctx } = makeWritableCtx({
      [TABLE]: [managerRow("manager_a", charge({ id: "c_unverified" }))],
      profiles: [{ id: "resident_1", email: "john@example.com", phone: "+12065550123", phone_verified_at: null }],
    });
    const result = await executeWrite(sendRentReminderTool, ctx, {
      chargeIds: ["c_unverified"],
      channels: ["sms"],
    });
    expect(result.ok).toBe(true);
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(result.reply).toContain("sms unavailable for 1");
  });

  it("keeps deferred and unknown outbox outcomes distinct from SMS delivery", async () => {
    const { ctx } = makeWritableCtx({
      [TABLE]: [managerRow("manager_a", charge({ id: "c_deferred" }))],
      profiles: [{ id: "resident_1", email: "john@example.com", phone: "+12065550123", phone_verified_at: "2026-08-01T00:00:00Z" }],
    });
    enqueueMock.mockResolvedValueOnce({ ok: true, outboxId: "outbox_deferred", status: "deferred", deduplicated: false });
    const deferred = await executeWrite(sendRentReminderTool, ctx, { chargeIds: ["c_deferred"], channels: ["sms"] });
    expect(deferred.reply).toContain("sms deferred for 1");
    expect(deferred.reply).not.toContain("sms sent");

    const { ctx: unknownCtx } = makeWritableCtx({
      [TABLE]: [managerRow("manager_a", charge({ id: "c_unknown" }))],
      profiles: [{ id: "resident_1", email: "john@example.com", phone: "+12065550123", phone_verified_at: "2026-08-01T00:00:00Z" }],
    });
    enqueueMock.mockResolvedValueOnce({ ok: true, outboxId: "outbox_unknown", status: "unknown", deduplicated: true });
    const unknown = await executeWrite(sendRentReminderTool, unknownCtx, { chargeIds: ["c_unknown"], channels: ["sms"] });
    expect(unknown.reply).toContain("sms outcome unknown for 1");
    expect(unknown.reply).not.toContain("sms sent");
  });

  it("does not enqueue a second SMS when the same charge is confirmed again that day", async () => {
    const { ctx } = makeWritableCtx({
      [TABLE]: [managerRow("manager_a", charge({ id: "c_dedupe" }))],
      profiles: [{ id: "resident_1", email: "john@example.com", phone: "+12065550123", phone_verified_at: "2026-08-01T00:00:00Z" }],
    });
    const input = { chargeIds: ["c_dedupe"], channels: ["sms"] as const };
    const first = await executeWrite(sendRentReminderTool, ctx, input);
    const second = await executeWrite(sendRentReminderTool, ctx, input);
    expect(first.reply).toContain("sms queued for 1");
    expect(second.reply).toContain("already sent today");
    expect(enqueueMock).toHaveBeenCalledTimes(1);
  });
});
