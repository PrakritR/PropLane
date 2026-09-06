import { describe, expect, it } from "vitest";
import {
  assistantContextHintFromMessages,
  assistantContextHintFromRequest,
  withAssistantTaskContext,
  MAX_ASSISTANT_CONTEXT_LENGTH,
  isListingDraftAssistantContext,
  isPromotionAssistantContext,
} from "@/lib/agent/assistant-turn-context";

describe("assistant turn context hints", () => {
  it("parses the Context prefix from the last user message", () => {
    const hint = assistantContextHintFromMessages([
      {
        role: "user",
        content: "[Context: New promotion (flyer) · propertyId=p1]\n\nMatch this flyer",
      },
    ]);
    expect(hint).toContain("New promotion");
    expect(hint).toContain("propertyId=p1");
  });

  it("reads text blocks from multipart user content", () => {
    const hint = assistantContextHintFromMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "[Context: Add listing · Photos]\n\nHere are photos" },
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "abc" } },
        ],
      },
    ]);
    expect(isListingDraftAssistantContext(hint)).toBe(true);
  });

  it("classifies promotion vs listing draft surfaces", () => {
    expect(isPromotionAssistantContext("New promotion (flyer) · propertyId=mgr-1")).toBe(true);
    expect(isPromotionAssistantContext("Payment reminders modal")).toBe(false);
    expect(isListingDraftAssistantContext("Add listing · Photos")).toBe(true);
    expect(isListingDraftAssistantContext("New promotion (flyer)")).toBe(false);
  });
});


describe("separate request context", () => {
  it("prefers the separate bounded hint while preserving legacy prefix routing", () => {
    const messages = [{ role: "user" as const, content: "[Context: Add listing]\nHi" }];
    expect(assistantContextHintFromRequest("New promotion", messages)).toBe("New promotion");
    expect(assistantContextHintFromRequest(undefined, messages)).toBe("Add listing");
    expect(assistantContextHintFromRequest("", messages)).toBe("");
    expect(assistantContextHintFromRequest("x".repeat(20_000), messages)).toHaveLength(MAX_ASSISTANT_CONTEXT_LENGTH);
    expect(messages[0]?.content).toBe("[Context: Add listing]\nHi");
  });

  it("includes internal context in the final system prompt as untrusted data", () => {
    const now = Date.parse("2026-09-05T20:00:00-07:00");
    const system = withAssistantTaskContext("Role instructions", "INTERNAL_SENTINEL", now);
    expect(system).toContain("Role instructions");
    expect(system).toContain("INTERNAL_SENTINEL");
    expect(system).toContain("untrusted reference data");
    expect(system).toContain("Do not echo this context in chat, previews, or delivered message bodies");
    expect(system).toContain("today is 2026-09-05");
    const clockOnly = withAssistantTaskContext("Role instructions", "", now);
    expect(clockOnly).toContain("Role instructions");
    expect(clockOnly).toContain("Internal clock (Pacific): today is 2026-09-05");
    expect(clockOnly).not.toContain("untrusted reference data");
  });
});
