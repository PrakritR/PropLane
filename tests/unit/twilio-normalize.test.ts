import { describe, expect, it } from "vitest";
import { normalizeE164 } from "@/lib/twilio";

describe("normalizeE164", () => {
  it("normalizes bare US numbers", () => {
    expect(normalizeE164("2065551234")).toBe("+12065551234");
    expect(normalizeE164("(206) 555-1234")).toBe("+12065551234");
    expect(normalizeE164("12065551234")).toBe("+12065551234");
    expect(normalizeE164(12065551234)).toBe("+12065551234");
  });

  it("passes through international E.164 input", () => {
    expect(normalizeE164("+442079460958")).toBe("+442079460958");
    expect(normalizeE164("+44 20 7946 0958")).toBe("+442079460958");
    expect(normalizeE164("+52 55 1234 5678")).toBe("+525512345678");
    expect(normalizeE164(" +12065551234 ")).toBe("+12065551234");
  });

  it("rejects garbage and impossible lengths", () => {
    expect(normalizeE164("")).toBeNull();
    expect(normalizeE164("call me")).toBeNull();
    expect(normalizeE164("+0123456789")).toBeNull();
    expect(normalizeE164("+123")).toBeNull();
    expect(normalizeE164("+1206555")).toBeNull();
    expect(normalizeE164("+1234567890123456")).toBeNull();
    expect(normalizeE164("555-1234")).toBeNull();
  });
});
