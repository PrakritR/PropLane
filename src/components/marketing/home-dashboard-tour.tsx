"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

const BEATS = ["All", "Rentals", "Services", "Payments"] as const;
const HEADER_HEIGHT = 64;
const clamp = (value: number) => Math.min(1, Math.max(0, value));

/** Only the viewport treatment is client-side; the one dashboard remains in the DOM throughout. */
export function HomeDashboardTour({ children }: { children: ReactNode }) {
  const root = useRef<HTMLElement>(null);
  const windowWrap = useRef<HTMLDivElement>(null);
  const [enhanced, setEnhanced] = useState(false);
  const [near, setNear] = useState(false);
  const [beat, setBeat] = useState(0);
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const desktop = window.matchMedia("(min-width: 861px)");
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setEnhanced(desktop.matches && !motion.matches);
    update();
    desktop.addEventListener("change", update);
    motion.addEventListener("change", update);
    const observer = new IntersectionObserver(
      ([entry]) => setNear(entry.isIntersecting),
      { rootMargin: "500px" },
    );
    if (root.current) observer.observe(root.current);
    return () => {
      desktop.removeEventListener("change", update);
      motion.removeEventListener("change", update);
      observer.disconnect();
    };
  }, []);
  useEffect(() => {
    const element = root.current;
    const frame = windowWrap.current;
    if (!enhanced || !near || !element || !frame) return;
    let request: number | null = null;
    const update = () => {
      request = null;
      const rect = element.getBoundingClientRect();
      const distance = Math.max(
        1,
        rect.height - (window.innerHeight - HEADER_HEIGHT),
      );
      setBeat(
        Math.min(
          3,
          Math.floor(clamp((HEADER_HEIGHT - rect.top) / distance) * 4),
        ),
      );
      const progress = clamp(
        1 - (rect.top - HEADER_HEIGHT) / (window.innerHeight * 0.85),
      );
      const eased = 1 - (1 - progress) ** 3;
      frame.style.setProperty("--dashboard-scale", String(0.9 + 0.1 * eased));
      frame.style.setProperty(
        "--dashboard-opacity",
        String(0.35 + 0.65 * eased),
      );
    };
    const schedule = () => {
      if (request === null) request = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (request !== null) cancelAnimationFrame(request);
      frame.style.removeProperty("--dashboard-scale");
      frame.style.removeProperty("--dashboard-opacity");
    };
  }, [enhanced, near]);
  return (
    <section
      id="dashboard"
      ref={root}
      className="home-dashboard-tour"
      data-enhanced={enhanced}
      data-beat={BEATS[beat].toLowerCase()}
      aria-labelledby="home-dashboard-title"
    >
      <div className="home-dashboard-sticky">
        <div className="home-dashboard-section-label">
          <span>02</span>
          <span>Dashboard</span>
          <small>Sample data</small>
        </div>
        <div className="home-dashboard-heading">
          <h2 id="home-dashboard-title">
            Everything the number does, <span>on one screen.</span>
          </h2>
          {enhanced && (
            <nav
              aria-label="Dashboard highlights"
              className="home-dashboard-beats"
            >
              {BEATS.map((label, index) => (
                <button
                  key={label}
                  type="button"
                  aria-current={beat === index ? "step" : undefined}
                  onClick={() => {
                    const element = root.current;
                    if (!element) return;
                    const rect = element.getBoundingClientRect();
                    const distance = Math.max(
                      1,
                      rect.height - (window.innerHeight - HEADER_HEIGHT),
                    );
                    window.scrollTo({
                      top:
                        window.scrollY +
                        rect.top -
                        HEADER_HEIGHT +
                        (index * distance) / 4 +
                        1,
                      behavior: "smooth",
                    });
                  }}
                >
                  <span aria-hidden="true">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  {label}
                </button>
              ))}
            </nav>
          )}
        </div>
        <div className="home-dashboard-window-wrap" ref={windowWrap}>
          {children}
        </div>
      </div>
    </section>
  );
}
