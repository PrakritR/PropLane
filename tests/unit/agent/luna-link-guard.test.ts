import { describe, expect, it } from "vitest";
import { guardLunaFailedLookupClaim, guardLunaReplyLinks } from "@/lib/agent/luna-link-guard";

describe("Luna portal link grounding", () => {
  it("allows exact links from successful scoped tool results", () => {
    const output = { links: { services: "/resident/services", documents: "https://proplane.ai/resident/documents" } };
    expect(guardLunaReplyLinks("Open [Services](/resident/services) or https://proplane.ai/resident/documents.", [output]))
      .toBe("Open [Services](/resident/services) or https://proplane.ai/resident/documents.");
    expect(guardLunaReplyLinks("Open [Services](/resident/services).", [{ note: "Use /resident/services to file a request." }]))
      .toBe("Open [Services](/resident/services).");
    expect(guardLunaReplyLinks("Email manager@example.com or visit www.example.com/pay.", [{ email: "manager@example.com", note: "www.example.com/pay" }]))
      .toBe("Email manager@example.com or visit www.example.com/pay.");
  });

  it("blocks an invented route after an unavailable or failed lookup", () => {
    const reply = guardLunaReplyLinks("Open [Inspections](/resident/inspections).", [{ fixtureStatus: "no_record_configured" }]);
    expect(reply).toMatch(/can't verify that link/);
    expect(reply).not.toContain("/resident/inspections");
    expect(guardLunaReplyLinks("Open /resident/services.", [])).toMatch(/can't verify that link/);
    for (const text of [
      "[Payments](//example.invalid/pay)",
      "[Payments](payments)",
      "[Payments](/%72esident/payments)",
      "[Payments][pay]\n\n[pay]: /resident/payments",
      "Open www.example.com/pay now.",
      "Email fake@example.com for payment.",
    ]) expect(guardLunaReplyLinks(text, [])).toMatch(/can't verify that link/);
  });

  it("does not alter factual answers without links", () => {
    expect(guardLunaReplyLinks("I could not verify an available tour time.", []))
      .toBe("I could not verify an available tour time.");
  });

  it("neutralizes any unresolved read error and preserves valid empty reads", () => {
    const answer = "No service record is available for you.";
    expect(guardLunaFailedLookupClaim(answer, true)).toMatch(/couldn't verify/);
    expect(guardLunaFailedLookupClaim(answer, false)).toBe(answer);
    expect(guardLunaFailedLookupClaim("Your payment is paid.", true)).toMatch(/couldn't verify/);
  });
});
