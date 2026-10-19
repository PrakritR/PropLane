import { describe, expect, it } from "vitest";
import { isGsm7, smsSegmentCount, toGsm7 } from "@/lib/one-number/segments";

describe("one-number segment guard", () => {
  it("keeps a change preview readable: an arrow becomes 'to'", () => {
    expect(toGsm7("Monthly rent: $900/mo \u2192 $850/mo")).toBe("Monthly rent: $900/mo to $850/mo");
    expect(toGsm7("Room A\u2192Room B")).toBe("Room A to Room B");
  });

  it("rewrites curly quotes, long dashes and ellipsis", () => {
    expect(toGsm7("It’s “ready” — see you…")).toBe('It\'s "ready" - see you...');
    expect(toGsm7("9–10am")).toBe("9-10am");
  });

  it("strips emoji and joiners", () => {
    expect(toGsm7("Tour booked 😊 see you 🏠️")).toBe("Tour booked see you");
    expect(toGsm7("👨‍👩‍👧 hi")).toBe("hi");
  });

  it("folds accents outside GSM and keeps ones inside", () => {
    expect(toGsm7("café è í")).toBe("café è i");
  });

  it("passes plain text through unchanged and is idempotent", () => {
    const text = "Your tour is Sat 10am at 5259 Brooklyn. Reply YES to confirm.";
    expect(toGsm7(text)).toBe(text);
    const once = toGsm7("a — b “q” 😀");
    expect(toGsm7(once)).toBe(once);
  });

  it("turns a UCS-2 reply into a single GSM-7 segment", () => {
    const raw = "Your tour is booked 😊 — see you at 10am at 5259 Brooklyn “door code 1234”. Reply YES to confirm.";
    expect(smsSegmentCount(raw)).toBeGreaterThan(1);
    const clean = toGsm7(raw);
    expect(isGsm7(clean)).toBe(true);
    expect(smsSegmentCount(clean)).toBe(1);
  });

  it("counts segments", () => {
    expect(smsSegmentCount("")).toBe(0);
    expect(smsSegmentCount("a".repeat(160))).toBe(1);
    expect(smsSegmentCount("a".repeat(161))).toBe(2);
  });
});
