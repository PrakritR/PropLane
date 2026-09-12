"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { AppStoreBadge } from "@/components/marketing/app-store-badge";
import { SITE_BTN_PRIMARY, SiteIntro, SiteSection } from "@/components/marketing/site/primitives";
import { GET_STARTED_HREF } from "@/lib/marketing/public-contact";
import { cn } from "@/lib/utils";
import "@/components/marketing/site/site.css";

/**
 * The home page's one feature, told as a scroll story: four steps on the left,
 * a sticky product frame on the right that follows the step in view. Steps 1–3
 * are the portal inbox as it ships; step 4 is the dashboard's AI-drafts group.
 *
 * The frame is drawn with the portal's own vocabulary — the same control labels
 * (`Draft with AI`, `Ask PropLane`, `Schedule for later`, `In-app · Email · Text`,
 * `Sending as …`, `AI drafts · Pending approval`, `Approve · Discard`) and the
 * same tones — so a visitor who signs up meets the screen they just saw.
 * `tests/unit/site-story-labels.test.ts` pins those labels to the portal's.
 *
 * Every behaviour shown exists today: the leasing text responder answers
 * availability and offers tour slots; a resident email becomes a service
 * request with a vendor proposal; the vendor text agent answers job facts and
 * escalates money; approvals land under AI drafts. Nothing here is a live read.
 */

/* ── the four steps ─────────────────────────────────────────────── */

type StepId = "prospect" | "resident" | "vendor" | "approve";

const STEPS: { id: StepId; kicker: string; title: string; body: string }[] = [
  {
    id: "prospect",
    kicker: "01 · A prospect texts",
    title: "Answered in seconds, from your listing.",
    body: "Availability, price and open tour slots come straight from the listing. The reply goes out as a text under your work number. When they pick a time, the booking waits in your composer — you send it.",
  },
  {
    id: "resident",
    kicker: "02 · A resident reports a repair",
    title: "A service request, a vendor, a reply — drafted.",
    body: "The email becomes a service request. PropLane ranks your approved vendors, proposes one, and drafts the reply into the composer. Nothing is sent and nobody is dispatched until you do.",
  },
  {
    id: "vendor",
    kicker: "03 · A vendor asks a question",
    title: "Job facts answered. Money escalated.",
    body: "Gate codes, access windows, who is home — answered from the job. A change to an accepted bid is never guessed: it goes to your dashboard as a draft with the amount spelled out.",
  },
  {
    id: "approve",
    kicker: "04 · You approve",
    title: "One list. Approve or discard.",
    body: "Every proposed action — a tour, a dispatch, a change order — lands under AI drafts on your dashboard. Approve runs it; Discard sends nothing. The same list is on your phone.",
  },
];

/* ── the frame: inbox panes ──────────────────────────────────────── */

type Msg =
  | { kind: "in"; text: string; when: string; channel: "TEXT" | "EMAIL" }
  | { kind: "out"; text: string; when: string; channel: "TEXT" | "EMAIL"; auto?: string }
  | { kind: "sys"; text: string };

type InboxPane = {
  id: StepId;
  contact: { initials: string; name: string; sub: string; vendor?: boolean };
  channel: "In-app" | "Email" | "Text";
  sendingAs: string;
  messages: Msg[];
  draft: string;
};

const CONVERSATIONS = [
  { initials: "JP", name: "Jamie P.", sub: "Ash Flats 6 · Tour", id: "prospect" as StepId },
  { initials: "DR", name: "Dana Reyes", sub: "Maple 2A · Repair", id: "resident" as StepId },
  { initials: "PP", name: "Pacific Plumbing", sub: "Job #1042", id: "vendor" as StepId, vendor: true },
  { initials: "EW", name: "Ethan Wright", sub: "Application fee", id: null },
];

