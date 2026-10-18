"use client";

import { useEffect, useRef } from "react";
import { ManagerCommunication } from "./resident-lifecycle-manager";
import { DRAFT_REPLY, phoneScriptFor, type SampleMessage } from "./resident-lifecycle-script";

const request = phoneScriptFor("resident", "tour").items.find((item) => item.kind === "out");
const initial: SampleMessage[] = request && "text" in request ? [{ from: "resident", text: request.text }] : [];

/** The actual demo composer sends only into this fixture's local conversation. */
export default function HomeDashboardInbox({ animate, approved, onApprove }: {
  animate: boolean; approved: boolean; onApprove(): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const cursor = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!animate || approved) return;
    let click: ReturnType<typeof setTimeout> | undefined;
    let target: HTMLButtonElement | null = null;
    const move = window.setTimeout(() => {
      const root = ref.current;
      target = root?.querySelector<HTMLButtonElement>('[data-demo-target="comm-approve"]') ?? null;
      if (!root || !target || !cursor.current) return;
      const box = root.getBoundingClientRect();
      const button = target.getBoundingClientRect();
      if (!button.width || !button.height) return;
      const scale = root.offsetWidth ? box.width / root.offsetWidth : 1;
      cursor.current.style.transform = `translate(${(button.left + button.width / 2 - box.left) / scale}px, ${(button.top + button.height / 2 - box.top) / scale}px)`;
      cursor.current.dataset.visible = "true";
      click = setTimeout(() => {
        target?.setAttribute("data-demo-hover", "");
        target?.click();
      }, 820);
    }, 400);
    return () => {
      window.clearTimeout(move);
      clearTimeout(click);
      target?.removeAttribute("data-demo-hover");
    };
  }, [animate, approved]);

  return (
    <div className="home-dashboard-inbox" ref={ref}>
      <ManagerCommunication
        messages={approved ? [...initial, { from: "manager", text: DRAFT_REPLY }] : initial}
        draft={approved ? null : DRAFT_REPLY}
        onApprove={onApprove}
        onReply={() => false}
      />
      {animate && !approved ? <span ref={cursor} className="home-dashboard-cursor" aria-hidden data-visible="false">
        <svg viewBox="0 0 24 28" width="22" height="26"><path d="M3 2.2v19.4l5.1-4.6 3.4 7.6 3.3-1.5-3.4-7.4 7.1-.5z" fill="#17181a" stroke="white" strokeWidth="1.8" /></svg>
      </span> : null}
      <span className="home-dashboard-callout">PropLane drafts the reply. You approve it.</span>
    </div>
  );
}
