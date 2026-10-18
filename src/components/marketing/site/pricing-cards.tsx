import Link from "next/link";
import { RATE_CARD, formatRateCardUsd } from "@/lib/billing/rate-card";

/**
 * Captain-authorized integration placeholder (homepage addendum, Oct 18).
 * W14/on/marketing owns this shared PricingCards export and its final design.
 * Replace this file with W14's component at integration; no copied plan logic.
 */
export function PricingCards() {
  return (
    <div className="texting-pricing-grid">
      <article className="texting-pricing-card">
        <span className="texting-eyebrow">SOFTWARE</span>
        <h3>You run it. PropLane helps.</h3>
        <p className="texting-plan-price">
          From {formatRateCardUsd(RATE_CARD.free.floorMonthlyCents)} / month
        </p>
        <Link
          href="/pricing"
          className="texting-primary"
          data-attr="home-software-pricing"
        >
          View software plans
        </Link>
      </article>
      <article className="texting-pricing-card texting-managed-card">
        <span className="texting-eyebrow">MANAGED SERVICE</span>
        <h3>We run your home for you.</h3>
        <p className="texting-plan-price">Custom — based on your home</p>
        <Link
          href="/service"
          className="texting-primary"
          data-attr="home-managed-service-pricing"
        >
          Talk to us
        </Link>
      </article>
    </div>
  );
}
