"use client";

import { useEffect, useRef, useState } from "react";
import {
  createTimerPool,
  useAutoplayGate,
  usePrefersReducedMotion,
} from "@/components/marketing/use-marketing-demo";
import "./landing-proplane.css";

/**
 * Presentational, self-playing "approval-first inbox" showcase.
 *
 * LEFT: a compact manager inbox list of incoming resident messages with live
 * relative timestamps. RIGHT: the selected thread with the resident's message
 * and a PropLane AI reply that streams into a dashed draft box, followed by
 * Approve & Send / Edit / Discard. It auto-cycles through the items on a timed
 * loop and honors prefers-reduced-motion (static final state, no streaming).
 *
 * Nothing here calls an API or moves money — it is a scripted marketing demo
 * mirroring how the real manager inbox drafts replies you approve before they
 * ever send. Distinct from LandingDashboardChatDemo (chat → dashboard).
 */

type InboxItem = {
  id: string;
  initials: string;
  name: string;
  unit: string;
  subject: string;
  tag: string;
  /** Minutes-ago anchor for the live relative timestamp (0 renders as "now"). */
  baseMinutes: number;
  body: string;
  draft: string;
};

/** Realistic PropLane property-management scenarios, all approval-first, em-dash-free. */
const ITEMS: InboxItem[] = [
  {
    id: "maple-2a-faucet",
    initials: "DR",
    name: "Dana Reyes",
    unit: "Maple 2A",
    subject: "Kitchen faucet still dripping",
    tag: "Maintenance",
    baseMinutes: 0,
    body: "Hi, the kitchen faucet in Maple 2A has been dripping for two days now and it is getting worse. Can someone take a look this week?",
    draft:
      "Hi Dana, thanks for flagging this. I am lining up a plumber for Maple 2A and will confirm a visit window within the next two business days, then follow up here once it is booked. Nothing is scheduled until you approve this reply.",
  },
  {
    id: "rent-split",
    initials: "MK",
    name: "Marcus Kim",
    unit: "Cascade 4B",
    subject: "Splitting this month's rent",
    tag: "Payments",
    baseMinutes: 2,
    body: "Is there any way to split this month's rent into two payments? Money is a little tight this pay period.",
    draft:
      "Hi Marcus, I understand. You can request a short payment plan and I will review it with you. Reply with the two dates and amounts that work best and I will confirm what we can set up. This is a draft and only goes out once it is approved.",
  },
  {
    id: "lease-renewal",
    initials: "PA",
    name: "Priya Anand",
    unit: "Ballard 1C",
    subject: "Lease renewal timing",
    tag: "Leasing",
    baseMinutes: 5,
    body: "Is my lease up for renewal soon? I want to plan ahead and understand what the next term looks like.",
    draft:
      "Hi Priya, your current lease is coming up for renewal. I will send over your renewal date and the options for the next term so you can review them, and we can talk it through first if you like. Sending stays on hold until you approve.",
  },
  {
    id: "ballard-app",
    initials: "JT",
    name: "Jordan Tran",
    unit: "Ballard unit",
    subject: "Update on my application",
    tag: "Applications",
    baseMinutes: 8,
    body: "Any update on my application for the Ballard unit? Just checking in on where things stand.",
    draft:
      "Hi Jordan, thanks for checking in. Your application for the Ballard unit is in review and screening is underway. I will reach out with the next step as soon as it is complete. This reply is pending my approval before it reaches you.",
  },
];

type Phase = "reading" | "drafting" | "review";

function relativeLabel(baseMinutes: number, tickMinutes: number) {
  const total = baseMinutes + tickMinutes;
  if (total <= 0) return "now";
  if (total < 60) return `${total}m`;
  const hours = Math.floor(total / 60);
  return `${hours}h`;
}