const INBOX_PANES: InboxPane[] = [
  {
    id: "prospect",
    contact: { initials: "JP", name: "Jamie P.", sub: "+1 (206) 555-0147 · prospect · Ash Flats 6" },
    channel: "Text",
    sendingAs: "(206) 555-0100",
    messages: [
      { kind: "in", text: "Hi! Is the room at 142 Ash St still available? Could I see it Saturday afternoon?", when: "Sat 10:02 AM", channel: "TEXT" },
      {
        kind: "out",
        text: "Yes — Room 6A is available from Oct 1 at $1,160/mo. Saturday works: 1:00, 2:00 or 3:30 PM. Which do you want?",
        when: "10:02 AM",
        channel: "TEXT",
        auto: "answered from the listing",
      },
      { kind: "in", text: "2 PM please!", when: "10:05 AM", channel: "TEXT" },
    ],
    draft: "Booked: Saturday 2:00 PM at 142 Ash St, Room 6A. You'll get a reminder Friday — reply here if anything changes.",
  },
  {
    id: "resident",
    contact: { initials: "DR", name: "Dana Reyes", sub: "dana.reyes@… · resident · Maple 2A" },
    channel: "Email",
    sendingAs: "PropLane",
    messages: [
      { kind: "in", text: "Hi, the kitchen faucet in Maple 2A has been dripping for two days. Can someone take a look?", when: "Tue 8:41 AM", channel: "EMAIL" },
      { kind: "sys", text: "Service request #1042 created · Plumbing · Maple 2A · Pacific Plumbing suggested (approved vendor · 4.9 · $140 typical)" },
    ],
    draft: "Thanks Dana — I've asked Pacific Plumbing to come Thursday between 10 and 12. They'll text you before they arrive. If that window doesn't work, reply here.",
  },
  {
    id: "vendor",
    contact: { initials: "PP", name: "Pacific Plumbing", sub: "+1 (206) 555-0188 · vendor · job #1042", vendor: true },
    channel: "Text",
    sendingAs: "(206) 555-0100",
    messages: [
      { kind: "in", text: "Running 20 min late for Maple 2A. Is there a gate code? Is the resident home?", when: "Thu 9:48 AM", channel: "TEXT" },
      {
        kind: "out",
        text: "Gate code is 4471#. Dana confirmed she's home until noon — I've let her know you're ~20 minutes out.",
        when: "9:48 AM",
        channel: "TEXT",
        auto: "answered from the job",
      },
      { kind: "in", text: "The shut-off valve is corroded — another $90. OK to proceed?", when: "10:30 AM", channel: "TEXT" },
      { kind: "sys", text: "Needs a manager: a change to the accepted $140 bid. Escalated to your dashboard → AI drafts." },
    ],
    draft: "Go ahead with the valve — approved for $90, so $230 total. Send me a photo of the old one for the file.",
  },
];

const AI_DRAFTS = [
  { title: "PropLane · Confirm tour with Jamie P.", sub: "Jamie P. · Sat 2:00 PM · Room 6A · ready to approve" },
  { title: "PropLane · Dispatch Pacific Plumbing to Maple 2A", sub: "Service request #1042 · Thu 10–12 · ready to approve" },
  { title: "PropLane · Approve $90 change on job #1042", sub: "Pacific Plumbing · bid $140 → $230 · ready to approve" },
];

/** The portal's control labels, exported so the unit test can pin them. */
export const STORY_PORTAL_LABELS = {
  generate: "Draft with AI",
  ask: "Ask PropLane",
  schedule: "Schedule for later",
  channels: ["In-app", "Email", "Text"] as const,
  sendingAs: "Sending as",
  aiDrafts: "AI drafts",
  pending: "Pending approval",
  approve: "Approve",
  discard: "Discard",
};

function Avatar({ initials, vendor, className }: { initials: string; vendor?: boolean; className?: string }) {
  return (
    <span
      className={cn(
        "grid h-7 w-7 shrink-0 place-items-center rounded-full text-[10px] font-extrabold",
        vendor ? "bg-[#e5e7eb] text-[#374151]" : "bg-[#dbe4ff] text-[#1e4fd6]",
        className,
      )}
      aria-hidden
    >
      {initials}
    </span>
  );
}

