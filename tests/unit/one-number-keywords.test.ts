import { describe, expect, it } from "vitest";
import { classifySharedLineKeyword } from "@/lib/one-number/keywords";

describe("classifySharedLineKeyword", () => {
  it.each(["HUMAN", "human", "Agent", "person", "representative", "  Human!  ", "HUMAN please", "human, pls", "agent."])(
    "reads %j as HUMAN",
    (body) => expect(classifySharedLineKeyword(body)).toBe("HUMAN"),
  );

  it.each([
    "I want to talk to a human about my rent",
    "human resources office hours",
    "Is a person coming Tuesday?",
    "humans",
  ])("does not read %j as HUMAN (the whole body must be the keyword)", (body) =>
    expect(classifySharedLineKeyword(body)).not.toBe("HUMAN"),
  );

  it.each([
    "fire in the kitchen",
    "FIRE",
    "the fire alarm is chirping",
    "I smell smoke",
    "smoke",
    "there is a gas leak",
    "I smell gas",
    "the basement is flooding",
    "burst pipe in room 2",
    "someone broke in",
    "break-in last night",
    "carbon monoxide alarm going off",
    "I am locked out",
    "Locked   out again",
  ])("flags %j as EMERGENCY", (body) => expect(classifySharedLineKeyword(body)).toBe("EMERGENCY"));

  it.each([
    "we have firewood in the garage",
    "he was fired today",
    "fireplace is not working",
    "smoker on the porch",
    "my rent is due",
    "is the gasoline can in the shed okay",
    "",
    "   ",
  ])("leaves %j alone", (body) => expect(classifySharedLineKeyword(body)).toBeNull());

  it("handles null and undefined", () => {
    expect(classifySharedLineKeyword(null)).toBeNull();
    expect(classifySharedLineKeyword(undefined)).toBeNull();
  });
});
