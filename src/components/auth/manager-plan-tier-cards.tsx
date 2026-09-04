"use client";

import type { ManagerPlanTierDefinition, PlanTierId } from "@/data/manager-plan-tiers";

/** Excluded feature. A greyed CHECK still reads as "included" at a glance. */
function ExcludedIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M6 6l12 12M18 6 6 18"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M20 6 9 17l-5-5"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ManagerPlanBillingToggle({
  billing,
  onChange,
  disabled,
}: {
  billing: "monthly" | "annual";
  onChange: (billing: "monthly" | "annual") => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex justify-center">
      <div className="inline-flex items-center gap-1 rounded-full border border-border bg-card/40 p-1">
        {(["monthly", "annual"] as const).map((cycle) => (
          <button
            key={cycle}
            type="button"
            onClick={() => onChange(cycle)}
            disabled={disabled}
            className={`flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-semibold capitalize transition sm:px-4 sm:text-sm ${
              billing === cycle ? "btn-cobalt shadow-sm" : "text-muted hover:text-foreground"
            }`}
          >
            {cycle}
            {cycle === "annual" ? (
              <span
                className={`rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase ${
                  billing === "annual"
                    ? "bg-card/20 text-white"
                    : "bg-[var(--status-confirmed-bg)] text-[var(--status-confirmed-fg)]"
                }`}
              >
                20% off
              </span>
            ) : null}
          </button>
        ))}
      </div>
    </div>
  );
}

export function ManagerPlanTierCards({
  tiers,
  billing,
  selectedTierId,
  onSelectTier,
  disabled,
  compact = false,
}: {
  tiers: ManagerPlanTierDefinition[];
  billing: "monthly" | "annual";
  selectedTierId: PlanTierId;
  onSelectTier: (tierId: PlanTierId) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  if (compact) {
    return (
      <div className="grid grid-cols-3 gap-2">
        {tiers.map((tier) => {
          const price = billing === "monthly" ? tier.monthly : tier.annual;
          const isSelected = selectedTierId === tier.id;
          const isPro = tier.id === "pro";

          return (
            <button
              key={tier.id}
              type="button"
              disabled={disabled}
              onClick={() => onSelectTier(tier.id)}
              className={`auth-plan-tier-card rounded-xl border p-2.5 text-center transition ${
                isSelected
                  ? "border-primary/50 bg-primary/[0.06] shadow-[0_0_0_1px_rgba(47,107,255,0.2)]"
                  : "border-border bg-card/50 hover:border-primary/25"
              }`}
              aria-pressed={isSelected}
            >
              <div className="text-[11px] font-bold text-foreground">{tier.label}</div>
              {isPro ? (
                <div className="mt-0.5 text-[8px] font-bold uppercase tracking-wide text-primary">Popular</div>
              ) : (
                <div className="mt-0.5 h-[11px]" aria-hidden />
              )}
              <div className="mt-1 text-base font-black leading-none text-foreground">{price.headline}</div>
              {price.period ? <div className="mt-0.5 text-[9px] font-medium text-muted">{price.period}</div> : null}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    // Three across from `md` up. Stacked, the three plans were taller than the
    // viewport on a desktop browser, so comparing them meant scrolling — the one
    // thing a pricing chooser must not ask for (AXI-128). Both call sites render
    // inside `AuthCard wide` (52rem), which leaves ~16rem per column at md.
    // Still one column on a phone, where side-by-side would be unreadable.
    <div className="grid gap-3 sm:gap-4 md:grid-cols-3">
      {tiers.map((tier) => {
        const price = billing === "monthly" ? tier.monthly : tier.annual;
        const isSelected = selectedTierId === tier.id;
        const isPro = tier.id === "pro";

        return (
          <button
            key={tier.id}
            type="button"
            disabled={disabled}
            onClick={() => onSelectTier(tier.id)}
            className={`auth-plan-tier-card flex h-full w-full flex-col rounded-2xl border p-4 text-left transition sm:rounded-[1.35rem] sm:p-5 ${
              isSelected
                ? "border-primary/50 bg-primary/[0.06] shadow-[0_0_0_1px_rgba(47,107,255,0.2)]"
                : "border-border bg-card/50 hover:border-primary/25"
            }`}
            aria-pressed={isSelected}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-bold text-foreground">{tier.label}</span>
                  {isPro ? (
                    <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-primary">
                      Popular
                    </span>
                  ) : null}
                </div>
                <div className="mt-1 flex flex-wrap items-baseline gap-x-1">
                  <span className="text-2xl font-black tracking-tight text-foreground sm:text-3xl">
                    {price.headline}
                  </span>
                  {price.period ? <span className="text-sm font-medium text-muted">{price.period}</span> : null}
                </div>
                <p className="mt-1.5 text-xs leading-relaxed text-muted sm:text-sm">{price.sub}</p>
              </div>
              <span
                className={`mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${
                  isSelected ? "border-primary bg-primary text-white" : "border-border bg-background"
                }`}
                aria-hidden
              >
                {isSelected ? (
                  <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none">
                    <path
                      d="M20 6 9 17l-5-5"
                      stroke="currentColor"
                      strokeWidth="3"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                ) : null}
              </span>
            </div>

            <ul className="mt-3 space-y-1.5 border-t border-border/60 pt-3 sm:mt-4 sm:space-y-2 sm:pt-4">
              {tier.features.map((feature) => (
                <li key={feature.text} className="flex items-start gap-2 text-xs sm:text-sm">
                  <span
                    className={`mt-0.5 shrink-0 ${feature.included ? "text-primary" : "text-muted/40"}`}
                    aria-hidden
                  >
                    {feature.included ? <CheckIcon /> : <ExcludedIcon />}
                  </span>
                  {/*
                    The card is one <button>, so its accessible NAME is this whole
                    list concatenated. Without a word for the excluded rows a
                    screen reader heard Free as including residents, leases,
                    inbox and priority support — the exact opposite of the card.
                    Visually hidden so sighted users still read the plain label.
                  */}
                  <span className={feature.included ? "text-foreground" : "text-muted/60"}>
                    <span className="sr-only">{feature.included ? "Included: " : "Not included: "}</span>
                    {feature.text}
                  </span>
                </li>
              ))}
            </ul>
          </button>
        );
      })}
    </div>
  );
}
