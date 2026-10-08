"use client";

/**
 * The screen frame for one lifecycle row (captain 2026-10-06, Section map row 4
 * of the home demo redesign): Akhil's workspace window from the hero demo
 * (`ResidentLifecycleWorkspace`: PropLane workspace card, sidebar, "Ask PropLane"
 * top bar, avatar tile) on the home page's own wavy background, with the real portal
 * screen for one tab inside it (`DemoPanel`). The window has one fixed height
 * (the screen scrolls inside it, it never grows), and the phone is not here: one
 * sticky phone stays beside every row. Nothing here fetches or saves; the sidebar switches the panel exactly
 * as it does in the hero.
 *
 * From the `lg` breakpoint the window is drawn at a fixed desktop size and scales
 * down to the column (so a table is never squeezed into a narrow window); under
 * `lg` it is drawn at its natural width at a fixed height.
 */

import "@/components/marketing/resident-lifecycle-prototypes.css";
import "./lifecycle-frame.css";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { DEMO_TABS, DemoPanel, type DemoPortal } from "@/components/marketing/site/product-mock/demo-panels";
import { demoSidebar } from "@/components/marketing/site/product-mock/sidebar-data";
import { NO_STORY, worldFor } from "@/components/marketing/site/product-mock/world";
import { ResidentLifecycleWorkspace } from "@/components/marketing/resident-lifecycle-workspace";

const WINDOW_WIDTH = 1120;

export function LifecycleFrame({
  portal,
  tab,
  label,
}: {
  portal: DemoPortal;
  tab: string;
  /** Accessible name of the frame, e.g. "Tours". */
  label: string;
}) {
  const [active, setActive] = useState(tab);
  const [scale, setScale] = useState(0.62);
  const bodyRef = useRef<HTMLDivElement>(null);
  const sidebar = demoSidebar(portal, NO_STORY, portal === "vendor" ? "visit" : "pay");

  useEffect(() => {
    const el = bodyRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const fit = () => {
      const width = el.clientWidth;
      if (width <= 0) return;
      setScale(Math.min(1, width / WINDOW_WIDTH));
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="rlp-page lrf-stage" role="group" aria-label={`${label} in PropLane`}>
      <div ref={bodyRef} className="lrf-body" style={{ "--lrf-s": scale } as CSSProperties}>
        <div className="lrf-window-slot">
          <div className="lrf-window rlp-dual-view" data-lifecycle-frame={`${portal}:${active}`}>
            <ResidentLifecycleWorkspace
              portal={portal}
              tabs={DEMO_TABS[portal]}
              active={active}
              badges={sidebar.badges}
              needs={portal === "manager" ? worldFor().dashboard.attention : undefined}
              onSelect={setActive}
              panel
            >
              <div className="rlp-panel-frame">
                <DemoPanel key={`${portal}-${active}`} portal={portal} tab={active} />
              </div>
            </ResidentLifecycleWorkspace>
          </div>
        </div>
      </div>
    </div>
  );
}
