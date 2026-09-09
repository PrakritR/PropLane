import { describe, expect, it } from "vitest";
import { LEASING_SMS_SYSTEM_PROMPT } from "@/lib/agent/leasing-sms-system-prompt";

describe("leasing transit prompt", () => {
  it("requires grounding, distance labeling, attribution, and no invented duration", () => {
    expect(LEASING_SMS_SYSTEM_PROMPT).toContain("call get_nearby_transit");
    expect(LEASING_SMS_SYSTEM_PROMPT).toContain("approximate straight-line distance");
    expect(LEASING_SMS_SYSTEM_PROMPT).toContain("OpenStreetMap");
    expect(LEASING_SMS_SYSTEM_PROMPT).toContain("Never turn that distance into walking time");
  });
});
