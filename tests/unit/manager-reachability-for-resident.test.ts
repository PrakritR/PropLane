import { describe, expect, it } from "vitest";
import {
  appendManagerReachabilityToWelcomeBody,
  managerReachabilityWelcomeParagraphs,
} from "@/lib/manager-reachability-for-resident";

describe("manager reachability for resident", () => {
  it("adds work phone and email before the signup link", () => {
    const body = appendManagerReachabilityToWelcomeBody(
      ["Hi,", "", "Create your resident portal account here:", "https://example.com/setup"],
      { workPhoneLabel: "(206) 555-9000", assistantEmail: "assist@prop-lane.space" },
    );
    expect(body).toContain("Reach your property manager:");
    expect(body).toContain("• Text: (206) 555-9000");
    expect(body).toContain("• Email: assist@prop-lane.space");
    const signupIdx = body.indexOf("Create your resident portal account here:");
    const reachIdx = body.indexOf("Reach your property manager:");
    expect(reachIdx).toBeGreaterThan(-1);
    expect(reachIdx).toBeLessThan(signupIdx);
  });

  it("returns nothing when neither channel is configured", () => {
    expect(managerReachabilityWelcomeParagraphs({ workPhoneLabel: null, assistantEmail: null })).toEqual([]);
  });
});
