import { describe, expect, it } from "vitest";
import {
  inferMaintenanceCategoryLabel,
  inferMaintenancePriority,
  inferMaintenanceTitle,
  looksLikeMaintenanceRequest,
} from "@/lib/claw-maintenance-detect";
import { maintenanceWorkOrderResidentAck } from "@/lib/claw-maintenance-work-order.server";

describe("looksLikeMaintenanceRequest", () => {
  it("detects toilet / plumbing repair asks", () => {
    expect(looksLikeMaintenanceRequest("my toilet is broken can you fix")).toBe(true);
    expect(looksLikeMaintenanceRequest("The sink is leaking under the cabinet")).toBe(true);
    expect(looksLikeMaintenanceRequest("no hot water please help")).toBe(true);
  });

  it("ignores unrelated chat", () => {
    expect(looksLikeMaintenanceRequest("hey")).toBe(false);
    expect(looksLikeMaintenanceRequest("when is rent due?")).toBe(false);
    expect(looksLikeMaintenanceRequest("thanks")).toBe(false);
  });
});

describe("maintenance inference", () => {
  it("maps toilet text to plumbing + title", () => {
    expect(inferMaintenanceCategoryLabel("my toilet is broken")).toBe("Plumbing");
    expect(inferMaintenanceTitle("my toilet is broken can you fix")).toBe("Toilet issue");
  });

  it("raises priority for emergencies", () => {
    expect(inferMaintenancePriority("apartment is flooding")).toBe("Emergency");
    expect(inferMaintenancePriority("toilet broken")).toBe("Medium");
  });
});

describe("maintenanceWorkOrderResidentAck", () => {
  it("acks a newly filed work order", () => {
    const ack = maintenanceWorkOrderResidentAck({
      created: true,
      workOrderId: "REQ-SMS-1",
      reference: "WO-1042",
      title: "Toilet issue",
      category: "plumbing",
    });
    expect(ack).toContain("Toilet issue");
    // The product calls this a service everywhere a person reads it; the table,
    // the tools and this module keep the work-order name internally.
    expect(ack).toMatch(/service/i);
    expect(ack).not.toMatch(/work order/i);
    expect(ack).toContain("WO-1042");
  });
});
