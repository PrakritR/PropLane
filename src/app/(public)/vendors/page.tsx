import type { Metadata } from "next";
import { VENDOR_GET_STARTED_HREF } from "@/lib/marketing/public-contact";
import { SiteFinalCta } from "@/components/marketing/site/final-cta";
import {
  MockChip,
  SITE_MEASURE,
  SiteCtaPair,
  SiteEyebrow,
  SiteHeading,
  SiteIntro,
  SiteSection,
} from "@/components/marketing/site/primitives";

export const metadata: Metadata = {
  title: "Vendors · PropLane",
  description:
    "Get matched to jobs by text, bid from your phone, show up with the entry instructions, and get paid through PropLane. Free to join as a vendor.",
};

/** The vendor's product is a text and a bid, so each step shows the phone. */
const STEPS = [
  {
    n: 1,
    title: "Get matched",
    body: "Managers on PropLane send you the job by text when your trade fits.",
    phone: (
      <>
        <PhoneBubble from="them">Faucet drip · Maple 2A · reply BID 140 or a number</PhoneBubble>
        <PhoneBubble from="you">BID 140</PhoneBubble>
      </>
    ),
  },
  {
    n: 2,
    title: "Tour & bid",
    body: "Visit with the entry instructions on your calendar, confirm scope, submit your price.",
    phone: (
      <>
        <PhoneBubble from="them">Thu 10–12 · lockbox 4471 · resident home</PhoneBubble>
        <PhoneBubble from="you">On my way</PhoneBubble>
      </>
    ),
  },
  {
    n: 3,
    title: "Get paid",
    body: "Invoice once. Approved work pays out through Connect, with labor and materials tracked.",
    phone: (
      <>
        <PhoneBubble from="you">Invoice $140 · sent</PhoneBubble>
        <div className="flex justify-start">
          <MockChip tone="good">Paid · Connect</MockChip>
        </div>
      </>
    ),
  },
] as const;

function PhoneBubble({ from, children }: { from: "them" | "you"; children: React.ReactNode }) {
  return (
    <div className={from === "you" ? "flex justify-end" : "flex justify-start"}>
      <p
        className={
          from === "you"
            ? "max-w-[85%] rounded-2xl rounded-br-md bg-primary px-3 py-2 text-[13px] leading-snug text-white"
            : "max-w-[85%] rounded-2xl rounded-bl-md bg-accent/70 px-3 py-2 text-[13px] leading-snug text-foreground"
        }
      >
        {children}
      </p>
    </div>
  );
}

const FACTS = [
  { value: "Free", label: "No subscription, no listing fee" },
  { value: "Direct", label: "Jobs from managers you already know" },
  { value: "1099", label: "Tax info on file for accurate filing" },
] as const;

export default function VendorsPage() {
  return (
    <div className="relative min-h-0 flex-1">
      <section className="border-b border-border/70 pb-14 pt-14 sm:pt-16 lg:pb-20 lg:pt-20" aria-labelledby="vendors-title">
        <div className={`${SITE_MEASURE} max-w-[860px]`}>
          <SiteEyebrow className="mb-4">For vendors</SiteEyebrow>
          <SiteHeading as="h1" id="vendors-title">
            Get matched. Bid from your phone.
            <br />
            <span className="text-primary">Get paid.</span>
          </SiteHeading>
          <p className="mt-5 max-w-[52ch] text-[16.5px] leading-relaxed text-muted sm:text-[17.5px]">
            Managers on PropLane send you the job by text. You bid, show up with the entry instructions, invoice once, and
            Connect pays out.
          </p>
          <SiteCtaPair
            className="mt-8"
            primaryHref={VENDOR_GET_STARTED_HREF}
            primaryLabel="Join as a vendor"
            primaryAttr="vendors-hero-get-started"
            secondaryHref="/contact"
            secondaryLabel="Ask a manager to invite you"
            secondaryAttr="vendors-hero-contact"
          />
        </div>
      </section>

      <SiteSection ariaLabelledBy="vendors-steps-title">
        <SiteIntro id="vendors-steps-title" eyebrow="How it works" title="Three texts and a payout." />
        <ol className="grid gap-4 md:grid-cols-3">
          {STEPS.map((s) => (
            <li key={s.n} className="flex flex-col rounded-2xl border border-border bg-card p-6">
              <span className="grid h-9 w-9 place-items-center rounded-full bg-primary text-[14px] font-bold text-white">{s.n}</span>
              <h3 className="mt-4 text-[18px] font-bold leading-snug tracking-tight text-foreground">{s.title}</h3>
              <p className="mt-2 flex-1 text-[14.5px] leading-relaxed text-muted">{s.body}</p>
              <div className="mt-5 space-y-2 rounded-2xl border border-border bg-[var(--pl-surface-muted)] p-3 [html[data-theme=dark]_&]:bg-white/[0.03]">
                {s.phone}
              </div>
            </li>
          ))}
        </ol>
      </SiteSection>

      <SiteSection tone="muted" ariaLabel="Vendor facts">
        <div className="grid gap-4 sm:grid-cols-3">
          {FACTS.map((f) => (
            <div key={f.label} className="rounded-2xl border border-border bg-card p-6 text-center">
              <p className="text-[28px] font-bold tracking-tight text-foreground">{f.value}</p>
              <p className="mt-1.5 text-[13.5px] text-muted">{f.label}</p>
            </div>
          ))}
        </div>
      </SiteSection>

      <SiteFinalCta
        title="Join as a vendor. It's free."
        lede="Or ask a manager who uses PropLane to invite you — the invite lands on your phone."
        primaryHref={VENDOR_GET_STARTED_HREF}
        primaryLabel="Join as a vendor"
        primaryAttr="vendors-closing-get-started"
        secondaryHref="/contact"
        secondaryLabel="Talk to us"
        secondaryAttr="vendors-closing-contact"
      />
    </div>
  );
}
