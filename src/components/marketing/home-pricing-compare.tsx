import Link from "next/link";
import { MANAGER_PLAN_TIERS } from "@/data/manager-plan-tiers";
import type { CompareCell } from "@/components/marketing/site/pricing-compare-data";
import {
  HOME_COMPARE_ROWS,
  HOME_PLAN_COLUMNS,
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
        <span aria-hidden="true">–</span>
        <span className="sr-only">Not included</span>
      </>
    );
  return <span className="home-compare-value">{value}</span>;
}

/** Apple-style plan comparison: plan, price and action on top, then the same rows in the same order for every plan. */
export function HomePricingCompare() {
  return (
    <div className="home-compare" role="table" aria-label="Compare plans" data-attr="pricing-plan-stack">
      <div className="home-compare-head" role="row">
        <div role="columnheader" className="home-compare-corner" aria-label="Feature" />
        {HOME_PLAN_COLUMNS.map((plan) => (
          <div key={plan.id} role="columnheader" className="home-compare-plan" data-plan={plan.id} data-attr={`pricing-plan-${plan.id}`}>
            <h3>{plan.name}</h3>
            <p className="home-compare-price">
              <strong>{plan.price}</strong>
              {plan.period ? <span>{plan.period}</span> : null}
            </p>
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
              <div key={HOME_PLAN_COLUMNS[index].id} role="cell" data-plan={HOME_PLAN_COLUMNS[index].id} data-plan-name={HOME_PLAN_COLUMNS[index].name}>
                <Cell value={value} />
              </div>
            ))}
          </div>
        ))}
      </div>
      <p className="home-compare-note">{MANAGER_PLAN_TIERS[0].features[8].text}.</p>
    </div>
  );
}
