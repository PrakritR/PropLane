// Wording found by the end-to-end harness: a resident asking "how much do I owe" got a link instead of the figure, and
// a lockout got three questions at once (including which house they live in).
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { AGENT_SYSTEM_PROMPTS } from "@/lib/agent/system-prompts";
import { TRIAGE_QUESTIONS, triageGuidanceForPrompt } from "@/lib/vendor-dispatch/triage";

describe("resident texting prompt", () => {
  it("answers an amount or a date with the figure from get_my_balance, then the link", () => {
    expect(AGENT_SYSTEM_PROMPTS.residentSms).toMatch(/how much do I owe[\s\S]*get_my_balance/);
    expect(AGENT_SYSTEM_PROMPTS.residentSms).toMatch(/Links first/);
  });
  it("the lockout questions never ask a verified resident which house they live in or for their name", () => {
    const text = TRIAGE_QUESTIONS.lockout.join(" ");
    expect(text).not.toMatch(/which house|room are you|text your name/i);
    expect(text).toMatch(/911/);
  });
  it("asks one question per text and never which house", () => {
    const guidance = triageGuidanceForPrompt();
    expect(guidance).toMatch(/exactly ONE question in each text/);
    expect(guidance).toMatch(/never ask which house or room/);
  });
});
