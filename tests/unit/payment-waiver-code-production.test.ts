/**
 * The free-tier bypass code, and why production must not have a built-in one.
 *
 * A waiver code grants lifetime paid-tier access with no Stripe checkout. The built-in value is a
 * fixed string in a public repo, and the comparison ignores case and punctuation — so a built-in
 * that is live in production means anyone typing "free100", "Free 100", or "free-100" is handed a
 * paid plan for nothing, with no signal that it happened.
 *
 * That shipped, and the gate caught it. These tests pin the fail-closed shape so it cannot come
 * back: production grants a waiver ONLY when one is configured explicitly.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";

const ORIGINAL = { ...process.env };

async function load() {
  // The module reads env at call time, but re-importing keeps each case independent.
  const mod = await import("@/lib/server-env");
  return mod;
}

beforeEach(() => {
  delete process.env.AXIS_PAYMENT_WAIVER_CODE;
  delete process.env.VERCEL_ENV;
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe("in production", () => {
  beforeEach(() => {
    process.env.VERCEL_ENV = "production";
  });

  it("offers no waiver when none is configured", async () => {
    const { getPaymentWaiverCode } = await load();
    expect(getPaymentWaiverCode()).toBeNull();
  });

  it("refuses the built-in code, in every spelling the comparison allows", async () => {
    // This is the actual attack: the code is public, and the match is case- and
    // punctuation-insensitive.
    const { paymentWaiverCodeMatches } = await load();
    for (const attempt of ["FREE100", "free100", "Free 100", "free-100", " free100 "]) {
      expect(paymentWaiverCodeMatches(attempt)).toBe(false);
    }
  });

  it("honours a code that was configured deliberately", async () => {
    // Comping an account stays possible — it just has to be an explicit act.
    process.env.AXIS_PAYMENT_WAIVER_CODE = "PARTNER2026";
    const { getPaymentWaiverCode, paymentWaiverCodeMatches } = await load();
    expect(getPaymentWaiverCode()).toBe("PARTNER2026");
    expect(paymentWaiverCodeMatches("partner2026")).toBe(true);
    // And the built-in is still not a second, unconfigured way in.
    expect(paymentWaiverCodeMatches("free100")).toBe(false);
  });
});

describe("outside production", () => {
  it("keeps the built-in code, so local work is not blocked", async () => {
    const { getPaymentWaiverCode, paymentWaiverCodeMatches } = await load();
    expect(getPaymentWaiverCode()).toBe("FREE100");
    expect(paymentWaiverCodeMatches("free100")).toBe(true);
  });

  it("still lets an explicit code override the built-in", async () => {
    process.env.AXIS_PAYMENT_WAIVER_CODE = "STAGING1";
    const { getPaymentWaiverCode } = await load();
    expect(getPaymentWaiverCode()).toBe("STAGING1");
  });
});

describe("empty input", () => {
  it("never matches, in any environment", async () => {
    // An empty promo field must not collide with an unset waiver.
    const { paymentWaiverCodeMatches } = await load();
    for (const empty of ["", "   ", "!!!"]) {
      expect(paymentWaiverCodeMatches(empty)).toBe(false);
    }
  });
});