function ChannelChip({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full bg-primary/10 px-1.5 py-px text-[9px] font-extrabold tracking-[0.06em] text-[#1e4fd6]">
      {children}
    </span>
  );
}

function InboxFrame({ pane }: { pane: InboxPane }) {
  return (
    <div className="site-story-inbox" data-story-pane={pane.id}>
      <div className="site-story-list">
        <div className="flex items-end gap-3 border-b border-border px-3 pb-1.5 pt-2.5 text-[11.5px] font-bold text-muted">
          <span className="-mb-[7px] border-b-2 border-primary pb-1 text-primary">
            All <i className="not-italic rounded-full bg-primary/10 px-1.5 text-[10px]">4</i>
          </span>
          <span>
            Unread <i className="not-italic rounded-full bg-primary/10 px-1.5 text-[10px]">2</i>
          </span>
          <span>Archived</span>
        </div>
        <div className="m-2 rounded-lg border border-border px-2 py-1.5 text-[11px] text-muted">Search contacts or messages</div>
        {CONVERSATIONS.map((c) => (
          <div
            key={c.name}
            className={cn(
              "flex gap-2 border-b border-border px-2.5 py-2",
              c.id === pane.id && "border-l-[3px] border-l-primary bg-primary/[0.06] pl-[7px]",
            )}
          >
            <Avatar initials={c.initials} vendor={c.vendor} />
            <span className="min-w-0">
              <span className="block truncate text-[12px] font-bold text-foreground">{c.name}</span>
              <span className="block truncate text-[10.5px] text-muted">{c.sub}</span>
            </span>
          </div>
        ))}
      </div>

      <div className="flex min-w-0 flex-col">
        <div className="flex items-center gap-2.5 border-b border-border px-3.5 py-2.5">
          <Avatar initials={pane.contact.initials} vendor={pane.contact.vendor} className="h-8 w-8" />
          <span className="min-w-0">
            <span className="block text-[13px] font-bold text-foreground">{pane.contact.name}</span>
            <span className="block truncate text-[11px] text-muted">{pane.contact.sub}</span>
          </span>
          <span className="ml-auto flex gap-1.5" aria-hidden>
            <i className="grid h-7 w-7 place-items-center rounded-lg border border-border text-[12px] not-italic text-muted">✎</i>
            <i className="grid h-7 w-7 place-items-center rounded-lg border border-border text-[12px] not-italic text-muted">▤</i>
          </span>
        </div>

        <div className="flex flex-1 flex-col gap-2.5 overflow-hidden bg-[var(--pl-surface)] px-3.5 py-3">
          {pane.messages.map((m, i) => {
            if (m.kind === "sys") {
              return (
                <p key={i} className="mx-auto max-w-[90%] rounded-lg border border-border bg-card px-2.5 py-1.5 text-center text-[11px] text-muted">
                  {m.text}
                </p>
              );
            }
            const out = m.kind === "out";
            return (
              <div key={i} className={cn("flex max-w-[88%] gap-2", out && "ml-auto justify-end")}>
                {!out ? <Avatar initials="•" className="h-[22px] w-[22px] self-end text-[8px]" /> : null}
                <div>
                  <p
                    className={cn(
                      "rounded-2xl px-3 py-2 text-[12px] leading-snug",
                      out ? "rounded-br-sm bg-primary text-white" : "rounded-tl-sm bg-[#eef2ff] text-foreground",
                    )}
                  >
                    {m.text}
                  </p>
                  <p className={cn("mt-1 flex items-center gap-1.5 text-[10px] text-muted", out && "justify-end")}>
                    {!out ? <ChannelChip>{m.channel}</ChannelChip> : null}
                    <span>{m.when}</span>
                    {out ? <ChannelChip>{m.channel}</ChannelChip> : null}
                    {out && m.auto ? <span className="font-bold text-primary">✦ {m.auto}</span> : null}
                  </p>
                </div>
              </div>
            );
          })}
        </div>

        {/* The assist row, channel picker and composer — the portal's, verbatim. */}
        <div className="flex items-center gap-2 border-t border-border px-3 py-2 text-[11.5px]">
          <span className="rounded-full border border-primary/15 bg-primary/[0.06] px-2.5 py-1.5 font-bold text-primary">
            ✦ {STORY_PORTAL_LABELS.generate}
          </span>
          <span className="rounded-full border border-primary/15 bg-primary/[0.04] px-2.5 py-1.5 font-bold text-foreground">
            ✦ {STORY_PORTAL_LABELS.ask}
          </span>
          <span className="flex items-center gap-1.5 font-semibold text-foreground">
            <i className="inline-block h-3.5 w-3.5 rounded border border-border bg-card" aria-hidden /> {STORY_PORTAL_LABELS.schedule}
          </span>
        </div>
        <div className="flex items-center gap-2.5 px-3 pt-1.5">
          <span className="inline-flex overflow-hidden rounded-lg border border-border text-[11.5px] font-semibold text-muted">
            {STORY_PORTAL_LABELS.channels.map((c) => (
              <span key={c} className={cn("px-2.5 py-1", c === pane.channel && "bg-primary/[0.08] font-bold text-primary")}>
                {c}
              </span>
            ))}
          </span>
          <span className="text-[11px] text-muted">
            {STORY_PORTAL_LABELS.sendingAs} {pane.sendingAs}
          </span>
        </div>
        <div className="flex items-center gap-2 px-3 pb-3 pt-2">
          <i className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-border text-[12px] not-italic text-muted" aria-hidden>
            ⊕
          </i>
          <p className="min-h-[44px] flex-1 rounded-2xl border border-border px-3 py-2 text-[12px] leading-snug text-foreground">
            {pane.draft}
            <span className="site-story-caret" aria-hidden />
          </p>
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-primary text-[11px] text-white" aria-hidden>
            ➤
          </span>
        </div>
      </div>
    </div>
  );
}

function DashboardFrame() {
  return (
    <div className="site-story-dash" data-story-pane="approve">
      <div className="mb-3 flex items-center gap-2.5">
        <span className="text-[16px] font-bold text-foreground">✦ Everything open</span>
        <span className="rounded-full border border-border bg-card px-2 py-0.5 text-[11px] text-muted">● 113 open</span>
      </div>
      <div className="overflow-hidden rounded-lg border border-border border-l-[3px] border-l-primary bg-card">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
          <span className="text-muted" aria-hidden>
            ⌄
          </span>
          <span className="text-[13px] font-bold text-primary">{STORY_PORTAL_LABELS.aiDrafts}</span>
          <span className="ml-auto rounded-full bg-primary/10 px-1.5 text-[11px] font-bold text-primary">{AI_DRAFTS.length}</span>
          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-bold text-primary">{STORY_PORTAL_LABELS.pending}</span>
        </div>
        {AI_DRAFTS.map((d) => (
          <div key={d.title} className="flex items-center gap-2.5 border-b border-border px-3 py-2.5 last:border-b-0">
            <i className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12.5px] font-semibold text-foreground">{d.title}</span>
              <span className="block truncate text-[11px] text-muted">{d.sub}</span>
            </span>
            <span className="rounded-full bg-primary px-3 py-1.5 text-[11.5px] font-bold text-white">{STORY_PORTAL_LABELS.approve}</span>
            <span className="rounded-full border border-border px-3 py-1.5 text-[11.5px] font-bold text-foreground">{STORY_PORTAL_LABELS.discard}</span>
          </div>
        ))}
      </div>
      <div className="mt-2.5 flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2.5 text-[13px] font-bold text-foreground">
        <span className="text-muted" aria-hidden>
          ›
        </span>
        Tour requests
        <span className="ml-auto rounded-full bg-[var(--pl-surface-muted)] px-1.5 text-[11px] font-bold text-muted">0</span>
      </div>
    </div>
  );
}

