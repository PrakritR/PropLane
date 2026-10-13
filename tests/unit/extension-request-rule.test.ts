import { describe, expect, it } from "vitest";
import {
  EXTENSION_REQUEST_RULE_LEASING,
  EXTENSION_REQUEST_RULE_MANAGER,
  EXTENSION_REQUEST_RULE_RESIDENT,
} from "@/lib/agent/extension-request-rule";
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
