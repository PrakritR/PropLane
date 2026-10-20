"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { homeDemoEndPhone, homeDemoEndPortal, homeDemoJumpPlan, homeDemoPhoneAfter, homeDemoStartPhone, homeDemoStartPortal } from "@/components/demo/home-demo-script";
import {
  HOME_DEMO_CONTROL,
  HOME_DEMO_EMBED_PATH,
  HOME_DEMO_EVENT,
  HOME_DEMO_INTERACT,
  HOME_DEMO_PORTAL_LABEL,
  HOME_DEMO_READY,
  isHomeDemoPortal,
  type HomeDemoControl,
  type HomeDemoEvent,
  type HomeDemoPhone,
  type HomeDemoPortal,
} from "@/lib/demo/home-demo-embed";
import { homeDemoPhoneItems } from "./home-demo-phone-items";
import { HomeIphonePhone } from "./home-iphone-phone";
import { HomeSectionHeader } from "./home-section-header";

/** The portal is drawn at this logical size and scaled to fit, so it always looks exactly as /portal does. */
const LOGICAL_WIDTH = 1280;
const LOGICAL_HEIGHT = 800;
/** The switcher's segments, in the order the visitor reads the product: the renter, the property team, the vendor. */
const SWITCHER: readonly { portal: HomeDemoPortal; slug: string }[] = [
  { portal: "resident", slug: "resident" },
  { portal: "manager", slug: "property" },
  { portal: "vendor", slug: "vendor" },
];

/** After the journey finishes, how long its last frame holds before it starts over. */
const LOOP_HOLD_MS = 3200;

/**
 * One continuous journey plays inside the iframe (resident, manager and vendor portals, one renter start to finish)
 * and loops; the phone beside it is drawn from what the iframe reports, so the two can never disagree. Playback runs
 * only while the section is on screen, the tab is visible, and the visitor is not hovering or focused inside. Reduced
 * motion shows the journey's end state (no cursor, no autoplay).
 */
