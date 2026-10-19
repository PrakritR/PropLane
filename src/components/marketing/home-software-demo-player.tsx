"use client";

import { Pause, Play } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HOME_DEMO_CHAPTER_DATA, homeDemoEndPhone } from "@/components/demo/home-demo-script";
import {
  HOME_DEMO_CHAPTERS,
  HOME_DEMO_CONTROL,
  HOME_DEMO_EMBED_PATH,
  HOME_DEMO_EVENT,
  HOME_DEMO_INTERACT,
  HOME_DEMO_READY,
  type HomeDemoChapterId,
  type HomeDemoControl,
  type HomeDemoEvent,
  type HomeDemoPhone,
} from "@/lib/demo/home-demo-embed";
import { homeDemoPhoneItems } from "./home-demo-phone-items";
import { HomeIphonePhone } from "./home-iphone-phone";
import { HomeSectionHeader } from "./home-section-header";

/** The portal is drawn at this logical size and scaled to fit, so it always looks exactly as /portal does. */
const LOGICAL_WIDTH = 1280;
const LOGICAL_HEIGHT = 800;
/** After a chapter finishes, how long it holds before the next one starts. */
const CHAPTER_HOLD_MS = 3200;

const firstPhone = (chapter: HomeDemoChapterId): HomeDemoPhone => ({ label: HOME_DEMO_CHAPTER_DATA[chapter].phones[0]!.label, items: [] });

/**
 * One chapter plays at a time inside the iframe; the phone beside it is drawn from what the iframe reports, so the two
 * can never disagree. Playback runs only while the section is on screen, the tab is visible, and the visitor is not
 * hovering, focused inside or paused. Reduced motion shows each chapter's end state (no cursor, no autoplay).
 */
