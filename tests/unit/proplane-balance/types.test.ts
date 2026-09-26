import { describe, expect, it } from "vitest";
import {
  isReversedSentinel,
  parseInsufficientBalanceError,
  shortfallCents,
  withdrawalReversedSentinel,
} from "@/lib/proplane-balance/types";

describe("proplane-balance/types", () => {
  it("parses the INSUFFICIENT_BALANCE raise message", () => {
    const parsed = parseInsufficientBalanceError("INSUFFICIENT_BALANCE: available=500 requested=1200");
    expect(parsed).toEqual({ availableCents: 500, requestedCents: 1200, shortfallCents: 700 });
  });

  it("parses even when Postgres wraps the message with extra context", () => {
    const parsed = parseInsufficientBalanceError(
      'error: INSUFFICIENT_BALANCE: available=0 requested=100\nCONTEXT:  PL/pgSQL function proplane_balance_move(uuid,uuid,bigint,text,text,text) line 30 at RAISE',
    );
    expect(parsed).toEqual({ availableCents: 0, requestedCents: 100, shortfallCents: 100 });
  });

  it("returns null for an unrelated error message", () => {
    expect(parseInsufficientBalanceError("duplicate key value violates unique constraint")).toBeNull();
  });

  it("shortfallCents never goes negative", () => {
    expect(shortfallCents(1000, 400)).toBe(0);
    expect(shortfallCents(400, 1000)).toBe(600);
  });

  it("withdrawalReversedSentinel round-trips through isReversedSentinel", () => {
    const sentinel = withdrawalReversedSentinel("2026-09-25T00:00:00.000Z");
    expect(sentinel).toBe("reversed:2026-09-25T00:00:00.000Z");
    expect(isReversedSentinel(sentinel)).toBe(true);
    expect(isReversedSentinel("tr_1abc")).toBe(false);
    expect(isReversedSentinel(null)).toBe(false);
    expect(isReversedSentinel(undefined)).toBe(false);
  });
});
