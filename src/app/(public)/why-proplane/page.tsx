import type { Metadata } from "next";
import Link from "next/link";
import { Building2, KeyRound, Landmark, Wrench } from "lucide-react";
import type { ReactNode } from "react";
import { RESIDENT_BROWSE_PATH } from "@/lib/resident-public-nav";
import { SiteFinalCta } from "@/components/marketing/site/final-cta";
import {
  MockApproveRow,
  MockChip,
  MockDraft,
  MockFrame,
  SiteCtaPair,
  SiteEyebrow,
  SiteHeading,
  SiteLede,
  SitePageHero,
  SiteSection,
} from "@/components/marketing/site/primitives";
import { SitePage } from "@/components/marketing/site/site-page";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Why PropLane",
  description:
    "A property manager's main job is relaying messages between residents, vendors and owners. PropLane's AI assistant does the relaying, and you approve what matters.",
};

/*
 * A narrative page, not a feature list. The argument, in order:
 *   1. a manager's main job is communication: they are the switchboard;
 *   2. the switchboard problem, drawn as one repair passing through five hops;
 *   3. what PropLane changes: the assistant drafts, routes and follows up;
 *   4. how it stays safe;
 *   5. where to start.
 *
 * Every claim is one the product keeps (see docs/ai-assistant.md,
 * docs/agents/communication-inbox.md, docs/agents/automated-communication.md,
 * docs/agents/vendor-dispatch-agent.md). People appear only as roles.
 */

type Hop = { role: string; icon: ReactNode; you?: boolean; says: string; to: string };

/** One repair, five hops. Two of them are the manager, which is the point. */
const SWITCHBOARD: Hop[] = [
  { role: "Resident", icon: <KeyRound strokeWidth={2} aria-hidden />, says: "The kitchen sink is leaking.", to: "to the manager" },
  { role: "Manager", icon: <Building2 strokeWidth={2} aria-hidden />, you: true, says: "Can you look at it this week?", to: "to the vendor" },
  { role: "Vendor", icon: <Wrench strokeWidth={2} aria-hidden />, says: "Here is my quote. Thursday works.", to: "to the manager" },
  { role: "Manager", icon: <Building2 strokeWidth={2} aria-hidden />, you: true, says: "Approve this repair?", to: "to the owner" },
  { role: "Owner", icon: <Landmark strokeWidth={2} aria-hidden />, says: "Go ahead.", to: "and then back down the line" },
];

const CHANGES = [
  {
    label: "Drafts",
    copy: "It reads the thread, the lease and the ledger, then writes the reply in your voice with the real numbers. You approve it, edit it, or discard it.",
  },
  {
    label: "Routes",
    copy: "A repair reaches the right vendor. With vendor dispatch on, PropLane ranks your vendors and proposes one for you to approve. The vendor gets the job by text, and its own assistant answers questions about that job.",
  },
  {
    label: "Follows up",
    copy: "Rent reminders, visit reminders, the vendor who went quiet, the resident who has not confirmed the fix: PropLane sends the nudge on a fixed schedule, so you stop chasing.",
  },
] as const;

const SAFETY = [
  {
    label: "Every change waits for your OK",
    copy: "When the assistant wants to change something, it shows you a preview and does nothing until you confirm. Turn on “Resident & vendor messages need my approval first” and every automatic message waits in your inbox as a draft.",
  },
  {
    label: "Regulated notices are never automated",
    copy: "For late rent, deposit accounting and adverse action, PropLane reminds you that something is due and opens the tool. It never drafts the notice for you.",
  },
  {
    label: "One work number, one work email",
    copy: "Everything to a resident, applicant or vendor goes out from your workspace's work number and work email, so replies come back to one inbox instead of your personal phone.",
  },
  {
    label: "Each role sees only its own",
    copy: "A vendor sees the general area until they accept a job, and the vendor assistant has no way to change a price or a visit. Residents and vendors see their own records, never each other's.",
  },
] as const;

