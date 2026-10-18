"use client";

import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { HomeDashboardPortal } from "./home-dashboard-data";

type Visibility = { active: boolean; near: boolean; animated: boolean };
const VisibilityContext = createContext<Visibility>({ active: true, near: false, animated: false });
export const useHomeDashboardVisibility = () => useContext(VisibilityContext);
const subscribeHydration = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;
type Step = { id: HomeDashboardPortal; label: string; caption: string; content: ReactNode };

/** Scroll selects roles on desktop; phones and reduced motion use the same frame's native buttons. */
export function HomeDashboardTour({ steps }: { steps: Step[] }) {
  const root = useRef<HTMLElement>(null);
  const controls = useRef<(HTMLButtonElement | null)[]>([]);
  const interactive = useSyncExternalStore(subscribeHydration, clientSnapshot, serverSnapshot);
  const [pinned, setPinned] = useState(false);
  const [near, setNear] = useState(false);
  const [active, setActive] = useState(0);
  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 861px)");
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setPinned(desktop.matches && !motion.matches && typeof IntersectionObserver !== "undefined");
    update();
    desktop.addEventListener("change", update);
    motion.addEventListener("change", update);
    const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(([entry]) => setNear(entry.isIntersecting), { rootMargin: "150px" });
    if (observer && root.current) observer.observe(root.current);
    return () => { desktop.removeEventListener("change", update); motion.removeEventListener("change", update); observer?.disconnect(); };
  }, []);
  useEffect(() => {
    const element = root.current;
    if (!pinned || !near || !element) return;
    let request: number | null = null;
    const update = () => {
      request = null;
      const rect = element.getBoundingClientRect();
      const distance = Math.max(1, rect.height - window.innerHeight);
      setActive(Math.min(steps.length - 1, Math.max(0, Math.floor(-rect.top / distance * steps.length))));
    };
    const schedule = () => { if (request === null) request = requestAnimationFrame(update); };
    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => { window.removeEventListener("scroll", schedule); window.removeEventListener("resize", schedule); if (request !== null) cancelAnimationFrame(request); };
  }, [pinned, near, steps.length]);
  const select = (index: number) => {
    if (!pinned) { setActive(index); return; }
    const element = root.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const distance = Math.max(1, rect.height - window.innerHeight);
    window.scrollTo({ top: window.scrollY + rect.top + index * distance / steps.length + 1, behavior: "smooth" });
  };
  return <section id="dashboard" ref={root} className="home-dashboard-tour" data-enhanced={pinned} data-interactive={interactive} aria-labelledby="home-dashboard-title">
    <div className="home-dashboard-sticky">
      <div className="home-dashboard-heading"><h2 id="home-dashboard-title">The software</h2><span>Sample data</span></div>
      <div className="home-dashboard-role-tabs" role={interactive ? "tablist" : undefined} aria-label="Software portals">
        {steps.map((step, index) => interactive ? <button key={step.id} ref={(node) => { controls.current[index] = node; }} id={`software-tab-${step.id}`} role="tab" type="button" aria-selected={active === index} aria-controls={`software-panel-${step.id}`} tabIndex={active === index ? 0 : -1} onClick={() => select(index)} onKeyDown={(event) => {
          const next = event.key === "ArrowRight" ? (index + 1) % steps.length : event.key === "ArrowLeft" ? (index + steps.length - 1) % steps.length : event.key === "Home" ? 0 : event.key === "End" ? steps.length - 1 : null;
          if (next !== null) { event.preventDefault(); controls.current[next]?.focus(); select(next); }
        }}>{step.label}</button> : <a key={step.id} id={`software-tab-${step.id}`} href={`#software-panel-${step.id}`}>{step.label}</a>)}
      </div>
      <div className="home-dashboard-scenes">{steps.map((step, index) => <VisibilityContext.Provider key={step.id} value={{ active: !interactive || active === index, near: near || (interactive && typeof IntersectionObserver === "undefined"), animated: pinned }}>
        <div className="home-dashboard-scene" id={`software-panel-${step.id}`} role={interactive ? "tabpanel" : undefined} aria-labelledby={`software-tab-${step.id}`} hidden={interactive && active !== index} inert={interactive && active !== index ? true : undefined}>
          {step.content}<p className="home-dashboard-caption">{step.caption}</p>
        </div>
      </VisibilityContext.Provider>)}</div>
    </div>
  </section>;
}
