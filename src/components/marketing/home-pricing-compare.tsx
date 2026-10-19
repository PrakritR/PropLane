import Link from "next/link";
import { MANAGER_PLAN_TIERS } from "@/data/manager-plan-tiers";
import type { CompareCell } from "@/components/marketing/site/pricing-compare-data";
import { HomeSectionHeader } from "./home-section-header";
import {
  ANNUAL_MONTHS_FREE,
  HOME_COMPARE_ROWS,
  HOME_PLAN_COLUMNS,
  type HomePlanColumn,
  type HomePlanPrice,
} from "./home-pricing-compare-data";

function Cell({ value }: { value: CompareCell }) {
  if (value === true)
    return (
      <>
        <svg className="home-compare-check" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 10.5l3.5 3.5L16 5.5" />
        </svg>
        <span className="sr-only">Included</span>
      </>
    );
  if (value === false)
    return (
      <>
        <span className="home-compare-dash" aria-hidden="true">–</span>
        <span className="sr-only">Not included</span>
      </>
    );
  return <span className="home-compare-value">{value}</span>;
}

function Price({ price }: { price: HomePlanPrice }) {
  return (
    <>
      <strong>{price.price}</strong>
      {price.period ? <span>{price.period}</span> : null}
    </>
  );
}

/** A price that differs by billing period renders both; CSS shows the one the toggle selects. */
function PlanPrice({ plan }: { plan: HomePlanColumn }) {
  const same = plan.monthly.price === plan.annual.price && plan.monthly.sub === plan.annual.sub;
  if (same)
    return (
      <>
        <p className="home-compare-price"><Price price={plan.monthly} /></p>
        <p className="home-compare-sub">{plan.monthly.sub}</p>
      </>
    );
  return (
    <>
      <p className="home-compare-price is-monthly"><Price price={plan.monthly} /></p>
      <p className="home-compare-price is-annual"><Price price={plan.annual} /></p>
      <p className="home-compare-sub is-monthly">{plan.monthly.sub}</p>
      <p className="home-compare-sub is-annual">{plan.annual.sub}</p>
    </>
  );
}

/**
 * Apple-style plan comparison: plan, price and one action on top, then the same rows in the same order for every
 * plan. The Monthly | Annual switch is two radios (no script): annual shows the rate card's yearly floor as a
 * per-month figure, the same source and wording /pricing uses.
 */
export function HomePricingCompare({ titleId }: { titleId?: string }) {
  return (
    <div className="home-compare-wrap">
      <input type="radio" name="home-billing" id="home-billing-monthly" className="home-billing-input" defaultChecked data-attr="pricing-billing-monthly" />
      <input type="radio" name="home-billing" id="home-billing-annual" className="home-billing-input" data-attr="pricing-billing-annual" />
      <div className="home-section-head-row">
        <HomeSectionHeader id={titleId}>Pricing</HomeSectionHeader>
        <div className="home-billing" role="group" aria-label="Billing period">
          <label htmlFor="home-billing-monthly">Monthly</label>
          <label htmlFor="home-billing-annual">
            Annual <small>{ANNUAL_MONTHS_FREE} months free</small>
          </label>
        </div>
      </div>
      <div className="home-compare" role="table" aria-label="Compare plans" data-attr="pricing-plan-stack">
        <div className="home-compare-head" role="row">
          <div role="columnheader" className="home-compare-corner" aria-label="Feature" />
          {HOME_PLAN_COLUMNS.map((plan) => (
            <div key={plan.id} role="columnheader" className="home-compare-plan" data-plan={plan.id} data-attr={`pricing-plan-${plan.id}`}>
              <h3>{plan.name}</h3>
              <PlanPrice plan={plan} />
            </div>
          ))}
        </div>
        <div className="home-compare-actions" role="row">
          <div role="cell" className="home-compare-corner" />
          {HOME_PLAN_COLUMNS.map((plan) => (
            <div key={plan.id} role="cell" data-plan={plan.id}>
              <Link href={plan.cta.href} prefetch={false} className="home-compare-cta" data-attr={`pricing-plan-${plan.id}-cta`}>
                {plan.cta.label}
              </Link>
            </div>
          ))}
        </div>
        <div role="rowgroup">
          {HOME_COMPARE_ROWS.map((row) => (
            <div key={row.label} role="row" className="home-compare-row">
              <div role="rowheader" className="home-compare-label">{row.label}</div>
              {row.cells.map((value, index) => (
                <div key={HOME_PLAN_COLUMNS[index].id} role="cell" data-plan={HOME_PLAN_COLUMNS[index].id}>
                  <Cell value={value} />
                </div>
              ))}
            </div>
          ))}
        </div>
        <p className="home-compare-note">{MANAGER_PLAN_TIERS[0].features[8].text}.</p>
      </div>
    </div>
  );
}
