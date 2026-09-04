import { describe, expect, it } from "vitest";

import { orFilterForIdentity, parseOrFilterClauses, postgrestFilterValue } from "@/lib/supabase/or-filter";

/**
 * `or()` takes a STRING: `,` separates clauses and `()` groups them. Building a
 * resident scope filter by interpolation makes the identity query syntax rather
 * than data, and that filter IS the boundary between two residents of the same
 * manager (PRP-255).
 */
describe("orFilterForIdentity", () => {
  it("quotes a value so a comma cannot end the clause", () => {
    const filter = orFilterForIdentity([
      ["resident_user_id", "u1"],
      ["resident_email", '"odd,name"@example.com'],
    ]);
    expect(filter).toBe(
      'resident_user_id.eq."u1",resident_email.eq."\\"odd,name\\"@example.com"',
    );
    // The injected comma is inside the quotes, so there are still two clauses.
    expect(filter!.split('",').length).toBe(2);
  });

  it("quotes parentheses, which group clauses", () => {
    expect(postgrestFilterValue("a(b)c")).toBe('"a(b)c"');
  });

  it("escapes a quote and a backslash so the quoting cannot be closed early", () => {
    expect(postgrestFilterValue('a"b')).toBe('"a\\"b"');
    expect(postgrestFilterValue("a\\b")).toBe('"a\\\\b"');
  });

  it("fails CLOSED when no identity is present", () => {
    // The old form produced `resident_user_id.eq.,resident_email.eq.` — not
    // "match nothing", just malformed.
    expect(orFilterForIdentity([["resident_user_id", ""], ["resident_email", null]])).toBeNull();
    expect(orFilterForIdentity([["resident_user_id", undefined], ["resident_email", "   "]])).toBeNull();
  });

  it("drops the empty half rather than emitting an empty clause", () => {
    expect(orFilterForIdentity([["resident_user_id", "u1"], ["resident_email", ""]])).toBe(
      'resident_user_id.eq."u1"',
    );
  });
});

describe("parseOrFilterClauses", () => {
  it("round-trips a value containing every separator character", () => {
    const email = '"a,b(c)d\\"e"@example.com';
    const filter = orFilterForIdentity([["resident_email", email]])!;
    expect(parseOrFilterClauses(filter)).toEqual([
      { column: "resident_email", operator: "eq", value: email },
    ]);
  });

  it("keeps clauses separate without splitting inside a quoted value", () => {
    const filter = orFilterForIdentity([
      ["resident_user_id", "u1"],
      ["resident_email", "a,b@example.com"],
    ])!;
    const parsed = parseOrFilterClauses(filter);
    expect(parsed).toHaveLength(2);
    expect(parsed[1]!.value).toBe("a,b@example.com");
  });

  it("still reads an unquoted legacy clause", () => {
    expect(parseOrFilterClauses("resident_user_id.eq.u1")).toEqual([
      { column: "resident_user_id", operator: "eq", value: "u1" },
    ]);
  });
});
