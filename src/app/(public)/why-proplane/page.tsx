import type { Metadata } from "next";
import Link from "next/link";
import { RESIDENT_BROWSE_PATH } from "@/lib/resident-public-nav";
import { SiteFinalCta } from "@/components/marketing/site/final-cta";
import {
  MockApproveRow,
  MockChip,
  MockDraft,
  MockFrame,
  MockRow,
  SITE_MEASURE,
  SiteCtaPair,
  SiteEyebrow,
  SiteHeading,
  SiteSection,
} from "@/components/marketing/site/primitives";

export const metadata: Metadata = {
  title: "Why PropLane",
  description:
    "AI drafts leases, tours, messages and rent work. You approve every send. One platform for managers, residents and vendors, with a real ledger underneath.",
};

/**
 * A long-form manifesto in three chapters, with a chapter rail on the left
 * and one product screen per chapter. The through-line is the one rule the
 * whole product is built on: nothing sends without you.
 */
const CHAPTERS = [
  {
    id: "drafts",
    eyebrow: "Chapter 1",
    title: "AI drafts. You approve.",
    body: [
      "Most of property management is writing: the reply to the resident, the lease from the application, the reminder three days after rent was due, the request to the plumber. PropLane writes those. It reads the application, the ledger, the listing and the thread, and it drafts — in your voice, with the real numbers.",
      "Then it stops. Every draft lands in one queue and waits. You approve it, edit it, or discard it. A $50 late fee follows the same rule as a lease; nothing reaches a resident, an applicant or a vendor on its own. That rule is not a setting. It is the product.",
    ],
    points: [
      ["Leases from applications", "Terms filled from the applicant; e-sign when you release."],
      ["Messages that draft first", "Rent, lease-ready and visit updates draft; you send."],
      ["Tours that book themselves", "Prospects pick a slot from the listing; it lands on your calendar."],
    ],
    mock: (
      <MockFrame title="Needs attention" aside={<MockChip tone="bad">3</MockChip>}>
        <MockDraft label="Lease draft · Maya Chen · 12 months · $1,160">
          <span className="text-muted">Generated from her application in 40s. Clause 9 (pets) matches the listing.</span>
        </MockDraft>
        <div className="mt-3">
          <MockApproveRow />
        </div>
      </MockFrame>
    ),
  },
  {
    id: "portals",
    eyebrow: "Chapter 2",
    title: "Managers, residents, vendors. One home.",
    body: [
      "The same product, scoped correctly. A manager sees the portfolio; a resident sees their home, their lease and their rent; a vendor sees the job, the visit and the payout. Everyone works in PropLane instead of in three parallel inboxes.",
      "Residents never get a password from you. They apply, PropLane sends a one-time link tied to that application, and once you approve them they set up their own account — then pay, sign and ask from their phone. Vendors get the job by text and bid from theirs.",
    ],
    points: [
      ["Managers", "Leasing, rent, services, inbox, finances, and the approval queue."],
      ["Residents", "Browse, apply, pay rent, sign, and message your manager."],
      ["Vendors", "Jobs, bids, visits, invoices and payouts in one place."],
    ],
    mock: (
      <MockFrame title="Resident · Home" aside={<MockChip tone="good">Lease signed</MockChip>}>
        <div className="divide-y divide-border/60">
          <MockRow avatar={false} name="Rent" title="Rent · October" sub="Due Oct 1 · autopay on" right={<MockChip tone="info">Pay $1,800</MockChip>} />
          <MockRow avatar={false} name="Inspection" title="Move-in inspection" sub="Photos due Sep 20" right={<MockChip>Open</MockChip>} />
          <MockRow avatar={false} name="Faucet" title="Kitchen faucet" sub="Pacific Plumbing · Thu 10–12" right={<MockChip tone="info">Booked</MockChip>} />
        </div>
      </MockFrame>
    ),
  },
  {
    id: "ledger",
    eyebrow: "Chapter 3",
    title: "A ledger, not a spreadsheet.",
    body: [
      "Every charge and every payment writes through to a double-entry ledger as it happens — not in a spring clean-up. Security deposits book as a liability, because that is what they are. Owner statements come per property.",
      "The numbers the assistant quotes are these numbers. It never does its own arithmetic; it reads the ledger and tells you what is there.",
    ],
    points: [
      ["Trial balance & GL", "Always balanced, from the same source of truth."],
      ["Owner statements", "Per property, ready to send."],
      ["Deposit trust", "Security deposits book as liability, not income."],
    ],
    mock: (
      <MockFrame title="Finances · September">
        <div className="divide-y divide-border/60 text-[13.5px]">
          {[
            ["Rent", "$7,250"],
            ["Other income", "$600"],
            ["Repairs", "–$540"],
            ["Security deposits held", "$3,600 · liability"],
          ].map(([k, v]) => (
            <div key={k} className="flex items-center justify-between py-2">
              <span className="text-foreground">{k}</span>
              <span className="font-semibold tabular-nums text-foreground">{v}</span>
            </div>
          ))}
          <div className="flex items-center justify-between py-2">
            <b className="text-foreground">Net</b>
            <b className="tabular-nums text-foreground">$7,310</b>
          </div>
        </div>
      </MockFrame>
    ),
  },
] as const;

