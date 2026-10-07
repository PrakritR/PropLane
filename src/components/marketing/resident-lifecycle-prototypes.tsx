"use client";

/**
 * The home page hero and the guided demo beneath it (captain 2026-10-06, revised
 * 2026-10-07).
 *
 * The hero is the two-line headline and three buttons, with the demo window right
 * under them. The demo plays itself in four beats (`resident-lifecycle-script.ts`), and
 * the manager's beats are CAUSAL: a "Manager" cursor glides to a real control (found by
 * `data-demo-target`), hovers it, clicks it, and only then does the phone beside the
 * window receive what that click sent (the tour confirmation after Approve, the apply
 * link after Send application, the lease after Send lease, the reminder after Send
 * reminder). The resident's own replies (texting, applying, signing, paying) arrive on
 * the phone and move the rows in the panels, and the cursor follows them: it opens the
 * new application, countersigns, dispatches the plumber. There is no stage UI on screen;
 * the visitor changes portal from the window's own account menu, exactly as a multi-role
 * user does in the real portal. Every sidebar item opens the real panel for that tab
 * (`DemoPanel`, `site/product-mock/demo-panels.tsx`); clicking one pins that tab (the
 * cursor leaves, the window stops autoplaying) while the phone keeps going.
 *
 * ONE phone stays on screen down the page (sticky from the `lg` breakpoint, inline under
 * the window below it) through the hero, the demo and the lifecycle rows, which arrive as
 * `children`. Everything on screen is the fold of the timeline steps that are done
 * (`stateAfter`); the step in flight is the only thing the engine owns. Nothing here
 * touches the network or saves: it is a sample.
 *
 * The clock pauses while the pointer or focus is inside the window and while the account
 * menu is open, and never runs under prefers-reduced-motion (the first beat shows, still,
 * with no cursor). The window also grows from about 88% to full size as the page scrolls
 * through the first 60% of the viewport (transform only; off under reduced motion).
 */

import "./resident-lifecycle-prototypes.css";
import "./resident-lifecycle-engine.css";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { AppStoreBadge } from "@/components/marketing/app-store-badge";
import { BOOK_DEMO_HREF, GET_STARTED_HREF } from "@/lib/marketing/public-contact";
import { DEMO_TABS, DemoPanel, type DemoPortal } from "@/components/marketing/site/product-mock/demo-panels";
import { worldFor } from "@/components/marketing/site/product-mock/world";
import { DemoCursor, SETTLE_MS, sleep, type DemoCursorApi } from "./resident-lifecycle-cursor";
import { ManagerCommunication } from "./resident-lifecycle-manager";
import { ResidentLifecyclePhone } from "./resident-lifecycle-phone";
import { ResidentLifecycleWorkspace } from "./resident-lifecycle-workspace";
import {
  COMMUNICATION_THREADS,
  DRAFT_REPLY,
  PHONE_META,
  STORIES,
  framesFor,
  managerMessages,
  mirrorItems,
  stateAfter,
  stateAtBeat,
  storyFor,
  threadItems,
  timelineFor,
} from "./resident-lifecycle-script";

/** The hero window starts at GROW_FROM of its size and reaches full size after GROW_OVER of the viewport height. */
const GROW_FROM = 0.88;
const GROW_OVER = 0.6;

/** The role the cursor wears. Only the manager's window has one (the resident and vendor windows are told by the phone). */
const CURSOR_LABEL = "Manager";

const MemoPanel = memo(DemoPanel);

