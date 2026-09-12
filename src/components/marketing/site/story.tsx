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
 * a sticky product frame on the right that follows the step in view — and that
 * the visitor can play with. Steps 1–3 are the portal's Communication inbox as
 * it ships (one composer row: attach · reply · ✦ AI · 🕒 schedule · channel
 * menu · Send); step 4 is the dashboard's one queue.
 *
 * Interactive, not a video: ✦ opens the AI menu and "Draft with AI" types the
 * reply into the field; 🕒 toggles a scheduled send; the channel menu switches
 * In-app / Email / Text; Send posts the reply into the thread; a conversation
 * in the list switches the step; Approve / Discard on the queue resolve a row.
 * Nothing here is a live read — every action is local to the page.
 *
 * The frame uses the portal's own control labels so a visitor who signs up
 * meets the screen they just saw; `tests/unit/site-story-labels.test.ts` pins
 * them. Every behaviour shown exists today: the leasing text responder answers
 * availability and books tours; a resident email becomes a service request
 * with a vendor dispatched; the vendor text agent answers job facts and routes
 * a change order; everything the AI does lands in one queue.
 */

/* ── the four steps ─────────────────────────────────────────────── */

type StepId = "prospect" | "resident" | "vendor" | "queue";

const STEPS: { id: StepId; kicker: string; title: string; body: string }[] = [
  {
    id: "prospect",
    kicker: "01 · A prospect texts",
    title: "Answered in seconds. Tour booked.",
    body: "Availability, price and open slots come straight from the listing. PropLane replies as a text under your work number, offers times, and books the tour when they pick one. Try it — press ✦, then Send.",
  },
  {
    id: "resident",
    kicker: "02 · A resident reports a repair",
    title: "Request logged. Vendor dispatched. Resident told.",
    body: "The email becomes a service request. PropLane ranks your approved vendors, books the first open slot with the best one, and writes back to the resident with the window.",
  },
  {
    id: "vendor",
    kicker: "03 · A vendor asks a question",
    title: "Job facts answered. Change orders routed.",
    body: "Gate codes, access windows, who is home — answered from the job. A change to an accepted bid is priced against the job and routed to your queue with the amount spelled out.",
  },
  {
    id: "queue",
    kicker: "04 · One queue",
    title: "Everything the AI did, in one list.",
    body: "Tours booked, vendors dispatched, replies sent — every automated action lands on your dashboard, with the handful that need a decision flagged. The same list is on your phone.",
  },
];

/* ── the frame: inbox panes ──────────────────────────────────────── */

type Channel = "In-app" | "Email" | "Text";

type Msg =
  | { kind: "in"; text: string; when: string; channel: "TEXT" | "EMAIL" }
  | { kind: "out"; text: string; when: string; channel: "TEXT" | "EMAIL"; auto?: string }
  | { kind: "sys"; text: string };

type InboxPane = {
  id: Exclude<StepId, "queue">;
  contact: { initials: string; name: string; sub: string; vendor?: boolean };
  channel: Channel;
  messages: Msg[];
  draft: string;
  /** What "Ask PropLane" answers about this thread. */
  asked: string;
};

const CONVERSATIONS: { initials: string; name: string; sub: string; id: StepId | null; vendor?: boolean }[] = [
  { initials: "JP", name: "Jamie P.", sub: "Ash Flats 6 · Tour", id: "prospect" },
  { initials: "DR", name: "Dana Reyes", sub: "Maple 2A · Repair", id: "resident" },
  { initials: "PP", name: "Pacific Plumbing", sub: "Job #1042", id: "vendor", vendor: true },
  { initials: "EW", name: "Ethan Wright", sub: "Application fee", id: null },
];

