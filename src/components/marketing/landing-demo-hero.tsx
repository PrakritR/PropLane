import Link from "next/link";
import { ApplicationsPipelinePanel } from "@/components/marketing/landing-applications-pipeline";
import { BOOK_DEMO_HREF, GET_STARTED_HREF } from "@/lib/marketing/public-contact";

const GET_STARTED = GET_STARTED_HREF;

const TRUST = ["14-day Pro trial", "Approval-first AI", "Free plan, $0"] as const;

const STATS = [
  { value: "10", label: "properties" },
  { value: "30", label: "residents" },
  { value: "2", label: "managers" },
] as const;

/**
 * Theme-aware split hero + sparse portfolio stats. Dark keeps near-black; light is soft white.
 *
 * Vertical rhythm invariant: the hero AND the stats strip must fit one ~900px
 * desktop viewport so the portfolio numbers are visible without scrolling. The
 * `lg:` padding here (`lg:pt-12 lg:pb-14` on the grid, `lg:py-9` on the stats
 * strip) — plus the 32px `.landing-hero-bridge` at ≥1024px in `globals.css` — is
 * deliberately tighter than the standard marketing rhythm (docs/design.md,
 * "Layout & spacing") for exactly that reason. Hero height is driven by the left
 * text column, not `ApplicationsPipelinePanel`, so trim padding rather than type
 * or the demo card if this needs to shrink further. Sub-`lg` spacing is left at
 * the fuller mobile rhythm on purpose — mobile stacks and scrolls normally.
 */
export function LandingDemoHero() {
  return (
    <>
      <section className="landing-dark-hero relative overflow-x-hidden">
        {/* Architectural grid + bloom: a masked 1px lattice, one brand bloom
            behind the panel, a few softly-lit cells, and a legibility wash.
            All strictly behind the content grid below. */}
        <div
          aria-hidden
          className="landing-hero-glow pointer-events-none absolute inset-0 overflow-hidden"
        >
          <div className="landing-hero-grid" />
          <div className="landing-hero-bloom" />
          <div className="landing-hero-cells" />
          <div className="landing-hero-wash" />
        </div>

        <div className="relative mx-auto grid w-full max-w-[1120px] items-center gap-12 px-5 pb-16 pt-14 sm:px-6 sm:pb-20 sm:pt-16 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)] lg:gap-14 lg:pb-14 lg:pt-12">
          <div className="min-w-0 max-w-[34rem]">
            <h1 className="text-[clamp(2.35rem,5.2vw,3.65rem)] font-semibold leading-[1.05] tracking-[-0.035em]">
              <span className="landing-hero-line block">The AI does</span>
              <span className="landing-hero-line block">the busywork.</span>
              <span className="landing-hero-line landing-hero-line--muted block">You approve.</span>
            </h1>

            <p className="landing-hero-sub mt-5 max-w-[40ch] text-[15.5px] leading-relaxed sm:text-[16px]">
              One platform for managers, residents, and vendors. It drafts leases from applications,
              collects rent, chases late fees, and pays vendors, then hands you a single queue to
              approve. Real double-entry books underneath.
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link
                href={GET_STARTED}
                data-attr="home-hero-get-started"
                className="landing-hero-cta-primary inline-flex min-h-[46px] items-center justify-center rounded-[10px] px-[22px] text-[14.5px] font-medium transition hover:brightness-110"
              >
                Get started for free
              </Link>
              <Link
                href={BOOK_DEMO_HREF}
                data-attr="home-hero-book-demo"
                className="landing-hero-cta-ghost inline-flex min-h-[46px] items-center justify-center rounded-[10px] px-[20px] text-[14.5px] font-medium transition"
              >
                Book a demo
              </Link>
            </div>

            <ul className="landing-hero-trust mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px]">
              {TRUST.map((item) => (
                <li key={item} className="inline-flex items-center gap-1.5">
                  <CheckIcon />
                  {item}
                </li>
              ))}
            </ul>
          </div>

          <div className="mx-auto w-full max-w-[524px] min-w-0 lg:ml-auto lg:mr-0">
            <ApplicationsPipelinePanel />
          </div>
        </div>
      </section>

      <div aria-hidden className="landing-hero-bridge" />

      <section className="landing-stats-strip relative border-b py-12 sm:py-14 lg:py-9">
        <div className="mx-auto flex w-full max-w-[720px] items-start justify-between gap-6 px-5 sm:px-6">
          {STATS.map((stat) => (
            <div key={stat.label} className="min-w-0 flex-1 text-center">
              <div className="landing-stat-value text-[clamp(2rem,4.5vw,2.75rem)] font-semibold tabular-nums leading-none tracking-[-0.04em]">
                {stat.value}
              </div>
              <div className="landing-stat-label mt-2 text-[13px] font-medium tracking-[-0.01em]">
                {stat.label}
              </div>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

function CheckIcon() {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className="landing-hero-check size-3.5 shrink-0" fill="none">
      <path
        d="M3.5 8.25 6.4 11.2 12.5 4.8"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
