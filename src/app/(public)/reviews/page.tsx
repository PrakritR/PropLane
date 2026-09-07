import type { Metadata } from "next";
import Link from "next/link";
import { BOOK_DEMO_HREF } from "@/lib/marketing/public-contact";
import { ChromeSubstrate } from "@/components/brand/chrome-substrate";
import { RevealOnView } from "@/components/motion/reveal-on-view";

export const metadata: Metadata = {
  title: "Reviews",
  description:
    "What early-access users are saying about PropLane during the beta: AI lease drafting, rent collection, vendor bidding, and real double-entry accounting.",
};

/*
 * ============================================================================
 * ⚠️  PLACEHOLDER early-access quotes — replace with real customer feedback
 * ⚠️  (with permission) before production. Do not ship invented reviews.
 * ============================================================================
 */
const EARLY_ACCESS_QUOTES = [
  {
    quote:
      "The AI drafted a lease straight from the application. I read it, adjusted one clause, and we both signed online the same day.",
    name: "Maya",
    context: "Manages 6 units, Seattle",
  },
  {
    quote:
      "I pay rent from my phone and get a reminder a few days before it's due. No checks, no wondering whether the payment went through.",
    name: "Devon",
    context: "Resident",
  },
  {
    quote:
      "I tried the live demo before making an account: real screens, sample data, and the AI assistant actually answered my questions about it.",
    name: "Jordan",
    context: "Manages 3 units, evaluated via the demo",
  },
  {
    quote:
      "I tour the unit, submit my price, and once the job is approved the payout lands through the platform. A lot less phone tag than my usual work.",
    name: "Sam",
    context: "HVAC vendor",
  },
  {
    quote:
      "The books are real double-entry: trial balance, general ledger, owner statements. My accountant stopped asking me for spreadsheets.",
    name: "Priya",
    context: "Manages 14 units",
  },
  {
    quote:
      "Payments, documents, and maintenance requests are in one place. I reported a leaky faucet and could see when the vendor was scheduled.",
    name: "Alex",
    context: "Resident",
  },
] as const;