const OLD_WAY = [
  "Retype applications into lease templates and chase signatures by email.",
  "Text tenants about rent and track paid/unpaid in a spreadsheet.",
  "Phone-tag contractors for one quote on one repair.",
  "Reconcile receipts every spring for something tax-ready.",
] as const;

const PROPLANE_WAY = [
  "AI drafts the lease from the application; you review, both sides e-sign.",
  "Rent collects on-platform; reminders draft, you approve the send.",
  "Services invite bids; approved work pays out through Connect.",
  "Double-entry posts itself: trial balance, trust, owner statements.",
] as const;

const ROLES = [
  {
    href: "/partner",
    title: "Managers & landlords",
    body: "Run the portfolio with AI approvals.",
    cta: "For managers & landlords",
    attr: "why-role-managers",
  },
  {
    href: RESIDENT_BROWSE_PATH,
    title: "Residents",
    body: "Browse, apply, pay, and message.",
    cta: "For residents",
    attr: "why-role-residents",
  },
  {
    href: "/vendors",
    title: "Vendors",
    body: "Jobs, bids, and payouts.",
    cta: "For vendors",
    attr: "why-role-vendors",
  },
] as const;

export default function WhyPropLanePage() {
  return (
    <div className="relative min-h-0 flex-1">
      <section className="border-b border-border/70 pb-14 pt-14 sm:pt-16 lg:pb-20 lg:pt-20" aria-labelledby="why-title">
        <div className={`${SITE_MEASURE} max-w-[860px]`}>
          <SiteEyebrow className="mb-4">Why PropLane</SiteEyebrow>
          <SiteHeading as="h1" id="why-title">
            Property ops that wait
            <br />
            <span className="text-primary">for your OK.</span>
          </SiteHeading>
          <p className="mt-5 max-w-[52ch] text-[16.5px] leading-relaxed text-muted sm:text-[17.5px]">
            Tours. Texts. Rent. Repairs. One platform for managers, residents and vendors — the AI drafts, you confirm, and
            a real ledger keeps score.
          </p>
          <SiteCtaPair
            className="mt-8"
            primaryLabel="Get started free"
            primaryAttr="why-proplane-hero-get-started"
            secondaryHref="/pricing"
            secondaryLabel="See pricing"
            secondaryAttr="why-proplane-hero-pricing"
          />
        </div>
      </section>

      <SiteSection ariaLabel="Chapters">
        <div className="grid gap-12 lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-16">
          <nav aria-label="Chapters" className="hidden lg:block">
            <ol className="sticky top-24 space-y-1 border-l border-border pl-4">
              {CHAPTERS.map((c, i) => (
                <li key={c.id}>
                  <a href={`#${c.id}`} className="block py-1.5 text-[13.5px] font-semibold text-muted hover:text-primary">
                    <span className="mr-2 tabular-nums text-primary">0{i + 1}</span>
                    {c.title}
                  </a>
                </li>
              ))}
            </ol>
            <p className="mt-8 border-l-2 border-primary pl-4 text-[15px] font-bold leading-snug text-foreground">
              &ldquo;Nothing sends without you.&rdquo;
            </p>
          </nav>
          <div className="space-y-20 lg:space-y-24">
            {CHAPTERS.map((c) => (
              <article key={c.id} id={c.id} className="scroll-mt-24">
                <SiteEyebrow className="mb-3">{c.eyebrow}</SiteEyebrow>
                <h2 className="text-[clamp(1.7rem,3.2vw,2.4rem)] font-bold leading-[1.08] tracking-[-0.03em] text-foreground">
                  {c.title}
                </h2>
                <div className="mt-8 grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_400px] lg:gap-12">
                  <div className="space-y-4 text-[16px] leading-[1.75] text-foreground/85">
                    {c.body.map((p) => (
                      <p key={p.slice(0, 24)}>{p}</p>
                    ))}
                    <dl className="mt-6 divide-y divide-border rounded-2xl border border-border bg-card">
                      {c.points.map(([label, copy]) => (
                        <div key={label} className="px-4 py-3">
                          <dt className="text-[14px] font-bold text-foreground">{label}</dt>
                          <dd className="mt-0.5 text-[13.5px] text-muted">{copy}</dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                  <div className="min-w-0 lg:sticky lg:top-24">{c.mock}</div>
                </div>
              </article>
            ))}
          </div>
        </div>
      </SiteSection>

      <SiteSection tone="muted" ariaLabelledBy="why-compare-title">
        <SiteHeading id="why-compare-title" className="mb-8 text-center">
          Old way vs PropLane
        </SiteHeading>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded-2xl border border-border bg-card p-6">
            <h3 className="text-[15px] font-bold uppercase tracking-[0.06em] text-muted">Old way</h3>
            <ul className="mt-4 space-y-3">
              {OLD_WAY.map((item) => (
                <li key={item} className="flex items-start gap-2.5 text-[14.5px] leading-relaxed text-muted">
                  <span aria-hidden className="mt-0.5 text-muted/70">✕</span>
                  {item}
                </li>
              ))}
            </ul>
          </div>
          <div className="rounded-2xl border border-primary/40 bg-card p-6 ring-[3px] ring-primary/10">
            <h3 className="text-[15px] font-bold uppercase tracking-[0.06em] text-primary">PropLane</h3>
            <ul className="mt-4 space-y-3">
              {PROPLANE_WAY.map((item) => (
                <li key={item} className="flex items-start gap-2.5 text-[14.5px] leading-relaxed text-foreground">
                  <span aria-hidden className="mt-0.5 font-bold text-primary">✓</span>
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </SiteSection>

      <SiteSection ariaLabelledBy="why-roles-title">
        <SiteHeading id="why-roles-title" className="mb-8 text-center">
          Start where you fit
        </SiteHeading>
        <div className="grid gap-4 md:grid-cols-3">
          {ROLES.map((card) => (
            <Link
              key={card.href}
              href={card.href}
              data-attr={card.attr}
              className="flex h-full flex-col rounded-2xl border border-border bg-card p-6 transition hover:border-primary/40"
            >
              <h3 className="text-[18px] font-bold tracking-tight text-foreground">{card.title}</h3>
              <p className="mt-2 flex-1 text-[14.5px] text-muted">{card.body}</p>
              <span className="mt-5 text-[14px] font-bold text-primary">{card.cta} →</span>
            </Link>
          ))}
        </div>
      </SiteSection>

      <SiteFinalCta primaryAttr="why-proplane-closing-get-started" secondaryAttr="why-proplane-closing-book-demo" />
    </div>
  );
}
