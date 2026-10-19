"use client";

import { Component, Suspense, lazy, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { HOME_DASHBOARD_PORTALS, type HomeDashboardPortal } from "./home-dashboard-data";
import { Pause, Play } from "lucide-react";
import { HomeIphonePhone } from "./home-iphone-phone";
import type { PhoneItem } from "./resident-lifecycle-script";
import { SOFTWARE_DEMO_SCENES, SOFTWARE_DEMO_SCENE_MS, type SoftwareDemoScene } from "./home-software-demo-scenes";

const Panels = lazy(() => import("./home-software-demo-panels"));
class PreviewBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <p className="home-software-demo-loading" role="status">The preview is unavailable. The sample conversation is still here.</p> : this.props.children; }
}

export type HomeSoftwareDemoPlayerProps = {
  request: string;
  draft: string;
  phoneScenes: PhoneItem[][];
};

/** One clock owns every scene. No clock runs offscreen, in a hidden tab, or with reduced motion. */
export function HomeSoftwareDemoPlayer({ request, draft, phoneScenes }: HomeSoftwareDemoPlayerProps) {
  const root = useRef<HTMLElement>(null);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const portalTabs = useRef<(HTMLButtonElement | null)[]>([]);
  const autoApproving = useRef(false);
  const [scene, setScene] = useState(0);
  const [interactive, setInteractive] = useState(false);
  const [portal, setPortal] = useState<HomeDashboardPortal>("manager");
  const [near, setNear] = useState(false);
  const [inView, setInView] = useState(false);
  const [visible, setVisible] = useState(false);
  const [reduced, setReduced] = useState(true);
  const [paused, setPaused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [readyScene, setReadyScene] = useState<SoftwareDemoScene | null>(null);
  const current = SOFTWARE_DEMO_SCENES[scene];
  const onReady = useCallback((id: SoftwareDemoScene) => setReadyScene(id), []);
  const onApprove = useCallback(() => setScene(4), []);
  const playing = !interactive && inView && visible && !reduced && !paused && !hovered && !focused && readyScene === current.id;

  useEffect(() => {
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updateMotion = () => setReduced(motion.matches);
    const updateVisibility = () => setVisible(!document.hidden);
    updateMotion();
    updateVisibility();
    motion.addEventListener("change", updateMotion);
    document.addEventListener("visibilitychange", updateVisibility);
    const element = root.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      setNear(true);
      return () => { motion.removeEventListener("change", updateMotion); document.removeEventListener("visibilitychange", updateVisibility); };
    }
    const preload = new IntersectionObserver(([entry]) => { if (entry.isIntersecting) setNear(true); }, { rootMargin: "250px" });
    const playback = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting && entry.intersectionRatio >= 0.35), { threshold: [0, 0.35] });
    preload.observe(element);
    playback.observe(element);
    return () => { preload.disconnect(); playback.disconnect(); motion.removeEventListener("change", updateMotion); document.removeEventListener("visibilitychange", updateVisibility); };
  }, []);

  useEffect(() => {
    if (!playing) return;
    const timer = window.setTimeout(() => {
      if (current.id === "approve") {
        // This is the real fixture composer's handler, so its approved reply
        // precedes the tour confirmation. It cannot send a live message.
        const approval = root.current?.querySelector<HTMLButtonElement>('[data-demo-target="comm-approve"]');
        if (approval && !approval.disabled) {
          autoApproving.current = true;
          try { approval.click(); } finally { autoApproving.current = false; }
        }
        else setPaused(true);
      } else if (current.id === "paid") { setPaused(true); setInteractive(true); }
      else setScene((value) => value + 1);
    }, SOFTWARE_DEMO_SCENE_MS);
    return () => window.clearTimeout(timer);
  }, [playing, current.id]);

  const select = (index: number) => { setPaused(true); setInteractive(false); setPortal("manager"); setNear(true); setScene(index); };
  const explore = () => { setPaused(true); setInteractive(true); };
  const selectPortal = (index: number) => { setPortal(HOME_DASHBOARD_PORTALS[index].id); setNear(true); explore(); };
  return <section id="dashboard" ref={root} className="home-software-demo" aria-labelledby="home-dashboard-title" data-scene={current.id} data-playing={playing} data-reduced-motion={reduced} data-interactive={interactive}
    onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
    onFocusCapture={() => setFocused(true)} onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false); }}>
    <header className="home-software-demo-heading"><h2 id="home-dashboard-title">The software</h2><span>Sample data</span></header>
    <div className="home-software-demo-toolbar">
      <div className="home-dashboard-role-tabs" role="tablist" aria-label="Software portals">
        {HOME_DASHBOARD_PORTALS.map((item, index) => <button key={item.id} ref={(node) => { portalTabs.current[index] = node; }} id={`software-tab-${item.id}`} type="button" role="tab" aria-selected={portal === item.id} aria-controls="software-demo-scene" tabIndex={portal === item.id ? 0 : -1} onClick={() => selectPortal(index)} onKeyDown={(event) => {
          const next = event.key === "ArrowRight" ? (index + 1) % HOME_DASHBOARD_PORTALS.length : event.key === "ArrowLeft" ? (index + HOME_DASHBOARD_PORTALS.length - 1) % HOME_DASHBOARD_PORTALS.length : event.key === "Home" ? 0 : event.key === "End" ? HOME_DASHBOARD_PORTALS.length - 1 : null;
          if (next !== null) { event.preventDefault(); selectPortal(next); portalTabs.current[next]?.focus(); }
        }}>{item.label}</button>)}
      </div>
      <p className="home-software-demo-caption">{interactive ? "Explore the portal" : current.title}</p>
    </div>
    <div className="home-software-demo-body" id="software-demo-scene" role="tabpanel" aria-labelledby={interactive ? `software-tab-${portal}` : `software-demo-tab-${current.id}`}>
      <div className="home-software-demo-phone" hidden={interactive}><HomeIphonePhone items={phoneScenes[scene]} label={current.id === "paid" ? "Resident’s sample conversation" : "Prospect’s sample conversation"} /></div>
      <div className="home-software-demo-portal" aria-label={`${portal} portal preview`} onPointerDownCapture={() => setPaused(true)} onClickCapture={() => { if (!autoApproving.current) explore(); }}>
        {near ? <PreviewBoundary><Suspense fallback={<p className="home-software-demo-loading" role="status">Loading sample…</p>}>
          <Panels key={portal} portal={portal} interactive={interactive} onInteract={explore} scene={current.id} request={request} draft={draft} onApprove={onApprove} onReady={onReady} />
        </Suspense></PreviewBoundary> : <p className="home-software-demo-loading">Manager portal</p>}
      </div>
    </div>
    <div className="home-software-demo-controls">
      <div role="tablist" aria-label="Demo scenes" className="home-software-demo-tabs">
        {SOFTWARE_DEMO_SCENES.map((item, index) => <button key={item.id} ref={(node) => { tabs.current[index] = node; }} id={`software-demo-tab-${item.id}`} type="button" role="tab" aria-label={`${String(index + 1).padStart(2, "0")} ${item.label}`} aria-selected={scene === index} aria-controls="software-demo-scene" tabIndex={scene === index ? 0 : -1} onClick={() => select(index)} onKeyDown={(event) => {
          const next = event.key === "ArrowRight" ? (index + 1) % SOFTWARE_DEMO_SCENES.length : event.key === "ArrowLeft" ? (index + SOFTWARE_DEMO_SCENES.length - 1) % SOFTWARE_DEMO_SCENES.length : event.key === "Home" ? 0 : event.key === "End" ? SOFTWARE_DEMO_SCENES.length - 1 : null;
          if (next !== null) { event.preventDefault(); select(next); tabs.current[next]?.focus(); }
        }}><span aria-hidden="true">{String(index + 1).padStart(2, "0")}</span><span className="home-software-demo-tab-label">{item.label}</span></button>)}
      </div>
      {!reduced && <button type="button" className="home-software-demo-play" aria-label={paused ? "Play demo" : "Pause demo"} aria-pressed={paused} onClick={() => { if (paused || interactive) { setFocused(false); setHovered(false); setInteractive(false); setPortal("manager"); if (current.id === "paid") setScene(0); setPaused(false); } else explore(); }}>{paused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}</button>}
    </div>
  </section>;
}
