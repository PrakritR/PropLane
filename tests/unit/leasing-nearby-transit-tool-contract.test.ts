import { describe, expect, it } from "vitest";
import { getNearbyTransitTool } from "@/lib/tools/domains/leasing-sms";
import { leasingSmsAgentRegistry } from "@/lib/tools";

describe("nearby transit leasing tool contract", () => {
  it("accepts only a property id and fixed mode", () => {
    expect(getNearbyTransitTool.inputSchema.safeParse({ propertyId: "p1", mode: "bart" }).success).toBe(true);
    expect(getNearbyTransitTool.inputSchema.safeParse({ propertyId: "p1", latitude: 1, longitude: 2 }).success).toBe(false);
    expect(getNearbyTransitTool.inputSchema.safeParse({ propertyId: "p1", mode: "walking" }).success).toBe(false);
    expect(leasingSmsAgentRegistry.get("get_nearby_transit")?.kind).toBe("read");
  });
});
