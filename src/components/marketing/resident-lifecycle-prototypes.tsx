"use client";

/**
 * The home page hero and the guided demo beneath it (captain 2026-10-06, revised
 * 2026-10-07).
 *
 * The hero is the two-line headline and three buttons, with the demo window right
 * under them. The demo plays itself in four beats (a prospect asks and books a tour,
 * applies, signs the lease, pays rent and gets a repair booked): each beat is one or
 * two phone messages and the real portal panel that matches them
 * (`resident-lifecycle-script.ts`). There is no stage UI on screen; the visitor changes
 * portal from the window's own account menu, exactly as a multi-role user does in the
 * real portal. Every sidebar item opens the real panel for that tab (`DemoPanel`,
 * `site/product-mock/demo-panels.tsx`); clicking one pins that tab (the window stops
 * autoplaying) while the phone keeps going.
 *
 * ONE phone stays on screen down the page (sticky from the `lg` breakpoint, inline under
 * the window below it) through the hero, the demo and the lifecycle rows, which arrive as
 * `children`: it always has a message being typed, then arriving, then the next one.
 * Everything on screen derives from one number, how many messages the phone has shown.
 * Nothing here touches the network or saves: it is a sample.
 *
 * The clock pauses while the pointer or focus is inside the window and while the account
 * menu is open, and never runs under prefers-reduced-motion (the first beat shows, still).
 * The window also grows from about 88% to full size as the page scrolls through the first
 * 60% of the viewport (transform only, so nothing shifts; off under reduced motion).
 */

import "./resident-lifecycle-prototypes.css";
import "./resident-lifecycle-engine.css";
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { AppStoreBadge } from "@/components/marketing/app-store-badge";
import { BOOK_DEMO_HREF, GET_STARTED_HREF } from "@/lib/marketing/public-contact";
import { DEMO_TABS, DemoPanel, type DemoPortal } from "@/components/marketing/site/product-mock/demo-panels";
import { NO_STORY, worldFor } from "@/components/marketing/site/product-mock/world";
import { ManagerCommunication } from "./resident-lifecycle-manager";
import { ResidentLifecyclePhone } from "./resident-lifecycle-phone";
import { ResidentLifecycleWorkspace } from "./resident-lifecycle-workspace";
import {
  COMMUNICATION_THREADS,
  PHONE_META,
  STORIES,
  beatAfter,
  framesFor,
  managerMessages,
  mirrorItems,
  shownThrough,
  storyAt,
  threadItems,
} from "./resident-lifecycle-script";

/** A message types for TYPE_MS, stays for HOLD_MS, then the next one starts typing; the first waits INTRO_MS. */
const TYPE_MS = 1500;
const HOLD_MS = 2300;
const INTRO_MS = 2800;
const END_MS = 3200;

/** The hero window starts at GROW_FROM of its size and reaches full size after GROW_OVER of the viewport height. */
const GROW_FROM = 0.88;
const GROW_OVER = 0.6;

const MemoPanel = memo(DemoPanel);

export function ResidentLifecyclePrototypes({ children }: { children?: ReactNode }) {
  const [portal, setPortal] = useState<DemoPortal>("manager");
  /** How many phone messages have arrived. */
  const [shown, setShown] = useState(0);
  /** The next message is being typed. */
  const [typing, setTyping] = useState(true);
  /** A sidebar click pins a tab: the window stops following the story. */
  const [tabOverride, setTabOverride] = useState<string | null>(null);
  const [reduced, setReduced] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);

  const frames = useMemo(() => framesFor(portal), [portal]);
  const total = frames.length;
  const beats = STORIES[portal];
  // The first three seconds show the manager's Dashboard before the story starts.
  const intro = portal === "manager" && shown === 0 && !reduced;
  // While a message types the window already shows its beat; once it lands, the beat it belongs to.
  const index = Math.min(Math.max(typing ? shown : shown - 1, 0), total - 1);
  const beat = frames[index]!.beat;
  const stageId = beats[beat]!.id;
  const activeTab = tabOverride ?? (intro ? "dashboard" : beats[beat]!.tab);
  const story = useMemo(() => (intro ? NO_STORY : storyAt(portal, beat)), [intro, portal, beat]);
  const playing = !reduced && !hovered && !focused && !menuOpen;
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
  // Reduced motion: no clock. The first beat shows, with its messages already there and nothing typing.
  useEffect(() => {
    if (!reduced) return;
    setShown(shownThrough(portal, 0));
    setTyping(false);
  }, [reduced, portal]);

  // The clock: type, land, hold, type the next; after the last, hold and start over.
  useEffect(() => {
    if (!playing) return;
    let ms: number;
    let next: () => void;
    if (typing) {
      ms = shown === 0 ? INTRO_MS : TYPE_MS;
      next = () => {
        setShown((count) => count + 1);
        setTyping(false);
      };
    } else if (shown >= total) {
      ms = END_MS;
      next = () => {
        setShown(0);
        setTyping(true);
      };
    } else {
      ms = HOLD_MS;
      next = () => setTyping(true);
    }
    const timer = setTimeout(next, ms);
    return () => clearTimeout(timer);
  }, [playing, typing, shown, total]);

  // Scroll growth: the window grows from GROW_FROM to full size over the first GROW_OVER of the viewport.
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
    setShown(reduced ? shownThrough(nextPortal, 0) : 0);
    setTyping(!reduced);
    setTabOverride(null);
  };

  // The phone: the lines so far from its owner's side, drawn from the other side for the resident portal.
  const meta = PHONE_META[portal];
  const owned = threadItems(portal, shown);
  const items = meta.mirror ? mirrorItems(owned) : owned;
  const upcoming = typing && !reduced ? frames[shown]?.message.kind : undefined;
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
            onPointerEnter={() => setHovered(true)}
            onPointerLeave={() => setHovered(false)}
            onFocus={() => setFocused(true)}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
            }}
          >
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
                  messages={managerMessages(shown)}
                  typing={typing && !reduced}
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
