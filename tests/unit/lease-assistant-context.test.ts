import { describe, expect, it } from "vitest";
import { buildLeaseModalAssistantContext, buildLeasePacketEditAssistantContext } from "@/lib/lease-assistant-context";
import { isLeaseAssistantContext, isLeasePacketEditAssistantContext } from "@/lib/agent/assistant-turn-context";

describe("buildLeaseModalAssistantContext", () => {
  it("includes propertyId and current lease source", () => {
    const ctx = buildLeaseModalAssistantContext({
      propertyId: "mgr-oak-1",
      propertyLabel: "Oak House",
      currentSource: "axis_default",
    });
    expect(ctx).toContain("propertyId=mgr-oak-1");
    expect(ctx).toContain("property=Oak House");
    expect(ctx).toContain("update_property_lease_config");
  });

  it("flags bulk edits for single-property tool calls", () => {
    const ctx = buildLeaseModalAssistantContext({
      propertyIds: ["a", "b"],
      currentSource: "custom_comments",
    });
    expect(ctx).toContain("propertyIds=a,b");
    // The context must tell the model that a section edit lands on ONE property
    // even when several are selected. Assert the phrase that carries that
    // meaning today rather than older wording.
    expect(ctx).toContain("one property at a time");
  });
});

describe("isLeaseAssistantContext", () => {
  it("detects lease modal hints", () => {
    expect(isLeaseAssistantContext("Lease modal · propertyId=p1")).toBe(true);
    expect(isLeaseAssistantContext("New promotion (flyer)")).toBe(false);
  });
});


describe("buildLeasePacketEditAssistantContext", () => {
  it("includes lease id and update tool guidance", () => {
    const ctx = buildLeasePacketEditAssistantContext({
      id: "lease_1",
      residentName: "Sofia Diaz",
      residentEmail: "sofia@example.com",
      unit: "Room 1",
      bucket: "manager",
      status: "Manager Review",
      application: {
        managerRentOverride: "$1,050.00",
        leaseTerm: "12 months",
        leaseStart: "2026-08-01",
        leaseEnd: "2027-07-31",
      },
    } as never);
    expect(ctx).toContain("leaseId=lease_1");
    expect(ctx).toContain("update_lease_packet");
    expect(ctx).toContain("$1,050.00");
  });
});

describe("isLeasePacketEditAssistantContext", () => {
  it("detects packet edit hints", () => {
    expect(isLeasePacketEditAssistantContext("Lease packet edit · leaseId=x")).toBe(true);
    expect(isLeasePacketEditAssistantContext("Lease modal · propertyId=p1")).toBe(false);
  });
});
