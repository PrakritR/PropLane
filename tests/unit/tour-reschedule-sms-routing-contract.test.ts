import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("tour reschedule SMS inbound routing", () => {
  it("keeps carrier control handling before the leasing route", () => {
    const source = readFileSync("src/app/api/twilio/inbound/route.ts", "utf8");
    expect(source).toContain('const SMS_START_KEYWORDS = new Set(["START", "YES", "UNSTOP"])');
    expect(source).toContain('if (suppression.ok && !suppression.optedOut) controlKeyword = null');
    expect(source.indexOf("if (controlKeyword)")).toBeGreaterThan(-1);
    expect(source.indexOf("if (controlKeyword)")).toBeLessThan(source.indexOf("handleClawLeasingInbound({"));
  });

  it("persists prospect inbound before resolving a tour reply and before the generic agent", () => {
    const source = readFileSync("src/lib/claw-leasing-bot.server.ts", "utf8");
    const prospectPersistence = source.indexOf("counterpartyRole: \"prospect\"");
    const tourReply = source.indexOf("handleTourRescheduleSmsReply");
    const genericAgent = source.indexOf("runLeasingSmsAgentTurn", tourReply);
    expect(prospectPersistence).toBeGreaterThan(-1);
    expect(tourReply).toBeGreaterThan(prospectPersistence);
    expect(genericAgent).toBeGreaterThan(tourReply);
  });
});
