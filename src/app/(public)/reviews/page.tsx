import type { Metadata } from "next";
import Link from "next/link";
import { BOOK_DEMO_HREF, PUBLIC_SUPPORT_EMAIL } from "@/lib/marketing/public-contact";
import { SiteFinalCta } from "@/components/marketing/site/final-cta";
import { SITE_MEASURE, SiteEyebrow, SiteHeading, SiteSection } from "@/components/marketing/site/primitives";

export const metadata: Metadata = {
  title: "Reviews",
  description:
    "PropLane is in early access. Reviews from managers, residents and vendors land here as they come in — with their permission, never invented.",
};

/*
 * No invented reviews. This page used to carry placeholder quotes marked "do
 * not ship"; the site now shows only what is true. Real quotes get a tile here
 * the day they exist, with the person's permission and their role.
 */
const TRUE_CLAIMS = [
  {
    value: "100%",
    label: "of outbound messages, charges and leases wait for a manager's OK. Zero sent on their own.",
    note: "True by construction.",
  },
  {
    value: "$0",
    label: "to start, with no card: one listing, applications, tours and rent collection.",
    note: "The Free plan.",
  },
  {
    value: "3",
    label: "sign-ins — manager, resident, vendor — on one home, with the same queue on web and iPhone.",
    note: "The product's shape.",
  },
] as const;

export default function ReviewsPage() {
  return (
    <div className="relative min-h-0 flex-1">
      <section className="border-b border-border/70 pb-14 pt-14 sm:pt-16 lg:pb-20 lg:pt-20" aria-labelledby="reviews-title">
        <div className={`${SITE_MEASURE} max-w-[860px]`}>
          <SiteEyebrow className="mb-4">Reviews</SiteEyebrow>
          <SiteHeading as="h1" id="reviews-title">
            Early access.
            <br />
            <span className="text-primary">Real words only.</span>
          </SiteHeading>
          <p className="mt-5 max-w-[52ch] text-[16.5px] leading-relaxed text-muted sm:text-[17.5px]">
            PropLane is in early access. Reviews from managers, residents and vendors land here as they come in — with
            their permission, in their words. Until then, here is what we can promise.
          </p>
        </div>
      </section>

      <SiteSection ariaLabel="What we can promise">
        <div className="grid gap-4 md:grid-cols-3">
          {TRUE_CLAIMS.map((c) => (
            <div key={c.value} className="rounded-2xl border border-border bg-card p-7">
              <p className="text-[56px] font-bold leading-none tracking-[-0.04em] text-primary">{c.value}</p>
              <p className="mt-4 text-[15.5px] font-semibold leading-snug text-foreground">{c.label}</p>
              <p className="mt-2 text-[13px] text-muted">{c.note}</p>
            </div>
          ))}
        </div>
        <div className="mt-6 rounded-2xl border border-dashed border-border bg-[var(--pl-surface-muted)] p-7 text-center [html[data-theme=dark]_&]:bg-white/[0.03]">
          <p className="text-[17px] font-bold tracking-tight text-foreground">Using PropLane? Tell us how it went.</p>
          <p className="mx-auto mt-2 max-w-[52ch] text-[14.5px] leading-relaxed text-muted">
            A sentence is enough. We publish it here with your first name and role, only once you say so.
          </p>
          <a
            href={`mailto:${PUBLIC_SUPPORT_EMAIL}?subject=PropLane%20feedback`}
            data-attr="reviews-submit"
            className="mt-5 inline-flex items-center gap-1.5 text-[15px] font-bold text-primary hover:underline"
          >
            Send a review <span aria-hidden>→</span>
          </a>
        </div>
      </SiteSection>

      <SiteFinalCta
        title="See it before you believe it."
        lede={
          <>
            Twenty minutes, your homes on screen, no deck. Or{" "}
            <Link href="/pricing" className="font-semibold text-primary hover:underline">
              start free
            </Link>{" "}
            and judge it on your own listing.
          </>
        }
        primaryAttr="reviews-closing-book-demo"
        primaryLabel="Book a demo"
        primaryHref={BOOK_DEMO_HREF}
        secondaryAttr="reviews-closing-start-free"
        secondaryLabel="Start free"
        secondaryHref="/auth/create-account"
      />
    </div>
  );
}
