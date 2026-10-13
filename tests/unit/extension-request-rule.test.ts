import { describe, expect, it } from "vitest";
import {
  EXTENSION_REQUEST_RULE_LEASING,
  EXTENSION_REQUEST_RULE_MANAGER,
  EXTENSION_REQUEST_RULE_RESIDENT,
} from "@/lib/agent/extension-request-rule";
import { NO_LONG_DASHES_RULE, THANK_YOU_REPLY_RULE, stripLongDashes } from "@/lib/agent/conversation-style-rules";
import { SYSTEM_PROMPT } from "@/lib/agent/system-prompt";
import { RESIDENT_PERSONAL_AGENT_SURFACE_PROMPT } from "@/lib/agent/resident-personal-agent-system-prompt";
import {
  LEASING_SMS_AGENT_SYSTEM_PROMPT,
  MANAGER_SMS_AGENT_SYSTEM_PROMPT,
} from "@/lib/agent/system-prompts";

const CORE = [
  "Extension requests",
  "check_room_availability",
  "BEFORE answering",
  "Airbnb change request",
  "say which night is booked",
  "Never promise nights you have not checked",
];

function hasCore(prompt: string) {
  expect(prompt).toContain(THANK_YOU_REPLY_RULE);
  expect(prompt).toContain(NO_LONG_DASHES_RULE);
  for (const piece of CORE) expect(prompt).toContain(piece);
}

describe("extension request rule", () => {
  it("is in the manager portal assistant prompt with the hold-extension offer", () => {
    expect(SYSTEM_PROMPT).toContain(EXTENSION_REQUEST_RULE_MANAGER);
    hasCore(SYSTEM_PROMPT);
    expect(SYSTEM_PROMPT).toContain("update_room_block");
  });
  it("is in the manager SMS agent prompt", () => {
    expect(MANAGER_SMS_AGENT_SYSTEM_PROMPT).toContain(EXTENSION_REQUEST_RULE_MANAGER);
    hasCore(MANAGER_SMS_AGENT_SYSTEM_PROMPT);
  });
  it("is in the leasing SMS prompt and stays answer-only", () => {
    expect(LEASING_SMS_AGENT_SYSTEM_PROMPT).toContain(EXTENSION_REQUEST_RULE_LEASING);
    hasCore(LEASING_SMS_AGENT_SYSTEM_PROMPT);
    expect(EXTENSION_REQUEST_RULE_LEASING).not.toContain("update_room_block");
    expect(EXTENSION_REQUEST_RULE_LEASING).toContain("text this work number");
  });
  it("is in the resident personal agent prompt without a write offer", () => {
    expect(RESIDENT_PERSONAL_AGENT_SURFACE_PROMPT).toContain(EXTENSION_REQUEST_RULE_RESIDENT);
    hasCore(RESIDENT_PERSONAL_AGENT_SURFACE_PROMPT);
    expect(EXTENSION_REQUEST_RULE_RESIDENT).not.toContain("update_room_block");
  });
});

describe("stripLongDashes", () => {
  it("replaces spaced dashes with commas and range dashes with hyphens", () => {
    expect(stripLongDashes("Yes \u2014 it is free")).toBe("Yes, it is free");
    expect(stripLongDashes("Oct 3\u20135")).toBe("Oct 3-5");
    expect(stripLongDashes("a \u2013 b \u2014 c")).toBe("a, b, c");
  });
  it("passes null, empty and clean text through", () => {
    expect(stripLongDashes(null)).toBeNull();
    expect(stripLongDashes("")).toBe("");
    expect(stripLongDashes("Plain - text.")).toBe("Plain - text.");
  });
});