export function HomeSoftwareDemoPlayer({ id = "dashboard" }: { id?: string } = {}) {
  const root = useRef<HTMLElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const loaded = useRef(false);
  /** The embed's listener is attached (its READY message arrived). A portal chosen before then waits for it. */
  const embedReady = useRef(false);
  const pendingJump = useRef<{ type: typeof HOME_DEMO_CONTROL; action: "jump"; portal: HomeDemoPortal; paused: boolean } | null>(null);
  const reducedRef = useRef(true);
  const [phone, setPhone] = useState<HomeDemoPhone>(() => homeDemoEndPhone());
  /** Which real portal the iframe is showing: the switcher marks it, so the visitor always knows whose screen it is. */
  const [portal, setPortal] = useState<HomeDemoPortal>(() => homeDemoEndPortal());
  const [typing, setTyping] = useState<"in" | "out" | null>(null);
  const [done, setDone] = useState(false);
  const [near, setNear] = useState(false);
  const [inView, setInView] = useState(false);
  const [visible, setVisible] = useState(true);
  const [reduced, setReduced] = useState<boolean | null>(null);
  const [paused, setPaused] = useState(false);
  const [hovered, setHovered] = useState(false);
  /** Hover may pause the journey only on a pointer that can actually hover: a tap emits mouse events with no
   * matching mouseleave, which left the journey paused for good on a phone or a hybrid laptop. */
  const hoverCapable = useRef(true);
  const [focused, setFocused] = useState(false);
  const [scale, setScale] = useState(0.7);
  const [view, setView] = useState<"phone" | "portal">("phone");
  const holding = paused || hovered || focused || !inView || !visible;
  const holdingRef = useRef(holding);
  useEffect(() => { holdingRef.current = holding; }, [holding]);
  const inViewRef = useRef(inView);
  const visibleRef = useRef(visible);
  useEffect(() => { inViewRef.current = inView; visibleRef.current = visible; }, [inView, visible]);

  const post = useCallback((message: HomeDemoControl) => {
    frame.current?.contentWindow?.postMessage(message, window.location.origin);
  }, []);

  useEffect(() => {
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const hover = window.matchMedia("(hover: hover)");
    const sync = () => setReduced(motion.matches);
    const syncHover = () => {
      hoverCapable.current = hover.matches;
      if (!hover.matches) setHovered(false);
    };
    const syncVisibility = () => setVisible(!document.hidden);
    sync();
    syncHover();
    syncVisibility();
    motion.addEventListener("change", sync);
    hover.addEventListener("change", syncHover);
    document.addEventListener("visibilitychange", syncVisibility);
    const element = root.current;
    let preload: IntersectionObserver | undefined;
    let playback: IntersectionObserver | undefined;
    if (!element || typeof IntersectionObserver === "undefined") {
      setNear(true);
      setInView(true);
    } else {
      preload = new IntersectionObserver(([entry]) => { if (entry?.isIntersecting) setNear(true); }, { rootMargin: "300px" });
      playback = new IntersectionObserver(([entry]) => setInView(Boolean(entry?.isIntersecting && entry.intersectionRatio >= 0.35)), { threshold: [0, 0.35] });
      preload.observe(element);
      playback.observe(element);
    }
    return () => {
      motion.removeEventListener("change", sync);
      hover.removeEventListener("change", syncHover);
      document.removeEventListener("visibilitychange", syncVisibility);
      preload?.disconnect();
      playback?.disconnect();
    };
  }, []);

  // Fit the 1280x800 portal to its cell, whichever dimension is the tighter one.
  useEffect(() => {
    const element = stage.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const { clientWidth, clientHeight } = element;
      if (clientWidth > 0 && clientHeight > 0) setScale(Math.max(0.2, Math.min(clientWidth / LOGICAL_WIDTH, clientHeight / LOGICAL_HEIGHT)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // The iframe reports every step; its phone lines are the only phone state.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== frame.current?.contentWindow) return;
      const data = event.data as ({ type?: string } & Partial<Omit<HomeDemoEvent, "type">>) | null;
      if (data?.type === HOME_DEMO_READY) {
        loaded.current = true;
        embedReady.current = true;
        if (pendingJump.current) {
          post(pendingJump.current);
          pendingJump.current = null;
          return;
        }
        if (reducedRef.current) return;
        post({ type: HOME_DEMO_CONTROL, action: holdingRef.current ? "pause" : "play" });
        return;
      }
      if (data?.type === HOME_DEMO_INTERACT) {
        setPaused(true);
        return;
      }
      if (data?.type !== HOME_DEMO_EVENT || !data.phone) return;
      setPhone(data.phone);
      if (isHomeDemoPortal(data.portal)) setPortal(data.portal);
      setTyping(data.typing ?? null);
      setDone(Boolean(data.done));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [post]);
  /**
   * The portal switcher: the run starts over at that portal's first step (reduced motion: that portal's end frame).
   * The phone follows at once, from the same script the iframe plays. Choosing a portal is the visitor asking to
   * watch, so it lifts any hold that hovering, focus or an earlier press put on the run.
   */
  const jump = useCallback((target: HomeDemoPortal) => {
    const plan = homeDemoJumpPlan(target);
    setPortal(target);
    setPhone(homeDemoPhoneAfter(reducedRef.current ? plan.until : plan.resumeAt));
    setTyping(null);
    setDone(false);
    setView("portal");
    setPaused(false);
    setHovered(false);
    setFocused(false);
    const message = { type: HOME_DEMO_CONTROL, action: "jump", portal: target, paused: reducedRef.current || !inViewRef.current || !visibleRef.current } as const;
    if (embedReady.current) post(message);
    else pendingJump.current = message;
  }, [post]);

  const onSwitcherKey = (event: KeyboardEvent<HTMLElement>, index: number) => {
    const last = SWITCHER.length - 1;
    const next = event.key === "ArrowRight" ? (index === last ? 0 : index + 1) : event.key === "ArrowLeft" ? (index === 0 ? last : index - 1) : event.key === "Home" ? 0 : event.key === "End" ? last : null;
    if (next === null) return;
    event.preventDefault();
    const target = SWITCHER[next]!;
    document.getElementById(`home-demo-portal-${target.slug}`)?.focus();
    jump(target.portal);
  };

  // Tell the iframe whether it may run.
  useEffect(() => {
    if (!loaded.current || reduced) return;
    post({ type: HOME_DEMO_CONTROL, action: holding ? "pause" : "play" });
  }, [holding, reduced, post]);

  useEffect(() => {
    reducedRef.current = reduced !== false;
    // A visitor who gets motion sees the journey from its first frame; reduced motion keeps the end frame.
    if (reduced === false) {
      setPhone(homeDemoStartPhone());
      setPortal(homeDemoStartPortal());
    }
  }, [reduced]);

  // After the journey finishes its last frame holds, then it starts over.
  useEffect(() => {
    if (!done || holding || reduced !== false) return;
    const timer = window.setTimeout(() => {
      setDone(false);
      setTyping(null);
      post({ type: HOME_DEMO_CONTROL, action: "restart" });
    }, LOOP_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [done, holding, reduced, post]);

  // The visitor pressed something inside the portal and the section paused: moving off it lets the journey go on.
  const release = useCallback(() => {
    setHovered(false);
    setFocused(false);
    setPaused(false);
    frame.current?.blur();
  }, []);

  const markHovered = useCallback(() => {
    if (hoverCapable.current) setHovered(true);
  }, []);

  const motionUnknown = reduced === null;
  const src = useMemo(() => {
    const params = new URLSearchParams();
    if (reduced) params.set("static", "1");
    if (holding) params.set("paused", "1");
    return `${HOME_DEMO_EMBED_PATH}?${params.toString()}`;
    // The address is fixed once the iframe mounts; play/pause and restarts travel by message.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [motionUnknown]);

  const items = useMemo(() => homeDemoPhoneItems(phone.items), [phone.items]);
  const mountFrame = near && reduced !== null;
  const phoneLabel = phone.label;

  return (
    <section
      id={id}
      ref={root}
      className="home-software-demo"
      aria-labelledby="home-dashboard-title"
      data-playing={!holding && reduced === false}
      data-reduced-motion={reduced === null ? "unknown" : reduced}
      data-view={view}
      onMouseEnter={markHovered}
      onMouseLeave={release}
      onFocusCapture={(event) => { if (!(event.target as Element).closest?.('[role="tablist"]')) setFocused(true); }}
      onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false); }}
    >
      <header className="home-software-demo-heading">
        <HomeSectionHeader id="home-dashboard-title">Software</HomeSectionHeader>
        <div
          role="tablist"
          aria-label="Portal"
          className="home-software-demo-switch"
          data-attr="home-software-demo-portal"
          onMouseEnter={() => setHovered(false)}
        >
          {SWITCHER.map(({ portal: id, slug }, index) => (
            <button
              key={id}
              type="button"
              role="tab"
              id={`home-demo-portal-${slug}`}
              aria-selected={portal === id}
              aria-controls="home-demo-portal-panel"
              tabIndex={portal === id ? 0 : -1}
              data-attr={`home-demo-portal-${slug}`}
              onClick={() => jump(id)}
              onKeyDown={(event) => onSwitcherKey(event, index)}
            >
              {HOME_DEMO_PORTAL_LABEL[id]}
            </button>
          ))}
        </div>
      </header>
      <div className="home-software-demo-views" role="group" aria-label="Show">
        <button type="button" aria-pressed={view === "phone"} onClick={() => setView("phone")}>Phone</button>
        <button type="button" aria-pressed={view === "portal"} onClick={() => setView("portal")}>Portal</button>
      </div>
      <div className="home-software-demo-body" onMouseMove={markHovered}>
        <div className="home-software-demo-phone">
          <HomeIphonePhone items={items} typing={typing} label={phoneLabel} />
          <p className="home-software-demo-phone-label">{phoneLabel}</p>
        </div>
        <div className="home-software-demo-portal" ref={stage} data-demo-frame id="home-demo-portal-panel" role="tabpanel" aria-labelledby={`home-demo-portal-${SWITCHER.find((entry) => entry.portal === portal)!.slug}`}>
          {mountFrame ? (
            <div className="home-software-demo-scaler" style={{ width: LOGICAL_WIDTH * scale, height: LOGICAL_HEIGHT * scale }}>
              <iframe
                ref={frame}
                title="PropLane portal demo"
                src={src}
                width={LOGICAL_WIDTH}
                height={LOGICAL_HEIGHT}
                style={{ transform: `scale(${scale})` }}
                onLoad={() => {
                  loaded.current = true;
                  if (reduced === false) post({ type: HOME_DEMO_CONTROL, action: holding ? "pause" : "play" });
                }}
              />
            </div>
          ) : (
            <p className="home-software-demo-loading" role="status">Loading the demo…</p>
          )}
        </div>
      </div>
    </section>
  );
}
