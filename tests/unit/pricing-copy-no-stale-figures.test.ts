/**
 * Marketing/pricing copy must read `RATE_CARD` (`formatRateCardUsd`,
 * `annualDiscountPercent`), never retype a dollar figure or a discount
 * percent — the exact drift class PLAN-DOOR step 2 fixed: these files held
 * `$20`/`$200`/`instead of $240`/`instead of $2,400`/`20% off`, all pinned to
 * the price table BEFORE the rate card existed.
 *
 * Grep-style guard, same shape as `services-vocabulary.test.ts`: it never
 * inspects a computed VALUE, only that these specific stale literals never
 * come back into the files that once held them.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FILES = [
  join("src", "app", "(public)", "pricing", "page.tsx"),
  join("src", "components", "marketing", "site", "home-faq-items.tsx"),
  join("src", "components", "marketing", "landing-home-sections.tsx"),
  join("src", "components", "marketing", "site", "pricing-teaser.tsx"),
  join("src", "components", "auth", "manager-plan-tier-cards.tsx"),
  join("src", "components", "marketing", "manager-start-page.tsx"),
];

const BANNED_PHRASES = [
  "$20/mo",
  "$20 a month",
  "$20 for two",
  "$200/mo",
  "$200 a month",
  "$200 for twenty",
  "instead of $240",
  "instead of $2,400",
  "instead of $2400",
  "20% off",
];

describe("pricing/marketing copy never repeats a stale rate-card figure", () => {
  it.each(FILES)("%s has no hardcoded old price or discount", (relPath) => {
    const text = readFileSync(relPath, "utf8");
    for (const phrase of BANNED_PHRASES) {
      expect(text, `${relPath} contains stale copy "${phrase}"`).not.toContain(phrase);
    }
  });
});