const INBOX_PANES: InboxPane[] = [
  {
    id: "prospect",
    contact: { initials: "JP", name: "Jamie P.", sub: "+1 (206) 555-0147 · prospect · Ash Flats 6" },
    channel: "Text",
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
    asked: "Room 6A is open from Oct 1 · Saturday has 3 free slots · no other tours that day.",
  },
  {
    id: "resident",
    contact: { initials: "DR", name: "Dana Reyes", sub: "dana.reyes@… · resident · Maple 2A" },
    channel: "Email",
    messages: [
      { kind: "in", text: "Hi, the kitchen faucet in Maple 2A has been dripping for two days. Can someone take a look?", when: "Tue 8:41 AM", channel: "EMAIL" },
      { kind: "sys", text: "Service request #1042 created · Plumbing · Maple 2A · Pacific Plumbing booked Thu 10–12 (approved vendor · 4.9 · $140 typical)" },
    ],
    draft: "Thanks Dana — Pacific Plumbing is booked for Thursday between 10 and 12. They'll text you before they arrive. If that window doesn't work, reply here.",
    asked: "Pacific Plumbing has done 4 jobs at Maple — all rated 5 · next open slot Thu 10–12.",
  },
  {
    id: "vendor",
    contact: { initials: "PP", name: "Pacific Plumbing", sub: "+1 (206) 555-0188 · vendor · job #1042", vendor: true },
    channel: "Text",
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
      { kind: "sys", text: "Change order · $140 → $230 · routed to your queue with the valve priced against the job." },
    ],
    draft: "Go ahead with the valve — $90 added, $230 total. Send a photo of the old one for the file.",
    asked: "Bid on job #1042 was $140 · a valve typically adds $80–110 · resident is home until noon.",
  },
];

const QUEUE_ROWS = [
  { title: "PropLane · Tour booked with Jamie P.", sub: "Sat 2:00 PM · Room 6A · reminder set for Friday", done: true },
  { title: "PropLane · Pacific Plumbing dispatched to Maple 2A", sub: "Service request #1042 · Thu 10–12 · resident notified", done: true },
  { title: "PropLane · $90 change order on job #1042", sub: "Pacific Plumbing · bid $140 → $230 · needs a decision", done: false },
];

/** The portal's control labels, exported so the unit test can pin them. */
export const STORY_PORTAL_LABELS = {
  generate: "Draft with AI",
  ask: "Ask PropLane",
  channels: ["In-app", "Email", "Text"] as const,
  send: "Send",
  schedule: "Schedule",
  queue: "Everything open",
  approve: "Approve",
  discard: "Discard",
};

const CHANNEL_CHIP: Record<Channel, string> = { "In-app": "IN-APP", Email: "EMAIL", Text: "TEXT" };
const SENDING_AS: Record<Channel, string> = { "In-app": "Sending as PropLane", Email: "Sending as you@prop-lane.space", Text: "Sending as (206) 555-0100" };

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

const TOOL_BTN =
  "grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-border bg-card text-[13px] text-foreground transition hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30";

