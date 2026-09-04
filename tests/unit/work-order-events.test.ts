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
    expect(renderWorkOrderEvent("created", "resident", facts)?.text).toContain("was logged");
    expect(renderWorkOrderEvent("vendor_offered", "vendor", facts)?.text).toContain("new work-order offer");
    expect(renderWorkOrderEvent("vendor_offered", "manager", facts)?.text).toContain("3 vendors");
    expect(renderWorkOrderEvent("accepted", "resident", facts)?.text).toContain("booked");
    expect(renderWorkOrderEvent("scheduled", "manager", facts)).toBeNull();
    expect(renderWorkOrderEvent("completed", "resident", facts)?.text).toContain("Reply YES or NO");
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
