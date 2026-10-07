"use client";

/**
 * The screen frame for one lifecycle row (captain 2026-10-06, Section map row 4
 * of the home demo redesign): Akhil's workspace window from the hero demo
 * (`ResidentLifecycleWorkspace`: PropLane workspace card, sidebar, "Ask PropLane"
 * top bar, avatar tile) on his atmospheric soft-blue stage, with the real portal
 * screen for one tab inside it (`DemoPanel`) and, where a second party is
 * involved, his phone (`ResidentLifecyclePhone`) beside it with a short static
 * thread. Nothing here fetches or saves; the sidebar switches the panel exactly
 * as it does in the hero.
 *
 * From the `lg` breakpoint the window is drawn at a fixed desktop width and the
 * whole stage content scales down to the column (so a table is never squeezed
 * into a narrow window); under `lg` it is drawn at its natural width, stacked
 * over the phone, and the screen scrolls inside the frame.
 */

import "@/components/marketing/resident-lifecycle-prototypes.css";
import "@/components/marketing/resident-lifecycle-atmosphere.css";
import "./lifecycle-frame.css";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { DEMO_TABS, DemoPanel, type DemoPortal } from "@/components/marketing/site/product-mock/demo-panels";
import { ResidentLifecyclePhone } from "@/components/marketing/resident-lifecycle-phone";
import { ResidentLifecycleWorkspace } from "@/components/marketing/resident-lifecycle-workspace";
import type { PhoneScript } from "@/components/marketing/resident-lifecycle-script";

const WINDOW_WIDTH = 1000;
const PHONE_WIDTH = 304;
const GAP = 22;

const never = () => false;

export function LifecycleFrame({
  portal,
  tab,
  phone,
  label,
}: {
  portal: DemoPortal;
  tab: string;
  phone?: PhoneScript;
  /** Accessible name of the frame, e.g. "Tours". */
  label: string;
}) {
  const [active, setActive] = useState(tab);
  const [scale, setScale] = useState(0.62);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const fit = () => {
      const width = el.clientWidth;
      if (width <= 0) return;
      const need = WINDOW_WIDTH + (phone ? PHONE_WIDTH + GAP : 0);
      setScale(Math.min(1, width / need));
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [phone]);

  return (
    <div className="rlp-page lrf-stage" role="group" aria-label={`${label} in PropLane`}>
      <div className="rlp-atmosphere" aria-hidden />
      <div ref={bodyRef} className="lrf-body" style={{ "--lrf-s": scale } as CSSProperties}>
        <div className="lrf-window-slot">
          <div className="lrf-window rlp-dual-view" data-lifecycle-frame={`${portal}:${active}`}>
            <ResidentLifecycleWorkspace portal={portal} tabs={DEMO_TABS[portal]} active={active} onSelect={setActive} panel>
              <div className="rlp-panel-frame">
                <DemoPanel key={`${portal}-${active}`} portal={portal} tab={active} />
              </div>
            </ResidentLifecycleWorkspace>
          </div>
        </div>
        {phone ? (
          <div className="lrf-phone-slot">
            <div className="lrf-phone">
              <ResidentLifecyclePhone
                stage="message"
                tourAccepted={false}
                applicationApproved={false}
                leaseStep={0}
                serviceCreated={false}
                messages={[]}
                busy={false}
                script={phone}
                onAcceptTour={never}
                onOpenLease={never}
                onResidentSign={never}
                onCreateService={never}
                onReply={() => true}
              />
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