export function LandingInboxApproveDemo() {
  const { ref: rootRef, playing } = useAutoplayGate<HTMLElement>(0.25);
  const [idx, setIdx] = useState(0);
  const [phase, setPhase] = useState<Phase>("reading");
  const [draftText, setDraftText] = useState("");
  const [tickMinutes, setTickMinutes] = useState(0);
  /** User took manual control — auto-advance stops so we never fight them. */
  const [paused, setPaused] = useState(false);
  const [approvedId, setApprovedId] = useState<string | null>(null);
  const [liveAnnouncement, setLiveAnnouncement] = useState("");
  /** Announce a completed draft to screen readers once, not on every cycle. */
  const announcedRef = useRef(false);
  const reducedMotion = usePrefersReducedMotion();

  const current = ITEMS[idx] ?? ITEMS[0];

  // Live relative timestamps: gently age the inbox only while it is playing.
  useEffect(() => {
    if (!playing || reducedMotion) return;
    const timer = window.setInterval(() => {
      setTickMinutes((m) => (m >= 59 ? m : m + 1));
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [playing, reducedMotion]);

  // Reduced motion: render the first item's final, approvable state statically.
  useEffect(() => {
    if (!reducedMotion) return;
    setIdx(0);
    setPhase("review");
    setDraftText(ITEMS[0].draft);
    if (!announcedRef.current) {
      setLiveAnnouncement(
        `Resident ${ITEMS[0].name}: ${ITEMS[0].body}. PropLane AI drafted a reply pending your approval.`,
      );
      announcedRef.current = true;
    }
  }, [reducedMotion]);

  // Self-playing loop: select → read → stream draft → rest on approve → advance.
  // Pauses (cleanup) whenever the section scrolls off screen or the tab is
  // backgrounded, so it never streams setState into an unseen section.
  useEffect(() => {
    if (!playing || reducedMotion || paused) return;

    const pool = createTimerPool();

    const streamDraft = async (full: string, charMs = 14) => {
      setDraftText("");
      for (let i = 1; i <= full.length; i++) {
        if (pool.cancelled) return;
        setDraftText(full.slice(0, i));
        await pool.wait(charMs);
      }
    };

    const runItem = async (i: number) => {
      const item = ITEMS[i];
      setIdx(i);
      setApprovedId(null);
      setDraftText("");
      setPhase("reading");
      await pool.wait(1000);
      if (pool.cancelled) return;

      setPhase("drafting");
      await streamDraft(item.draft);
      if (pool.cancelled) return;
      if (!announcedRef.current) {
        setLiveAnnouncement(
          `Resident ${item.name}: ${item.body}. PropLane AI drafted a reply pending your approval.`,
        );
        announcedRef.current = true;
      }
      await pool.wait(500);

      setPhase("review");
      await pool.wait(3400);
    };

    void (async () => {
      let i = idx;
      while (!pool.cancelled) {
        await runItem(i);
        if (pool.cancelled) break;
        await pool.wait(700);
        i = (i + 1) % ITEMS.length;
      }
    })();

    return () => pool.cancel();
    // idx intentionally omitted: the loop owns idx after the first run, and
    // including it would restart the loop on every advance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, reducedMotion, paused]);

  // Manual selection: pause auto-play and show that item's approvable state.
  const selectItem = (i: number) => {
    setPaused(true);
    setIdx(i);
    setApprovedId(null);
    setDraftText(ITEMS[i].draft);
    setPhase("review");
  };

  const isStreaming = phase === "drafting";
  // Actions only appear on a fully-drafted reply — never during the read/stream
  // gap, so there is no frame where buttons show above an empty draft box.
  const showActions = phase === "review" && draftText.length > 0;
  const isApproved = approvedId === current.id;

  return (
    <section
      ref={rootRef}
      id="approval-inbox"
      className="lp-ibx-demo scroll-mt-20"
      aria-label="Approval-first manager inbox demo"
    >
      <div className="lp-w-wide">
        <header className="lp-dash-demo-intro">
          <h2>Your AI front office. You stay in control.</h2>
          <p>
            PropLane reads every resident message and drafts a reply in your voice. You approve, edit, or
            discard. Nothing sends until you say so.
          </p>
        </header>

        <div className="lp-dash-demo-stage" data-attr="home-inbox-approve-demo">
          <div className="lp-dash-demo-chrome">
            <i />
            <i />
            <i />
            <span style={{ marginLeft: 8 }}>Inbox · Manager</span>
            <span className="lp-ml">{paused ? "You're in control" : "Approval-first"}</span>
          </div>

          {/* Announce completed drafts only, never per-character streaming. */}
          <div className="sr-only" aria-live="polite" aria-atomic="true">
            {liveAnnouncement}
          </div>

          <div className="lp-ibx-split">
            <aside className="lp-ibx-list" aria-label="Resident inbox">
              <div className="lp-ibx-list-head">
                <span className="lp-ibx-list-title">Inbox</span>
                <span className="lp-ibx-list-count">4 of 24</span>
              </div>
              <ul className="lp-ibx-rows" role="list">
                {ITEMS.map((item, i) => {
                  const selected = i === idx;
                  return (
                    <li key={item.id}>
                      <button
                        type="button"
                        className={`lp-ibx-row${selected ? " lp-ibx-row--active" : ""}`}
                        aria-current={selected ? "true" : undefined}
                        aria-label={`${item.name}, ${item.subject}, ${relativeLabel(
                          item.baseMinutes,
                          tickMinutes,
                        )} ago`}
                        data-attr="inbox-demo-thread"
                        onClick={() => selectItem(i)}
                      >
                        <span className="lp-ibx-av" aria-hidden>
                          {item.initials}
                        </span>
                        <span className="lp-ibx-row-main">
                          <span className="lp-ibx-row-top">
                            <span className="lp-ibx-row-name">{item.name}</span>
                            <span className="lp-ibx-row-time">
                              {relativeLabel(item.baseMinutes, tickMinutes)}
                            </span>
                          </span>
                          <span className="lp-ibx-row-sub">{item.subject}</span>
                        </span>
                        {!selected && i === 0 && !paused ? (
                          <span className="lp-ibx-dot" aria-hidden />
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </aside>

            <div className="lp-ibx-thread" aria-live="off">
              <div className="lp-ibx-thread-head">
                <span className="lp-ibx-av lp-ibx-av--lg" aria-hidden>
                  {current.initials}
                </span>
                <div className="min-w-0">
                  <p className="lp-ibx-thread-name">{current.name}</p>
                  <p className="lp-ibx-thread-meta">
                    {current.unit} · {current.tag}
                  </p>
                </div>
                <span className="lp-ibx-thread-time">
                  {relativeLabel(current.baseMinutes, tickMinutes)}
                </span>
              </div>

              <div className="lp-ibx-thread-body" tabIndex={0} role="region" aria-label="Message thread">
                <div className="lp-ibx-msg">{current.body}</div>

                <div
                  className={`lp-ibx-draft${isStreaming ? " lp-ibx-draft--live" : ""}`}
                  aria-busy={isStreaming || undefined}
                >
                  <div className="lp-ibx-draft-head">
                    <span className="lp-ibx-ai-mark" aria-hidden>
                      ✦
                    </span>
                    <span className="lp-ibx-ai-name">PropLane AI</span>
                    <span className="lp-ibx-draft-tag">
                      {isApproved ? "Approved" : "Draft · pending approval"}
                    </span>
                  </div>
                  <p className="lp-ibx-draft-text">
                    {draftText}
                    {isStreaming ? <span className="lp-caret" aria-hidden /> : null}
                  </p>
                </div>

                <div className="lp-ibx-actions" data-visible={showActions ? "true" : "false"}>
                  {isApproved ? (
                    <span className="lp-ibx-sent" role="status">
                      <span className="lp-ibx-check" aria-hidden>
                        ✓
                      </span>
                      Sent for you · logged to the thread
                    </span>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="lp-ibx-btn lp-ibx-btn--primary"
                        data-attr="inbox-demo-approve"
                        onClick={() => {
                          setPaused(true);
                          setApprovedId(current.id);
                        }}
                      >
                        <span aria-hidden>✓</span> Approve &amp; Send
                      </button>
                      <button
                        type="button"
                        className="lp-ibx-btn"
                        data-attr="inbox-demo-edit"
                        onClick={() => setPaused(true)}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="lp-ibx-btn lp-ibx-btn--ghost"
                        data-attr="inbox-demo-discard"
                        onClick={() => setPaused(true)}
                      >
                        Discard
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
