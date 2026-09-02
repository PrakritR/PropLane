import { describe, expect, it } from "vitest";
import {
  AGENT_SYSTEM_PROMPTS,
  composeAgentSystemPrompt,
  LEASING_SMS_AGENT_SYSTEM_PROMPT,
  MANAGER_SMS_AGENT_SYSTEM_PROMPT,
  RESIDENT_SMS_AGENT_SYSTEM_PROMPT,
  VENDOR_WORK_ORDER_SMS_SYSTEM_PROMPT,
} from "@/lib/agent/system-prompts";

describe("assembled agent system prompts", () => {
  it("applies the same natural-response rules to every conversational surface", () => {
    expect(Object.keys(AGENT_SYSTEM_PROMPTS)).toEqual([
      "managerPortal",
      "residentPortal",
      "vendorPortal",
      "generalWebsite",
      "leasingSms",
      "residentSms",
      "managerSms",
      "vendorWorkOrderSms",
      "residentInbox",
    ]);

    for (const prompt of Object.values(AGENT_SYSTEM_PROMPTS)) {
      expect(prompt).toMatch(/Respond to the situation in the user's latest message/i);
      expect(prompt).toMatch(/Never use an em dash/i);
      expect(prompt).toMatch(/Do not default to headings, a recap, or a long list/i);
      expect(prompt).toMatch(/Ask one focused follow-up/i);
    }
  });

  it("adds stricter phone-native rules only to SMS agents", () => {
    for (const prompt of [
      LEASING_SMS_AGENT_SYSTEM_PROMPT,
      RESIDENT_SMS_AGENT_SYSTEM_PROMPT,
      MANAGER_SMS_AGENT_SYSTEM_PROMPT,
      VENDOR_WORK_ORDER_SMS_SYSTEM_PROMPT,
    ]) {
      expect(prompt).toMatch(/Never use markdown, headings, or bullet lists in a text message/i);
      expect(prompt).toMatch(/one clear purpose per message/i);
    }

    expect(AGENT_SYSTEM_PROMPTS.managerPortal).not.toMatch(/one clear purpose per message/i);
  });

  it("composes deterministically without changing the supplied surface instructions", () => {
    const prompt = composeAgentSystemPrompt("Surface-specific rule.", "portal");
    expect(prompt.startsWith("Surface-specific rule.\n\nStanding response rules:")).toBe(true);
    expect(prompt).not.toContain("SMS response rules:");
  });
});