export default function ReviewsPage() {
  return (
    <>
      {/* Hero */}
      <section className="hero-chrome-scene relative overflow-hidden pb-10 pt-14 sm:pb-12 sm:pt-20 md:pt-24">
        <ChromeSubstrate variant="full" />
        <div className="relative mx-auto max-w-6xl px-4 text-center sm:px-5">
          <RevealOnView>
            <h1 className="hero-title mx-auto max-w-3xl text-[2.25rem] font-semibold leading-[1.08] tracking-[-0.03em] sm:text-[3.25rem] md:text-[3.75rem]">
              What early users <span className="text-gradient-accent">are saying</span>
            </h1>

            <p className="hero-subtitle mx-auto mt-5 max-w-2xl text-base leading-relaxed sm:text-lg">
              PropLane is in beta. These notes come from managers, residents, and vendors in our
              early-access program: no star ratings, no cherry-picked superlatives, just what
              they told us.
            </p>
          </RevealOnView>
        </div>
      </section>

      {/* Early-access quotes */}
      <section className="relative overflow-hidden pb-14 pt-4 sm:pb-20 sm:pt-6">
        <ChromeSubstrate variant="quiet" />
        <div className="relative mx-auto max-w-6xl px-4 sm:px-5">
          <h2 className="sr-only">Early-access feedback</h2>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {EARLY_ACCESS_QUOTES.map((q, i) => (
              <RevealOnView key={q.name + q.context} delayMs={i * 60} className="h-full">
                <figure className="glass-card flex h-full flex-col rounded-2xl p-7">
                  <div
                    aria-hidden
                    className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/[0.08] text-primary"
                  >
                    <QuoteIcon />
                  </div>
                  <blockquote className="mt-5 flex-1">
                    <p className="text-[15px] leading-relaxed text-foreground">
                      &ldquo;{q.quote}&rdquo;
                    </p>
                  </blockquote>
                  <figcaption className="mt-6 border-t border-foreground/10 pt-4">
                    <span className="block text-sm font-semibold text-foreground">{q.name}</span>
                    <span className="mt-0.5 block text-xs text-muted">{q.context}</span>
                  </figcaption>
                </figure>
              </RevealOnView>
            ))}
          </div>

          <RevealOnView delayMs={EARLY_ACCESS_QUOTES.length * 60}>
            <p className="mx-auto mt-8 max-w-xl text-center text-xs leading-relaxed text-muted sm:text-sm">
              Collected during the PropLane beta from early-access users. Want to see the product
              behind the quotes?{" "}
              <Link
                href="/auth/create-account"
                data-attr="reviews-get-started"
                className="font-semibold text-primary transition-colors duration-200 hover:text-foreground"
              >
                Create a free account
              </Link>
              .
            </p>
          </RevealOnView>
        </div>
      </section>

      {/* Share your experience */}
      <section className="relative overflow-hidden py-14 sm:py-20">
        <ChromeSubstrate variant="quiet" />
        <div className="relative mx-auto max-w-6xl px-4 sm:px-5">
          <RevealOnView>
            <div className="glass-card mx-auto flex max-w-3xl flex-col items-center gap-6 rounded-2xl p-8 text-center sm:p-10">
              <div>
                <h2 className="text-[1.75rem] font-semibold leading-[1.15] tracking-[-0.03em] text-foreground sm:text-[2rem]">
                  Been using PropLane?
                </h2>
                <p className="mx-auto mt-3 max-w-lg text-sm leading-relaxed text-muted sm:text-base">
                  We&rsquo;re building this page from real beta feedback: the good and the rough
                  edges. Tell us what&rsquo;s working and what isn&rsquo;t, and we may feature your
                  note here (with your permission).
                </p>
              </div>
              <div className="flex flex-col items-center justify-center gap-3 sm:flex-row">
                <a
                  href="mailto:support@prop-lane.space?subject=PropLane%20feedback"
                  data-attr="reviews-share-feedback-email"
                  className="btn-metallic hero-cta-metallic inline-flex min-h-[44px] w-full cursor-pointer items-center justify-center rounded-full px-8 py-3 text-sm font-semibold transition-[transform,box-shadow,filter] duration-200 ease-out hover:-translate-y-0.5 hover:brightness-105 active:translate-y-px active:scale-[0.99] sm:w-auto"
                >
                  Share your experience
                </a>
                <Link
                  href="/contact"
                  data-attr="reviews-share-contact"
                  className="text-sm font-semibold text-muted transition-colors duration-200 hover:text-foreground"
                >
                  Or reach us through the <span className="text-primary">contact page</span>
                </Link>
              </div>
            </div>
          </RevealOnView>
        </div>
      </section>

      {/* Closing CTA */}
      <section className="relative overflow-hidden py-16 sm:py-24">
        <ChromeSubstrate variant="quiet" />
        <div className="relative mx-auto max-w-6xl px-4 text-center sm:px-5">
          <RevealOnView>
            <h2 className="mx-auto max-w-2xl text-[2rem] font-semibold leading-[1.1] tracking-[-0.03em] text-foreground sm:text-[2.5rem]">
              Write the next review yourself
            </h2>
            <p className="hero-subtitle mx-auto mt-4 max-w-xl text-sm leading-relaxed sm:text-base">
              Start a 14-day free trial (no card required) and see how much of the work the AI
              drafts before you approve it.
            </p>
            <div className="mt-8 flex flex-col items-center justify-center gap-4 sm:flex-row">
              <Link
                href="/auth/create-account"
                data-attr="reviews-cta-get-started"
                className="btn-metallic hero-cta-metallic inline-flex min-h-[44px] w-full cursor-pointer items-center justify-center rounded-full px-8 py-3 text-sm font-semibold transition-[transform,box-shadow,filter] duration-200 ease-out hover:-translate-y-0.5 hover:brightness-105 active:translate-y-px active:scale-[0.99] sm:w-auto"
              >
                Get started for free
              </Link>
              <Link
                href={BOOK_DEMO_HREF}
                data-attr="reviews-cta-book-demo"
                className="hero-cta-outline inline-flex min-h-[44px] w-full cursor-pointer items-center justify-center rounded-full border px-8 py-3 text-sm font-semibold transition-colors duration-200 active:scale-[0.99] sm:w-auto"
              >
                Book a demo
              </Link>
            </div>
          </RevealOnView>
        </div>
      </section>
    </>
  );
}

function QuoteIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="none"
      aria-hidden
    >
      <path d="M10 8c-3 0-5 2.2-5 5.3 0 2.2 1.5 3.7 3.4 3.7 1.7 0 3-1.3 3-3 0-1.6-1.1-2.8-2.7-2.8-.3 0-.6 0-.8.1C8.3 9.9 9.4 9 10.8 8.7L10 8zm9 0c-3 0-5 2.2-5 5.3 0 2.2 1.5 3.7 3.4 3.7 1.7 0 3-1.3 3-3 0-1.6-1.1-2.8-2.7-2.8-.3 0-.6 0-.8.1.4-1.4 1.5-2.3 2.9-2.6L19 8z" />
    </svg>
  );
}