/** One playable inbox. State is local; nothing leaves the page. */
function InboxFrame({ pane, onPick }: { pane: InboxPane; onPick: (id: StepId) => void }) {
  const [sent, setSent] = useState<{ text: string; channel: Channel; scheduled: boolean }[]>([]);
  const [typed, setTyped] = useState("");
  const [typing, setTyping] = useState(false);
  const [menu, setMenu] = useState<"ai" | "channel" | null>(null);
  const [channel, setChannel] = useState<Channel>(pane.channel);
  const [scheduled, setScheduled] = useState(false);
  const [asked, setAsked] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current) window.clearInterval(timer.current);
    },
    [],
  );

  function draftWithAi() {
    setMenu(null);
    if (typing || typed) return;
    setTyping(true);
    let i = 0;
    timer.current = window.setInterval(() => {
      i += 3;
      setTyped(pane.draft.slice(0, i));
      if (i >= pane.draft.length) {
        setTyped(pane.draft);
        setTyping(false);
        if (timer.current) window.clearInterval(timer.current);
      }
    }, 18);
  }

  function send() {
    if (!typed || typing) return;
    setSent((s) => [...s, { text: typed, channel, scheduled }]);
    setTyped("");
    setScheduled(false);
    setMenu(null);
  }

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
          <button
            type="button"
            key={c.name}
            onClick={() => c.id && onPick(c.id)}
            disabled={!c.id}
            className={cn(
              "flex w-full gap-2 border-b border-border px-2.5 py-2 text-left transition hover:bg-accent/60 disabled:cursor-default disabled:hover:bg-transparent",
              c.id === pane.id && "border-l-[3px] border-l-primary bg-primary/[0.06] pl-[7px]",
            )}
          >
            <Avatar initials={c.initials} vendor={c.vendor} />
            <span className="min-w-0">
              <span className="block truncate text-[12px] font-bold text-foreground">{c.name}</span>
              <span className="block truncate text-[10.5px] text-muted">{c.sub}</span>
            </span>
          </button>
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

        <div className="flex flex-1 flex-col gap-2.5 overflow-y-auto bg-[var(--pl-surface)] px-3.5 py-3">
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
                  <p className={cn("rounded-2xl px-3 py-2 text-[12px] leading-snug", out ? "rounded-br-sm bg-primary text-white" : "rounded-tl-sm bg-[#eef2ff] text-foreground")}>
                    {m.text}
                  </p>
                  <p className={cn("mt-1 flex items-center gap-1.5 text-[10px] text-muted", out && "justify-end")}>
                    {!out ? <ChannelChip>{m.channel}</ChannelChip> : null}
                    <span>{m.when}</span>
                    {out ? <ChannelChip>{m.channel}</ChannelChip> : null}
                    {out && m.auto ? <span className="font-bold text-[#1e4fd6]">✦ {m.auto}</span> : null}
                  </p>
                </div>
              </div>
            );
          })}
          {sent.map((m, i) => (
            <div key={`sent-${i}`} className="site-story-sent ml-auto flex max-w-[88%] justify-end gap-2">
              <div>
                <p className="rounded-2xl rounded-br-sm bg-primary px-3 py-2 text-[12px] leading-snug text-white">{m.text}</p>
                <p className="mt-1 flex items-center justify-end gap-1.5 text-[10px] text-muted">
                  <span>{m.scheduled ? "Scheduled · tomorrow 9:00 AM" : "Just now"}</span>
                  <ChannelChip>{CHANNEL_CHIP[m.channel]}</ChannelChip>
                </p>
              </div>
            </div>
          ))}
          {asked ? (
            <p className="mx-auto max-w-[90%] rounded-lg border border-primary/20 bg-primary/[0.04] px-2.5 py-1.5 text-center text-[11px] text-foreground">
              ✦ {pane.asked}
            </p>
          ) : null}
        </div>

        {scheduled ? (
          <p className="flex items-center gap-2 border-t border-border bg-card px-3 py-1.5 text-[11px] text-muted">
            <span aria-hidden>🕒</span> Sends tomorrow at 9:00 AM — the button now schedules.
          </p>
        ) : null}

        {/* One composer row — attach · reply · ✦ AI · 🕒 schedule · channel menu · Send. */}
        <div className="relative flex items-center gap-2 border-t border-border bg-card px-3 py-2.5">
          <i className={cn(TOOL_BTN, "text-muted")} aria-hidden>
            ⊕
          </i>
          <div className={cn("min-h-[40px] flex-1 rounded-2xl border border-border px-3 py-2 text-[12px] leading-snug", typed ? "text-foreground" : "text-muted")}>
            {typed || "Write a reply…"}
            {typing ? <span className="site-story-caret" aria-hidden /> : null}
          </div>
          <button
            type="button"
            onClick={() => setMenu(menu === "ai" ? null : "ai")}
            className={cn(TOOL_BTN, "text-primary", menu === "ai" && "border-primary bg-primary/10")}
            aria-label="AI"
            aria-expanded={menu === "ai"}
            data-attr="story-ai"
          >
            ✦
          </button>
          <button
            type="button"
            onClick={() => {
              setScheduled((s) => !s);
              setMenu(null);
            }}
            className={cn(TOOL_BTN, scheduled && "border-primary bg-primary/10 text-primary")}
            aria-label={STORY_PORTAL_LABELS.schedule}
            aria-pressed={scheduled}
            data-attr="story-schedule"
          >
            🕒
          </button>
          <button
            type="button"
            onClick={() => setMenu(menu === "channel" ? null : "channel")}
            className="hidden h-9 items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 text-[12px] font-semibold text-foreground transition hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 sm:inline-flex"
            aria-label={`Channel: ${channel}`}
            aria-expanded={menu === "channel"}
            data-attr="story-channel"
          >
            <span aria-hidden>▭</span> {channel}{" "}
            <span aria-hidden className="text-[10px] text-muted">
              ▾
            </span>
          </button>
          <button
            type="button"
            onClick={send}
            disabled={!typed || typing}
            className={cn(
              "grid h-9 w-9 shrink-0 place-items-center rounded-full text-[12px] text-white transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30",
              typed && !typing ? "bg-primary hover:brightness-110" : "bg-primary/40",
            )}
            aria-label={scheduled ? STORY_PORTAL_LABELS.schedule : STORY_PORTAL_LABELS.send}
            data-attr="story-send"
          >
            ➤
          </button>

          {menu === "ai" ? (
            <div className="site-story-menu" style={{ right: 96 }}>
              <button type="button" onClick={draftWithAi} className="site-story-menu-item" data-attr="story-draft">
                <b>✦ {STORY_PORTAL_LABELS.generate}</b>
                <span>Reply from this conversation and the record</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setAsked(true);
                  setMenu(null);
                }}
                className="site-story-menu-item"
                data-attr="story-ask"
              >
                <b>✦ {STORY_PORTAL_LABELS.ask}</b>
                <span>Ask about this thread — nothing is sent</span>
              </button>
            </div>
          ) : null}
          {menu === "channel" ? (
            <div className="site-story-menu" style={{ right: 52 }} role="menu">
              {STORY_PORTAL_LABELS.channels.map((c) => (
                <button
                  type="button"
                  key={c}
                  onClick={() => {
                    setChannel(c);
                    setMenu(null);
                  }}
                  className="site-story-menu-item"
                  role="menuitemradio"
                  aria-checked={c === channel}
                >
                  <b>
                    {c === channel ? "✓ " : ""}
                    {c}
                  </b>
                  <span>{SENDING_AS[c]}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <p className="border-t border-border bg-[var(--pl-surface)] px-3 py-1 text-[10px] text-muted">
          Try it: ✦ → {STORY_PORTAL_LABELS.generate}, pick a channel, then {STORY_PORTAL_LABELS.send}.
        </p>
      </div>
    </div>
  );
}

function QueueFrame() {
  const [rows, setRows] = useState(QUEUE_ROWS.map((r) => ({ ...r, resolved: null as null | "approved" | "discarded" })));
  const open = rows.filter((r) => !r.done && !r.resolved).length;
  return (
    <div className="site-story-dash" data-story-pane="queue">
      <div className="mb-3 flex items-center gap-2.5">
        <span className="text-[16px] font-bold text-foreground">✦ {STORY_PORTAL_LABELS.queue}</span>
        <span className="rounded-full border border-border bg-card px-2 py-0.5 text-[11px] text-muted">● {open} open</span>
      </div>
      <div className="overflow-hidden rounded-lg border border-border border-l-[3px] border-l-primary bg-card">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
          <span className="text-muted" aria-hidden>
            ⌄
          </span>
          <span className="text-[13px] font-bold text-primary">Today</span>
          <span className="ml-auto rounded-full bg-primary/10 px-1.5 text-[11px] font-bold text-primary">{rows.length}</span>
        </div>
        {rows.map((d, i) => (
          <div key={d.title} className={cn("flex items-center gap-2.5 border-b border-border px-3 py-2.5 last:border-b-0", d.resolved && "opacity-70")}>
            <i className={cn("h-1.5 w-1.5 shrink-0 rounded-full", d.done || d.resolved === "approved" ? "bg-[#15803d]" : d.resolved ? "bg-[#c3c7cf]" : "bg-[#f59e0b]")} aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12.5px] font-semibold text-foreground">{d.title}</span>
              <span className="block truncate text-[11px] text-muted">
                {d.resolved === "approved" ? "Approved — vendor told, ledger updated" : d.resolved === "discarded" ? "Discarded — nothing sent" : d.sub}
              </span>
            </span>
            {d.done ? (
              <span className="rounded-full bg-[#e8f7ee] px-2.5 py-1 text-[11px] font-bold text-[#15803d]">Done</span>
            ) : d.resolved ? (
              <span className="rounded-full border border-border px-2.5 py-1 text-[11px] font-bold text-muted">{d.resolved === "approved" ? "Approved" : "Discarded"}</span>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => setRows((r) => r.map((x, j) => (j === i ? { ...x, resolved: "approved" } : x)))}
                  className="rounded-full bg-primary px-3 py-1.5 text-[11.5px] font-bold text-white hover:brightness-110"
                  data-attr="story-approve"
                >
                  {STORY_PORTAL_LABELS.approve}
                </button>
                <button
                  type="button"
                  onClick={() => setRows((r) => r.map((x, j) => (j === i ? { ...x, resolved: "discarded" } : x)))}
                  className="rounded-full border border-border px-3 py-1.5 text-[11.5px] font-bold text-foreground hover:bg-accent"
                  data-attr="story-discard"
                >
                  {STORY_PORTAL_LABELS.discard}
                </button>
              </>
            )}
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

  function pick(id: StepId) {
    setActive(id);
    stepRefs.current[id]?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  return (
    <SiteSection id="product" tone="muted" ariaLabelledBy="site-story-title" className="site-story-band">
      <SiteIntro
        eyebrow="The feature · try it"
        id="site-story-title"
        title="Every message answered. Every workflow run."
        lede="Prospects, residents and vendors all write to one inbox. PropLane answers from your listings, leases and jobs, books the tour, dispatches the vendor, writes back — and lands it all in one queue. The frame on the right is live: press ✦."
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
              {s.id === "queue" ? (
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

        <div className="site-story-frame">
          <div className="flex items-center gap-1.5 border-b border-border bg-[#f1f3f7] px-3 py-2 text-[11px] text-muted">
            <i className="h-2.5 w-2.5 rounded-full bg-[#d9dde5]" aria-hidden />
            <i className="h-2.5 w-2.5 rounded-full bg-[#d9dde5]" aria-hidden />
            <i className="h-2.5 w-2.5 rounded-full bg-[#d9dde5]" aria-hidden />
            <span className="ml-2 rounded-md bg-card px-2.5 py-0.5">prop-lane.space/portal/{active === "queue" ? "dashboard" : "communication"}</span>
          </div>
          {INBOX_PANES.map((p) => (
            <div key={p.id} className="site-story-pane" hidden={active !== p.id}>
              <InboxFrame pane={p} onPick={pick} />
            </div>
          ))}
          <div className="site-story-pane" hidden={active !== "queue"}>
            <QueueFrame />
          </div>
        </div>
      </div>

      <p className="mt-10 flex flex-wrap items-center gap-2 text-[13px] text-muted">
        <span className="mr-1 text-[11px] font-extrabold uppercase tracking-[0.12em] text-muted">Also inside</span>
        {["Listings", "Tours", "Applications", "Leases & e-sign", "Payments & ledger", "Services", "Inspections", "Tasks", "Calendar"].map((label) => (
          <span key={label} className="rounded-full border border-border bg-card px-2.5 py-1 text-foreground">
            {label}
          </span>
        ))}
        <Link href="/partner" data-attr="home-story-see-everything" className="font-bold text-primary hover:underline">
          See everything →
        </Link>
      </p>
    </SiteSection>
  );
}