export function HomeSoftwareDemoPlayer() {
  const root = useRef<HTMLElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const loaded = useRef(false);
  const chapterRef = useRef<HomeDemoChapterId>("find");
  const reducedRef = useRef(true);
  const [chapter, setChapter] = useState<HomeDemoChapterId>("find");
  /** The chapter the iframe was asked to open on (its address); later changes go by message. */
  const [mountChapter, setMountChapter] = useState<HomeDemoChapterId>("find");
  const [phone, setPhone] = useState<HomeDemoPhone>(() => homeDemoEndPhone("find"));
  const [typing, setTyping] = useState<"in" | "out" | null>(null);
  const [done, setDone] = useState(false);
  const [near, setNear] = useState(false);
  const [inView, setInView] = useState(false);
  const [visible, setVisible] = useState(true);
  const [reduced, setReduced] = useState<boolean | null>(null);
  const [paused, setPaused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [scale, setScale] = useState(0.7);
  const [view, setView] = useState<"phone" | "portal">("phone");
  const holding = paused || hovered || focused || !inView || !visible;
  const holdingRef = useRef(holding);
  useEffect(() => { holdingRef.current = holding; }, [holding]);

  const post = useCallback((message: HomeDemoControl) => {
    frame.current?.contentWindow?.postMessage(message, window.location.origin);
  }, []);

  useEffect(() => {
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduced(motion.matches);
    const syncVisibility = () => setVisible(!document.hidden);
    sync();
    syncVisibility();
    motion.addEventListener("change", sync);
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
        if (reducedRef.current) return;
        post({ type: HOME_DEMO_CONTROL, action: "select", chapter: chapterRef.current });
        post({ type: HOME_DEMO_CONTROL, action: holdingRef.current ? "pause" : "play" });
        return;
      }
      if (data?.type === HOME_DEMO_INTERACT) {
        setPaused(true);
        return;
      }
      if (data?.type !== HOME_DEMO_EVENT || !data.phone) return;
      if (data.chapter !== chapterRef.current) return;
      setPhone(data.phone);
      setTyping(data.typing ?? null);
      setDone(Boolean(data.done));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [post]);
  // Tell the iframe whether it may run.
  useEffect(() => {
    if (!loaded.current || reduced) return;
    post({ type: HOME_DEMO_CONTROL, action: holding ? "pause" : "play" });
  }, [holding, reduced, post]);

  const select = useCallback((next: HomeDemoChapterId) => {
    chapterRef.current = next;
    setChapter(next);
    setPhone(reducedRef.current ? homeDemoEndPhone(next) : firstPhone(next));
    setTyping(null);
    setDone(false);
    setPaused(false);
    if (loaded.current) post({ type: HOME_DEMO_CONTROL, action: "select", chapter: next });
    else setMountChapter(next);
  }, [post]);
  useEffect(() => { reducedRef.current = reduced !== false; }, [reduced]);

  // After a chapter finishes it holds, then the next one starts (and the last one loops to the first).
  useEffect(() => {
    if (!done || holding || reduced !== false) return;
    const timer = window.setTimeout(() => {
      const index = HOME_DEMO_CHAPTERS.findIndex((item) => item.id === chapterRef.current);
      select(HOME_DEMO_CHAPTERS[(index + 1) % HOME_DEMO_CHAPTERS.length]!.id);
    }, CHAPTER_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [done, holding, reduced, select]);

  const motionUnknown = reduced === null;
  const src = useMemo(() => {
    const params = new URLSearchParams({ chapter: mountChapter });
    if (reduced) params.set("static", "1");
    if (holding) params.set("paused", "1");
    return `${HOME_DEMO_EMBED_PATH}?${params.toString()}`;
    // The address is fixed once the iframe mounts; later chapters and play/pause travel by message.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mountChapter, motionUnknown]);

  const items = useMemo(() => homeDemoPhoneItems(phone.items), [phone.items]);
  const mountFrame = near && reduced !== null;
  const phoneLabel = phone.label;

  const onKeyDown = (event: React.KeyboardEvent, index: number) => {
    const last = HOME_DEMO_CHAPTERS.length - 1;
    const next = event.key === "ArrowRight" ? (index + 1) % (last + 1) : event.key === "ArrowLeft" ? (index + last) % (last + 1) : event.key === "Home" ? 0 : event.key === "End" ? last : null;
    if (next === null) return;
    event.preventDefault();
    select(HOME_DEMO_CHAPTERS[next]!.id);
    (event.currentTarget.parentElement?.children[next] as HTMLElement | undefined)?.focus();
  };

  return (
    <section
      id="dashboard"
      ref={root}
      className="home-software-demo"
      aria-labelledby="home-dashboard-title"
      data-chapter={chapter}
      data-playing={!holding && reduced === false}
      data-reduced-motion={reduced === null ? "unknown" : reduced}
      data-view={view}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false); }}
    >
      <header className="home-software-demo-heading">
        <HomeSectionHeader id="home-dashboard-title">Software</HomeSectionHeader>
        <span>Sample data</span>
      </header>
      <div className="home-software-demo-views" role="group" aria-label="Show">
        <button type="button" aria-pressed={view === "phone"} onClick={() => setView("phone")}>Phone</button>
        <button type="button" aria-pressed={view === "portal"} onClick={() => setView("portal")}>Portal</button>
      </div>
      <div className="home-software-demo-body" id="software-demo-scene" role="tabpanel" aria-labelledby={`software-demo-tab-${chapter}`}>
        <div className="home-software-demo-phone">
          <HomeIphonePhone items={items} typing={typing} label={phoneLabel} />
          <p className="home-software-demo-phone-label">{phoneLabel}</p>
        </div>
        <div className="home-software-demo-portal" ref={stage} data-demo-frame>
          {mountFrame ? (
            <div className="home-software-demo-scaler" style={{ width: LOGICAL_WIDTH * scale, height: LOGICAL_HEIGHT * scale }}>
              <iframe
                ref={frame}
                title="PropLane portal, sample data"
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
            <p className="home-software-demo-loading" role="status">Loading sample…</p>
          )}
        </div>
      </div>
      <div className="home-software-demo-controls">
        <div role="tablist" aria-label="Demo chapters" className="home-software-demo-tabs">
          {HOME_DEMO_CHAPTERS.map((item, index) => (
            <button
              key={item.id}
              id={`software-demo-tab-${item.id}`}
              type="button"
              role="tab"
              aria-selected={chapter === item.id}
              aria-controls="software-demo-scene"
              tabIndex={chapter === item.id ? 0 : -1}
              onClick={() => select(item.id)}
              onKeyDown={(event) => onKeyDown(event, index)}
            >
              <span aria-hidden="true">{item.number}</span>
              <span className="home-software-demo-tab-label">{item.label}</span>
            </button>
          ))}
        </div>
        {reduced === false && (
          <button
            type="button"
            className="home-software-demo-play"
            aria-label={paused ? "Play demo" : "Pause demo"}
            aria-pressed={paused}
            data-attr="home-software-demo-play"
            onClick={() => {
              if (paused) {
                setHovered(false);
                setFocused(false);
                setPaused(false);
              } else setPaused(true);
            }}
          >
            {paused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
          </button>
        )}
      </div>
    </section>
  );
}
