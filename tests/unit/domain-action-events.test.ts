import { describe, expect, it } from "vitest";
import {
  ACTION_EVENT_CATALOG,
  leaseEventForTransition,
  paymentEventForTransition,
  renderLeaseActionEvent,
  renderPaymentActionEvent,
} from "@/lib/domain-action-events.server";
import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";

const lease = (patch: Partial<LeasePipelineRow> = {}): LeasePipelineRow => ({
  id: "lease-1",
  residentName: "Sam Resident",
  residentEmail: "sam@example.com",
  unit: "Unit 2A",
  stageLabel: "Review",
  updated: "Today",
  bucket: "manager",
  pdfVersion: 1,
  notes: "",
  updatedAtIso: "2026-09-04T12:00:00.000Z",
  thread: [],
  ...patch,
});

describe("canonical action-event catalog", () => {
  it("documents all three domains without parallel bus names", () => {
    expect(ACTION_EVENT_CATALOG.work_order).toContain("completed");
    expect(ACTION_EVENT_CATALOG.payment).toEqual(expect.arrayContaining(["charge_created", "payment_received", "payment_failed"]));
    expect(ACTION_EVENT_CATALOG.lease).toEqual(expect.arrayContaining(["lease_created", "lease_sent", "lease_signed"]));
  });

  it("maps only meaningful payment state transitions", () => {
    expect(paymentEventForTransition(null, "pending")).toBe("charge_created");
    expect(paymentEventForTransition("pending", "pending")).toBeNull();
    expect(paymentEventForTransition("pending", "processing")).toBe("payment_processing");
    expect(paymentEventForTransition("processing", "paid")).toBe("payment_received");
    expect(paymentEventForTransition("pending", "failed")).toBe("payment_failed");
  });

  it("maps persisted lease lifecycle markers in transition order", () => {
    expect(leaseEventForTransition(null, lease())).toBe("lease_created");
    expect(leaseEventForTransition(lease(), lease({ sentToResidentAt: "2026-09-04T13:00:00.000Z" }))).toBe("lease_sent");
    expect(leaseEventForTransition(lease({ sentToResidentAt: "sent" }), lease({ sentToResidentAt: "sent", fullySignedAt: "signed" }))).toBe("lease_signed");
    expect(leaseEventForTransition(lease(), lease({ voidedAt: "voided" }))).toBe("lease_voided");
  });

  it("renders audience-specific payment and lease copy", () => {
    const paymentFacts = { title: "September rent", amountLabel: "$1,200.00", propertyLabel: "Unit 2A" };
    expect(renderPaymentActionEvent("payment_received", "resident", paymentFacts)?.text).toContain("was received");
    expect(renderPaymentActionEvent("payment_received", "manager", paymentFacts)?.text).toContain("$1,200.00");
    expect(renderPaymentActionEvent("payment_received", "vendor", paymentFacts)).toBeNull();

    const leaseFacts = { residentName: "Sam Resident", propertyLabel: "Unit 2A" };
    expect(renderLeaseActionEvent("lease_sent", "resident", leaseFacts)?.text).toContain("ready to review and sign");
    expect(renderLeaseActionEvent("lease_signed", "manager", leaseFacts)?.text).toContain("fully signed");
    expect(renderLeaseActionEvent("lease_voided", "vendor", leaseFacts)).toBeNull();
  });
});

describe("action-event migration and retry consumer", () => {
  it("generalizes existing rows without dropping the work-order outbox", async () => {
    const fs = await import("node:fs/promises");
    const migration = await fs.readFile("supabase/migrations/20260904140000_action_event_bus.sql", "utf8");
    const bus = await fs.readFile("src/lib/action-events.server.ts", "utf8");
    expect(migration).toContain("rename to action_events");
    expect(migration).toContain("rename to action_event_deliveries");
    expect(migration).toContain("domain in ('work_order', 'payment', 'lease')");
    expect(bus).toContain('onConflict: "event_key", ignoreDuplicates: true');
    expect(bus).toContain('onConflict: "event_id,audience,recipient_key", ignoreDuplicates: true');
    expect(bus).toContain("retryDueActionEventDeliveries");
  });
});