export function ResidentLifecyclePrototypes({ children }: { children?: ReactNode }) {
  const [portal, setPortal] = useState<DemoPortal>("manager");
  /** The timeline step in flight; everything before it is done. */
  const [index, setIndex] = useState(0);
  /** A sidebar click pins a tab: the window stops following the story and the cursor leaves. */
  const [tabOverride, setTabOverride] = useState<string | null>(null);
  const [reduced, setReduced] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<DemoCursorApi>(null);
  /** The click step whose real click already happened (a pause and resume must not click twice). */
  const clicked = useRef(-1);
  /** True while the cursor's own click is dispatching, so a control's handler can tell it from a visitor's. */
  const scripting = useRef(false);

  const steps = useMemo(() => timelineFor(portal), [portal]);
  const frames = useMemo(() => framesFor(portal), [portal]);
  const step = steps[Math.min(index, steps.length - 1)]!;
  // Reduced motion: no clock. The first beat shows, with its messages already there and nothing typing.
  const state = useMemo(() => (reduced ? stateAtBeat(portal, 0) : stateAfter(portal, index)), [reduced, portal, index]);
  const beat = reduced ? 0 : step.beat;
  const stageId = STORIES[portal][beat]!.id;
  const typing = !reduced && step.kind === "say";
  const activeTab = tabOverride ?? state.tab;
  const story = useMemo(() => storyFor(portal, state, beat), [portal, state, beat]);
  const playing = !reduced && !hovered && !focused && !menuOpen;
  const cursorOn = portal === "manager" && !reduced && tabOverride === null;
  const isCommunication = portal === "manager" && activeTab === "communication";
  const sidebarBadges = useMemo(
    () => (portal === "manager" ? { ...worldFor(story).badges, communication: COMMUNICATION_THREADS.length } : undefined),
    [portal, story],
  );

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduced(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  // The clock: run the step in flight, then the next; after the last, start over.
  useEffect(() => {
    if (!playing) return;
    let cancelled = false;
    const api = cursorRef.current;
    const finish = () => {
      if (cancelled) return;
      setIndex((current) => {
        if (current + 1 < steps.length) return current + 1;
        clicked.current = -1;
        return 0;
      });
    };
    const run = async () => {
      if ((step.kind !== "nav" && step.kind !== "click") || !cursorOn || !api) {
        await sleep(step.ms);
        return finish();
      }
      const target = await api.find(step.kind === "nav" ? `nav-${step.target}` : step.target!);
      if (cancelled) return;
      // A control that never renders (a visitor opened something else) must not stall the story.
      if (!target) return finish();
      await api.moveTo(target);
      if (cancelled) return;
      await api.press();
      if (cancelled) return;
      if (step.kind === "click" && clicked.current !== index) {
        clicked.current = index;
        scripting.current = true;
        target.click();
        scripting.current = false;
      }
      target.removeAttribute("data-demo-hover");
      // The window answers the click before the cursor moves on.
      await sleep(SETTLE_MS);
      finish();
    };
    void run();
    return () => {
      cancelled = true;
      api?.clearHover();
    };
  }, [playing, index, step, steps, cursorOn]);

  // The cursor leaves when the window stops following the story, and when the story starts over.
  useEffect(() => {
    if (!cursorOn || index === 0) cursorRef.current?.hide();
  }, [cursorOn, index]);

  // The scroll growth: the window grows from GROW_FROM to full size over the first GROW_OVER of the viewport.
  useEffect(() => {
    const stageEl = stageRef.current;
    if (!stageEl || reduced) return;
    let frame = 0;
    const apply = () => {
      frame = 0;
      const progress = Math.min(1, Math.max(0, window.scrollY / (window.innerHeight * GROW_OVER)));
      stageEl.style.setProperty("--rlp-grow", String(GROW_FROM + (1 - GROW_FROM) * progress));
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(apply);
    };
    apply();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [reduced]);

  const switchPortal = (nextPortal: DemoPortal) => {
    setPortal(nextPortal);
    setIndex(0);
    clicked.current = -1;
    setTabOverride(null);
    // The menu item that was focused is gone; no blur follows its removal.
    setFocused(false);
  };

  // A visitor approving the draft by hand takes the story to where the cursor's own click would have.
  const approveDraft = useCallback(() => {
    if (scripting.current) return;
    const at = steps.findIndex((candidate) => candidate.target === "comm-approve");
    if (at >= 0) setIndex((current) => (current <= at ? at + 1 : current));
  }, [steps]);

  // The phone: the lines so far from its owner's side, drawn from the other side for the resident portal.
  const meta = PHONE_META[portal];
  const owned = threadItems(portal, state.shown);
  const items = meta.mirror ? mirrorItems(owned) : owned;
  const upcoming = typing ? frames[state.shown]?.message.kind : undefined;
  const typingSide = upcoming ? (meta.mirror ? (upcoming === "in" ? "out" : "in") : upcoming) : null;

  return (
    <div className="rlp-page">
      <section id="resident-lifecycle-walkthrough" className="rlp-hero" aria-labelledby="rlp-hero-title">
        <div className="rlp-hero-copy">
          <h1 id="rlp-hero-title">
            <span className="rlp-h1-line">Your AI property</span>{" "}
            <br />
            <span className="rlp-h1-line">management assistant.</span>
          </h1>
          <div className="rlp-hero-actions">
            <Link href={GET_STARTED_HREF} data-attr="home-hero-get-started">
              Start free - no card
            </Link>
            <Link href={BOOK_DEMO_HREF} data-attr="home-hero-book-demo">
              Book a demo
            </Link>
            <AppStoreBadge tone="dark" size="lg" dataAttr="home-hero-app-store" className="rlp-app-store" />
          </div>
        </div>
      </section>
      <div className="rlp-story">
        <div className="rlp-hero-stage" ref={stageRef}>
          <div
            id="rlp-demo-stage"
            role="group"
            aria-label="Sample PropLane workspace"
            className="rlp-dual-view"
            data-demo-beat={beat}
            data-demo-portal={portal}
            data-demo-cursor={cursorOn ? "on" : "off"}
            onPointerEnter={() => setHovered(true)}
            onPointerLeave={() => setHovered(false)}
            // Only keyboard focus pauses the story: a mouse click on the sidebar must not freeze the phone.
            onFocus={(event) => {
              if (event.target.matches(":focus-visible")) setFocused(true);
            }}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
            }}
          >
            {portal === "manager" && !reduced ? <DemoCursor label={CURSOR_LABEL} apiRef={cursorRef} /> : null}
            <ResidentLifecycleWorkspace
              portal={portal}
              tabs={DEMO_TABS[portal]}
              active={activeTab}
              badges={sidebarBadges}
              onSelect={setTabOverride}
              onSwitchPortal={switchPortal}
              onMenuOpenChange={setMenuOpen}
              panel={!isCommunication}
            >
              {isCommunication ? (
                <ManagerCommunication
                  messages={managerMessages(state.shown)}
                  typing={typing}
                  draft={state.draft ? DRAFT_REPLY : null}
                  onApprove={approveDraft}
                  onReply={() => true}
                />
              ) : (
                <div className="rlp-panel-frame" data-demo-panel={`${portal}:${activeTab}`}>
                  <MemoPanel key={`${portal}-${activeTab}`} portal={portal} tab={activeTab} story={story} stage={stageId} />
                </div>
              )}
            </ResidentLifecycleWorkspace>
          </div>
        </div>
        <aside className="rlp-story-rail" aria-label="Sample phone">
          <div className="rlp-story-phone-slot">
            <div className="rlp-story-phone">
              <ResidentLifecyclePhone caption={meta.caption} contact={meta} items={items} typing={typingSide} />
            </div>
          </div>
        </aside>
        <div className="rlp-story-rest">{children}</div>
      </div>
    </div>
  );
}
