import { describe, expect, it } from "vitest";
import { renderWorkOrderEvent, workOrderDeliveryPolicy } from "@/lib/work-order-events.server";

const facts = {
  reference: "WO-1042",
  title: "Leaking sink",
  propertyLabel: "12 Main St · 3B",
  scheduledFor: "Sep 5 at 10:00 AM",
  vendorName: "North Plumbing",
  offerCount: 3,
  amountCents: 12550,
  accessInstructions: "Use lockbox 1234",
  residentContact: "555-0100",
};

describe("work-order event audience rendering", () => {
  it("renders the lifecycle matrix and intentionally omits manager scheduling noise", () => {
    expect(renderWorkOrderEvent("created", "resident", facts)?.text).toContain("We received");
    expect(renderWorkOrderEvent("vendor_offered", "vendor", facts)?.text).toContain("New offer");
    expect(renderWorkOrderEvent("vendor_offered", "manager", facts)?.text).toContain("3 vendors");
    expect(renderWorkOrderEvent("accepted", "resident", facts)?.text).toContain("booked");
    expect(renderWorkOrderEvent("scheduled", "manager", facts)?.text).toContain("is scheduled for");
    expect(renderWorkOrderEvent("completed", "resident", facts)?.text).toContain("was marked complete");
    expect(renderWorkOrderEvent("completed", "resident", { ...facts, confirmUrl: "https://x/r" })?.text).toContain("Was it fixed?");
    expect(renderWorkOrderEvent("invoiced", "manager", facts)?.text).toContain("$125.50");
    expect(renderWorkOrderEvent("paid", "vendor", facts)?.text).toContain("Payment of $125.50 was sent");
  });

  it("keeps access instructions and resident contact out of non-vendor messages", () => {
    const resident = renderWorkOrderEvent("accepted", "resident", facts)?.text ?? "";
    const manager = renderWorkOrderEvent("accepted", "manager", facts)?.text ?? "";
    const vendor = renderWorkOrderEvent("accepted", "vendor", facts)?.text ?? "";
    expect(resident).not.toContain("1234");
    expect(resident).not.toContain("555-0100");
    expect(manager).not.toContain("1234");
    expect(manager).not.toContain("555-0100");
    expect(vendor).toContain("1234");
    expect(vendor).toContain("555-0100");
  });
});

describe("work-order event delivery policy", () => {
  it("defers non-emergency SMS during quiet hours until 8am", () => {
    const now = new Date("2026-09-05T06:30:00.000Z"); // 11:30pm Pacific
    const policy = workOrderDeliveryPolicy({ now, recentEventCount: 0 });
    expect(policy.deferSms).toBe(true);
    expect(new Date(policy.nextAttemptAt!).getTime()).toBeGreaterThan(now.getTime());
  });

  it("lets emergencies pass quiet hours and digests the fifth rapid change", () => {
    const atNight = new Date("2026-09-05T06:30:00.000Z");
    expect(workOrderDeliveryPolicy({ now: atNight, emergency: true, recentEventCount: 9 }).deferSms).toBe(false);
    const daytime = new Date("2026-09-04T19:00:00.000Z"); // noon Pacific
    expect(workOrderDeliveryPolicy({ now: daytime, recentEventCount: 3 }).digest).toBe(false);
    expect(workOrderDeliveryPolicy({ now: daytime, recentEventCount: 4 })).toMatchObject({ deferSms: true, digest: true });
  });
});

describe("work-order event migration", () => {
  it("defines an idempotent event log and retryable audience deliveries", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile("supabase/migrations/20260904130000_work_order_events.sql", "utf8"),
    );
    expect(source).toContain("event_key text not null unique");
    expect(source).toContain("unique (event_id, audience, recipient_key)");
    expect(source).toContain("status in ('pending', 'failed', 'deferred')");
    expect(source).toContain("enable row level security");
  });
});

describe("PLAN-0915 work-order events", () => {
  it("renders the vendor loop for the right audiences only", () => {
    const base = { reference: "WO-1", title: "Leaking faucet", propertyLabel: "5257 Brooklyn", vendorName: "Juniper", amountCents: 18000 };
    expect(renderWorkOrderEvent("offer_expiring", "vendor", { ...base, expiresLabel: "Thu 4:00 PM" })?.text).toContain("expires Thu 4:00 PM");
    expect(renderWorkOrderEvent("offer_expiring", "manager", base)).toBeNull();
    expect(renderWorkOrderEvent("offer_expired", "manager", base)?.text).toContain("No vendor accepted");
    expect(renderWorkOrderEvent("offer_filled", "vendor", base)?.text).toContain("filled by another vendor");
    expect(renderWorkOrderEvent("en_route", "resident", { ...base, etaMinutes: 25 })?.text).toContain("on the way");
    expect(renderWorkOrderEvent("en_route", "manager", base)).toBeNull();
    expect(renderWorkOrderEvent("resident_reopened", "vendor", { ...base, note: "still dripping" })?.text).toContain("still dripping");
    expect(renderWorkOrderEvent("rated", "vendor", { ...base, rating: 5 })?.text).toContain("5★");
    expect(renderWorkOrderEvent("invoice_disputed", "vendor", { ...base, note: "line 2?" })?.text).toContain("line 2?");
    expect(renderWorkOrderEvent("invoice_approved", "manager", base)).toBeNull();
    expect(renderWorkOrderEvent("created", "resident", { ...base, responsePromise: "within 4 hours", emergencyPhone: "(206) 555-0100" })?.text).toContain("within 4 hours");
  });
});
