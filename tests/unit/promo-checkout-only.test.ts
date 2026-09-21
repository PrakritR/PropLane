/**
 * A promo / waiver code is entered on checkout (and signup), never on the
 * Billing & plan page body — see docs/agents/comms-billing.md's "Billing &
 * plan and saved cards". This pins the current, already-correct shape:
 * `pro-plan.tsx` renders exactly one promo field, nested inside the checkout
 * modal (`planModal?.kind === "checkout"`), and the server route it posts to
 * only ever honors that code for the account it belongs to — a request that
 * is not part of a checkout still resolves through the same validated gate,
 * never a second, unguarded acceptance path.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("promo / waiver code lives on checkout only", () => {
  const planSrc = readFileSync(join(process.cwd(), "src/components/portal/pro-plan.tsx"), "utf8");

  it("Billing & plan renders exactly one promo field, and it is inside the checkout modal", () => {
    const promoFieldOccurrences = planSrc.split('data-attr="plan-promo-code-input"').length - 1;
    expect(promoFieldOccurrences).toBe(1);

    const checkoutBlockStart = planSrc.indexOf('planModal?.kind === "checkout"');
    const promoFieldIdx = planSrc.indexOf('data-attr="plan-promo-code-input"');
    expect(checkoutBlockStart).toBeGreaterThan(-1);
    expect(promoFieldIdx).toBeGreaterThan(checkoutBlockStart);

    // The field only submits through the checkout flow's own guard.
    expect(planSrc).toContain('if (!planModal || planModal.kind !== "checkout" || promoBusy) return;');
  });

  it("no other billing-adjacent settings panel renders the plan promo/waiver input", () => {
    const messagingSrc = readFileSync(
      join(process.cwd(), "src/components/portal/pro-messaging-settings-panel.tsx"),
      "utf8",
    );
    const commsCreditSrc = readFileSync(
      join(process.cwd(), "src/components/portal/manager-usage-panel.tsx"),
      "utf8",
    );
    // Neither panel renders the actual promo/waiver code field — only
    // pro-plan.tsx's checkout modal does. A bare mention (e.g. explaining
    // trial vs. waiver eligibility in a comment) is fine; a second rendered
    // code field is not.
    expect(messagingSrc).not.toContain('data-attr="plan-promo-code-input"');
    expect(commsCreditSrc).not.toContain('data-attr="plan-promo-code-input"');
    expect(messagingSrc).not.toContain("Have a promo code?");
    expect(commsCreditSrc).not.toContain("Have a promo code?");
  });

  it("the update-tier route rejects an invalid promo and never applies a promo to a Stripe-managed subscription", async () => {
    const routeSrc = readFileSync(
      join(process.cwd(), "src/app/api/stripe/subscription/update-tier/route.ts"),
      "utf8",
    );
    expect(routeSrc).toContain('paymentWaiverCodeMatches(promo)');
    expect(routeSrc).toContain('"That promo code isn\'t valid."');
    // A Stripe-managed subscription must go through real billing, not a waiver shortcut.
    expect(routeSrc).toContain("promo codes can't be applied here");
  });
});
