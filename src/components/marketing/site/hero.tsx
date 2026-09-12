import Image from "next/image";
import Link from "next/link";
import { AppStoreBadge } from "@/components/marketing/app-store-badge";
import { SITE_MEASURE } from "@/components/marketing/site/primitives";
import { BOOK_DEMO_HREF, GET_STARTED_HREF } from "@/lib/marketing/public-contact";
import { cn } from "@/lib/utils";
import "@/components/marketing/site/site.css";

/**
 * The home hero — "Night blue". One argument, centered, on navy: the AI does
 * the busywork, automatically. The product is the picture: the real manager
 * dashboard in a browser frame bleeding off the fold, the iPhone dashboard
 * over it, and one drafted reply floating out — the object the whole site is
 * about. Colours are explicit (not theme tokens) because the public pages are
 * locked to the light theme and this section is deliberately dark either way.
 *
 * Screenshots come from `public/marketing/product/` — captured from the
 * dev/test seed with nudges dismissed (see scripts/capture-marketing-shots.mjs);
 * never from production.
 */
export function SiteHero() {
  return (
    <section
      className="site-hero relative overflow-hidden bg-[#0b1120] text-white"
      aria-labelledby="site-hero-title"
      data-site-hero
    >
      {/* Background: two blue glows and a dot grain. Pure CSS, no assets. */}
      <div aria-hidden className="site-hero-glow site-hero-glow-a" />
      <div aria-hidden className="site-hero-glow site-hero-glow-b" />
      <div aria-hidden className="site-hero-grain" />

      <div className={cn(SITE_MEASURE, "relative z-[1] pt-16 sm:pt-20 lg:pt-24")}>
        <div className="mx-auto flex max-w-[60rem] flex-col items-center text-center">
          <p className="mb-4 flex items-center gap-1.5 text-[12.5px] font-bold uppercase tracking-[0.08em] text-[#8fb3ff]">
            <span aria-hidden>✦</span> AI-automated property management
          </p>
          <h1
            id="site-hero-title"
            className="text-[clamp(2.4rem,5.6vw,4rem)] font-bold leading-[1.02] tracking-[-0.035em] text-white"
          >
            The AI does the busywork.
            <br />
            <span className="text-[#5a8cff]">Automatically.</span>
          </h1>
          <p className="mt-5 max-w-[46ch] text-[16.5px] leading-relaxed text-[#b8c4dc] sm:text-[17.5px]">
            One place to list a home, take applications, draft the lease, collect rent and handle repairs — with the
            replies, bookings and dispatches run for you.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link
              href={GET_STARTED_HREF}
              data-attr="home-hero-get-started"
              className="inline-flex min-h-[48px] items-center justify-center rounded-full bg-white px-7 text-[15px] font-bold text-[#0b1120] shadow-[0_10px_30px_-10px_rgba(255,255,255,0.35)] transition hover:-translate-y-0.5 hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
            >
              Start free — no card
            </Link>
            <Link
              href={BOOK_DEMO_HREF}
              data-attr="home-hero-book-demo"
              className="inline-flex min-h-[48px] items-center justify-center rounded-full border border-white/30 px-7 text-[15px] font-bold text-white transition hover:border-white/60 hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
            >
              Book a demo
            </Link>
            <AppStoreBadge tone="light" size="lg" dataAttr="home-hero-app-store" className="h-12" />
          </div>
          <p className="mt-4 text-[13px] text-[#8391ad]">Free for one home · No card · Web and iPhone</p>
        </div>

        {/* Media: the real product, bleeding off the fold. */}
        <div className="relative mx-auto mt-12 max-w-[920px] sm:mt-14">
          <div className="site-hero-browser">
            <div className="flex items-center gap-1.5 border-b border-black/5 bg-[#f1f3f7] px-3 py-2 text-[11px] text-[#4a4e56]">
              <i className="h-2.5 w-2.5 rounded-full bg-[#d9dde5]" aria-hidden />
              <i className="h-2.5 w-2.5 rounded-full bg-[#d9dde5]" aria-hidden />
              <i className="h-2.5 w-2.5 rounded-full bg-[#d9dde5]" aria-hidden />
              <span className="ml-2 rounded-md bg-white px-2.5 py-0.5">prop-lane.space/portal/dashboard</span>
            </div>
            <Image
              src="/marketing/product/dashboard.webp"
              alt="The PropLane manager dashboard: occupancy, rent collected, open requests and a Needs attention list"
              width={1440}
              height={900}
              priority
              sizes="(max-width: 920px) 100vw, 920px"
              className="block h-auto w-full"
            />
          </div>

          <div className="site-hero-phone" aria-hidden>
            <Image
              src="/marketing/product/phone-dashboard.webp"
              alt=""
              width={390}
              height={844}
              sizes="180px"
              className="block h-auto w-full"
            />
          </div>

          {/* Two rows from the dashboard's queue — what the AI already did today. */}
          <div className="site-hero-draft" aria-hidden>
            <p className="mb-1.5 flex items-center gap-2 text-[11px] font-bold text-primary">
              <span>✦</span> Everything open <span className="rounded-full bg-[#e8f7ee] px-2 py-0.5 text-[10px] font-bold text-[#15803d]">Done</span>
            </p>
            <p className="text-[12.5px] font-semibold leading-snug text-[#17181a]">PropLane · Pacific Plumbing dispatched to Maple 2A</p>
            <p className="text-[11px] text-[#4a4e56]">Service request #1042 · Thu 10–12 · resident notified</p>
            <p className="mt-2 text-[11px] text-[#4a4e56]">Tour booked with Jamie P. · Sat 2:00 PM · <span className="font-bold text-[#15803d]">Done</span></p>
          </div>
        </div>
      </div>
    </section>
  );
}
