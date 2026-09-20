/**
 * PLAN-0920-0853 (Payouts, redesigned — resident slice): a resident never
 * leaves PropLane to pay. This is the source-level guard: none of the
 * resident-facing payment surfaces may mint or hand out a hosted Stripe
 * Checkout session URL, an Account Link, or a Stripe Express login link —
 * every payment and every payout happens inside PropLane's own chrome.
 *
 * The banned strings are the literal SDK/URL shapes that would mean an exit:
 *   - "checkout.stripe.com"  — a hosted Checkout Session URL
 *   - "connect.stripe.com"   — a hosted Connect onboarding/dashboard URL
 *   - "accountLinks.create"  — mints an Account Link (hosted onboarding)
 *   - "createLoginLink"      — mints a Stripe Express dashboard login link
 *
 * `src/app/api/stripe/connect/onboard/route.ts` and
 * `src/app/api/vendor/stripe-connect/onboard/route.ts` still mint Account
 * Links and login links today — a LATER slice of PLAN-0920-0853 (the Set up
 * payouts card, Stripe's embedded onboarding component) replaces that. This
 * resident slice only touches the three resident-facing files below,
 * so those two routes are recorded as `it.todo` rather than asserted here —
 * the integrator turns them into real assertions once that slice lands.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const BANNED = ["checkout.stripe.com", "connect.stripe.com", "accountLinks.create", "createLoginLink"];

function offendingLines(relativePath: string): string[] {
  const contents = readFileSync(join(process.cwd(), relativePath), "utf8");
  const offenders: string[] = [];
  contents.split("\n").forEach((line, index) => {
    for (const banned of BANNED) {
      if (line.includes(banned)) {
        offenders.push(`${relativePath}:${index + 1} contains "${banned}": ${line.trim().slice(0, 140)}`);
      }
    }
  });
  return offenders;
}

const RESIDENT_SLICE_FILES = [
  join("src", "lib", "payment-reminder-delivery.ts"),
  join("src", "lib", "tools", "domains", "resident", "payments.ts"),
  join("src", "components", "portal", "resident-payments-panel.tsx"),
];

describe("in-app payment exits — resident slice never leaves PropLane", () => {
  it.each(RESIDENT_SLICE_FILES)("%s never mints or links a hosted Stripe URL", (relativePath) => {
    expect(offendingLines(relativePath)).toEqual([]);
  });

  // Covered by a LATER slice of PLAN-0920-0853 (Set up payouts card, Stripe's
  // embedded onboarding/account-management components replacing Account
  // Links and login links). Left as `it.todo` — not skipped silently, but
  // recorded — so the integrator flips these on once that edit lands, rather
  // than this guard staying green while the onboard routes still exit.
  it.todo(
    "src/app/api/stripe/connect/onboard/route.ts never mints or links a hosted Stripe URL (PLAN-0920-0853, later slice)",
  );
  it.todo(
    "src/app/api/vendor/stripe-connect/onboard/route.ts never mints or links a hosted Stripe URL (PLAN-0920-0853, later slice)",
  );
});