const ROLES = [
  {
    href: "/partner",
    title: "Managers & landlords",
    body: "Run the portfolio and approve the rest.",
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

const CARD = "rounded-2xl border border-[var(--site-line,#dbe4ef)] bg-white/85 shadow-[0_18px_44px_-30px_rgba(19,43,71,0.3)]";

function SwitchboardChain() {
  return (
    <ol aria-label="One repair request, passed along five times" className={cn(CARD, "grid gap-0 p-5 sm:p-7 lg:grid-cols-5 lg:gap-0 lg:p-8")}>
      {SWITCHBOARD.map((hop, i) => (
        <li key={i} className="relative flex gap-4 pb-6 last:pb-0 lg:block lg:pb-0 lg:pr-5 lg:last:pr-0">
          {/* The line between hops: down the left edge on a phone, across the top on a desktop. */}
          {i < SWITCHBOARD.length - 1 ? (
            <span
              aria-hidden
              className="absolute left-[19px] top-11 h-[calc(100%-2.75rem)] w-px bg-[#b7cce3] lg:left-12 lg:top-[19px] lg:h-px lg:w-[calc(100%-3rem)]"
            />
          ) : null}
          <span
            className={cn(
              "relative z-[1] grid h-10 w-10 shrink-0 place-items-center rounded-full border text-primary [&>svg]:h-[18px] [&>svg]:w-[18px]",
              hop.you ? "border-[#1769bd] bg-[#1769bd] text-white" : "border-[#b7cce3] bg-white",
            )}
          >
            {hop.icon}
          </span>
          <div className="min-w-0 lg:mt-4">
            <p className="flex items-center gap-2 text-[14px] font-bold text-foreground">
              {hop.role}
              {hop.you ? <MockChip tone="info">You</MockChip> : null}
            </p>
            <p className="mt-1.5 rounded-xl rounded-tl-sm bg-[#eef4fb] px-3 py-2 text-[13.5px] leading-snug text-foreground">{hop.says}</p>
            <p className="mt-1.5 text-[12px] font-semibold text-muted">{hop.to}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

function RelayMock() {
  return (
    <MockFrame title="Communication · Resident" aside={<MockChip tone="warn">2 drafts</MockChip>}>
      <div className="space-y-3">
        <p className="max-w-[85%] rounded-xl rounded-tl-sm bg-accent/70 px-3 py-2 text-[13px] leading-snug text-foreground">
          The kitchen sink is leaking under the cabinet.
        </p>
        <MockDraft label="PropLane drafted a reply to the resident">
          Thanks for telling us. A plumber can come Thursday between 10 and noon. I will confirm as soon as it is booked.
        </MockDraft>
        <MockDraft label="PropLane drafted a message to the vendor">
          Leaking kitchen sink, general area only until you accept. Can you visit Thursday morning? A quote first, please.
        </MockDraft>
        <MockApproveRow />
      </div>
    </MockFrame>
  );
}

export default function WhyPropLanePage() {
  return (
    <SitePage>
      <SitePageHero
        eyebrow="Why PropLane"
        id="why-title"
        wide
        title={
          <>
            You manage properties.
            <span className="site-accent">You work a switchboard.</span>
          </>
        }
        lede="Most of the job is communication: what the resident said goes to the vendor, what the vendor quoted goes to the owner, and every answer goes back down the line. PropLane's assistant does the relaying. You approve what matters."
        actions={
          <SiteCtaPair
            align="center"
            primaryLabel="Get started free"
            primaryAttr="why-proplane-hero-get-started"
            secondaryHref="/pricing"
            secondaryLabel="See pricing"
            secondaryAttr="why-proplane-hero-pricing"
          />
        }
      />

      <SiteSection ariaLabelledBy="why-switchboard-title">
        <div className="mx-auto mb-10 flex max-w-[48rem] flex-col items-center text-center sm:mb-12">
          <SiteEyebrow className="mb-3">The problem</SiteEyebrow>
          <SiteHeading id="why-switchboard-title">One leaking sink, five handoffs.</SiteHeading>
          <SiteLede className="mx-auto mt-4">
            A resident cannot call a vendor, and a vendor cannot ask the owner. So the manager sits in the middle of every conversation, retyping the same message for the next person on the line.
          </SiteLede>
        </div>
        <SwitchboardChain />
        <p className="mx-auto mt-8 max-w-[44rem] text-center text-[15.5px] leading-relaxed text-muted">
          Two of those five hops are you, and the answers still have to travel back the same way. It is a lot of skill spent on being a middleman.
        </p>
      </SiteSection>

      <SiteSection ariaLabelledBy="why-change-title">
        <div className="grid items-start gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,460px)] lg:gap-16">
          <div>
            <SiteEyebrow className="mb-3">What PropLane changes</SiteEyebrow>
            <SiteHeading id="why-change-title" className="max-w-[18ch]">
              The assistant relays.
              <span className="site-accent block">You decide.</span>
            </SiteHeading>
            <SiteLede className="mt-4">
              The same messages still go out. They are just written, addressed and followed up for you, and they wait for you wherever it matters.
            </SiteLede>
            <dl className="mt-8 border-t border-[#c9d8e9]">
              {CHANGES.map((c) => (
                <div key={c.label} className="grid gap-1.5 border-b border-[#c9d8e9] py-5 sm:grid-cols-[140px_minmax(0,1fr)] sm:gap-8">
                  <dt className="text-[15px] font-bold text-foreground">{c.label}</dt>
                  <dd className="text-[15px] leading-relaxed text-muted">{c.copy}</dd>
                </div>
              ))}
            </dl>
          </div>
          <div className="min-w-0 lg:sticky lg:top-24">
            <RelayMock />
          </div>
        </div>
      </SiteSection>

      <SiteSection ariaLabelledBy="why-safe-title">
        <div className="mx-auto max-w-[56rem]">
          <div className="mb-8 flex flex-col items-center text-center sm:mb-10">
            <SiteEyebrow className="mb-3">How it stays safe</SiteEyebrow>
            <SiteHeading id="why-safe-title">Fast does not mean unsupervised.</SiteHeading>
          </div>
          <dl className={cn(CARD, "divide-y divide-[#dbe4ef] px-5 sm:px-8")}>
            {SAFETY.map((s) => (
              <div key={s.label} className="grid gap-1.5 py-6 sm:grid-cols-[230px_minmax(0,1fr)] sm:gap-10">
                <dt className="text-[16px] font-bold leading-snug text-foreground">{s.label}</dt>
                <dd className="text-[15px] leading-relaxed text-muted">{s.copy}</dd>
              </div>
            ))}
          </dl>
        </div>
      </SiteSection>

      <SiteSection ariaLabelledBy="why-roles-title">
        <div>
          <SiteHeading id="why-roles-title" className="mb-8 text-center">
            Start where you fit
          </SiteHeading>
          <div className="mx-auto grid max-w-[60rem] gap-4 md:grid-cols-3">
            {ROLES.map((card) => (
              <Link
                key={card.href}
                href={card.href}
                data-attr={card.attr}
                className={cn(CARD, "flex h-full flex-col p-6 transition-[border-color,transform] duration-100 hover:-translate-y-0.5 hover:border-[#8fb0d4]")}
              >
                <h3 className="text-[18px] font-bold tracking-tight text-foreground">{card.title}</h3>
                <p className="mt-2 flex-1 text-[14.5px] text-muted">{card.body}</p>
                <span className="mt-5 text-[14px] font-bold text-primary">{card.cta} →</span>
              </Link>
            ))}
          </div>
        </div>
      </SiteSection>

      <SiteFinalCta primaryAttr="why-proplane-closing-get-started" secondaryAttr="why-proplane-closing-book-demo" />
    </SitePage>
  );
}