/* ── the section ─────────────────────────────────────────────────── */

export function SiteStory() {
  const [active, setActive] = useState<StepId>("prospect");
  const stepRefs = useRef<Record<string, HTMLDivElement | null>>({});

  useEffect(() => {
    // Reduced motion: the CSS stacks the frame between steps and every pane
    // shows, so there is nothing to observe.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) setActive((e.target as HTMLElement).dataset.step as StepId);
        }
      },
      { rootMargin: "-40% 0px -45% 0px", threshold: 0 },
    );
    for (const el of Object.values(stepRefs.current)) if (el) io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <SiteSection id="product" tone="muted" ariaLabelledBy="site-story-title" className="site-story-band">
      <SiteIntro
        eyebrow="The feature"
        id="site-story-title"
        title="Every message answered. Nothing sent without you."
        lede="Prospects, residents and vendors all write to one inbox. PropLane answers what it can from your listings, leases and jobs, drafts the rest, and waits for your OK on anything that books, dispatches or costs money."
      />

      <div className="site-story" data-active={active}>
        <div className="site-story-steps">
          {STEPS.map((s) => (
            <div
              key={s.id}
              data-step={s.id}
              ref={(el) => {
                stepRefs.current[s.id] = el;
              }}
              className={cn("site-story-step", active === s.id && "is-active")}
              onClick={() => setActive(s.id)}
            >
              <p className="mb-1.5 text-[12.5px] font-bold uppercase tracking-[0.08em] text-primary">{s.kicker}</p>
              <h3 className="text-[22px] font-bold leading-tight tracking-tight">{s.title}</h3>
              <p className="mt-2.5 text-[15px] leading-relaxed text-muted">{s.body}</p>
              {s.id === "approve" ? (
                <div className="mt-5 flex flex-wrap items-center gap-3">
                  <Link href={GET_STARTED_HREF} data-attr="home-story-get-started" className={SITE_BTN_PRIMARY}>
                    Start free — no card
                  </Link>
                  <AppStoreBadge dataAttr="home-story-app-store" />
                </div>
              ) : null}
            </div>
          ))}
        </div>

        <div className="site-story-frame" aria-hidden>
          <div className="flex items-center gap-1.5 border-b border-border bg-[#f1f3f7] px-3 py-2 text-[11px] text-muted">
            <i className="h-2.5 w-2.5 rounded-full bg-[#d9dde5]" />
            <i className="h-2.5 w-2.5 rounded-full bg-[#d9dde5]" />
            <i className="h-2.5 w-2.5 rounded-full bg-[#d9dde5]" />
            <span className="ml-2 rounded-md bg-card px-2.5 py-0.5">
              prop-lane.space/portal/{active === "approve" ? "dashboard" : "inbox"}
            </span>
          </div>
          {INBOX_PANES.map((p) => (
            <div key={p.id} className="site-story-pane" hidden={active !== p.id}>
              <InboxFrame pane={p} />
            </div>
          ))}
          <div className="site-story-pane" hidden={active !== "approve"}>
            <DashboardFrame />
          </div>
        </div>
      </div>

      <p className="mt-10 flex flex-wrap items-center gap-2 text-[13px] text-muted">
        <span className="mr-1 text-[11px] font-extrabold uppercase tracking-[0.12em] text-muted">Also inside</span>
        {["Listings", "Tours", "Applications", "Leases & e-sign", "Payments & ledger", "Services", "Inspections", "Tasks", "Calendar"].map(
          (label) => (
            <span key={label} className="rounded-full border border-border bg-card px-2.5 py-1 text-foreground">
              {label}
            </span>
          ),
        )}
        <Link href="/partner" data-attr="home-story-see-everything" className="font-bold text-primary hover:underline">
          See everything →
        </Link>
      </p>
    </SiteSection>
  );
}
