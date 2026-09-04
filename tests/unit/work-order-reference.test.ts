import { describe, expect, it } from "vitest";

import {
  MAX_WORK_ORDER_REFERENCE_CANDIDATES,
  formatWorkOrderReference,
  resolveWorkOrderReference,
} from "@/lib/work-order-reference";

describe("resolveWorkOrderReference", () => {
  it.each([
    ["WO-1042", ["WO-1042"]],
    ["wo 1042", ["WO-1042"]],
    ["Work order #1042 is leaking again", ["WO-1042"]],
    ["job no. 1042", ["WO-1042"]],
    ["ticket:1042", ["WO-1042"]],
    ["status 12345", ["WO-12345"]],
    ["#1042 plumber finished", ["WO-1042"]],
    ["1042", ["WO-1042"]],
    ["  1042?  ", ["WO-1042"]],
  ])("parses %j", (text, expected) => {
    expect(resolveWorkOrderReference(text)).toEqual(expected);
  });

  it("returns multiple distinct references in message order", () => {
    expect(resolveWorkOrderReference("Compare WO-2048 with #1042, then WO 2048 again")).toEqual([
      "WO-2048",
      "WO-1042",
    ]);
  });

  it.each([
    "",
    "rent is 1042 dollars",
    "call 2065551042",
    "appointment 09/04/2026",
    "confirmation code 1042",
    "WO-0000",
    "WO-12",
    "TWO-1042",
  ])("ignores non-reference text %j", (text) => {
    expect(resolveWorkOrderReference(text)).toEqual([]);
  });

  it("bounds candidate output for hostile or accidental reference floods", () => {
    const text = Array.from({ length: 20 }, (_, index) => `WO-${1000 + index}`).join(" ");
    expect(resolveWorkOrderReference(text)).toHaveLength(MAX_WORK_ORDER_REFERENCE_CANDIDATES);
    expect(resolveWorkOrderReference(text)).toEqual([
      "WO-1000",
      "WO-1001",
      "WO-1002",
      "WO-1003",
      "WO-1004",
    ]);
  });
});

describe("formatWorkOrderReference", () => {
  it("normalizes a valid sequence", () => {
    expect(formatWorkOrderReference(1042)).toBe("WO-1042");
    expect(formatWorkOrderReference("12345678")).toBe("WO-12345678");
  });

  it.each(["", "12", "0000", "123456789", "10O2", -1042])(
    "rejects invalid sequence %j",
    (sequence) => {
      expect(formatWorkOrderReference(sequence)).toBeNull();
    },
  );
});
