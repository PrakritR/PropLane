"use client";

import "./auth-split.css";
import { useEffect, useState } from "react";
import { AuthIconManager, AuthIconResident, AuthIconVendor } from "@/components/auth/auth-role-icons";
import { SiteBackdrop } from "@/components/marketing/site/site-backdrop";

/** Requests a property manager actually makes, typed one at a time into the bar. */
const PROMPTS = [
  "Draft a reply to the leak report at Willow Court",
  "Send Room 3's application",
  "Who hasn't paid October rent?",
  "Schedule the gutter cleaning for Thursday",
  "Remind residents about Friday's inspection",
];

const TYPE_MS = 38;
const HOLD_MS = 1800;
const ERASE_MS = 16;
const GAP_MS = 420;

/**
 * The floating "Ask PropLane" bar: types a rotating request letter by letter
 * behind a blinking caret. With reduced motion it is the first request, static.
 */
function AuthPromptBar() {
  const [text, setText] = useState(PROMPTS[0]);
  const [animated, setAnimated] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (query.matches) return;
    setAnimated(true);

    let timer: ReturnType<typeof setTimeout> | undefined;
    let index = 0;
    let length = 0;
    let phase: "type" | "hold" | "erase" = "type";
    let stopped = false;

    const tick = () => {
      if (stopped) return;
      const prompt = PROMPTS[index];
      if (phase === "type") {
        length += 1;
        setText(prompt.slice(0, length));
        if (length >= prompt.length) {
          phase = "hold";
          timer = setTimeout(tick, HOLD_MS);
        } else {
          timer = setTimeout(tick, TYPE_MS + (prompt[length - 1] === " " ? 14 : 0));
        }
      } else if (phase === "hold") {
        phase = "erase";
        timer = setTimeout(tick, ERASE_MS);
      } else {
        length = Math.max(0, length - 2);
        setText(prompt.slice(0, length));
        if (length === 0) {
          index = (index + 1) % PROMPTS.length;
          phase = "type";
          timer = setTimeout(tick, GAP_MS);
        } else {
          timer = setTimeout(tick, ERASE_MS);
        }
      }
    };

    length = 0;
    setText("");
    timer = setTimeout(tick, 700);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  return (
    <div className="auth-prompt-bar" data-animated={animated ? "true" : "false"}>
      <span className="auth-prompt-spark">
        <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="currentColor" aria-hidden>
          <path d="M12 2.5c.5 4.9 2.6 7 7.5 7.5-4.9.5-7 2.6-7.5 7.5-.5-4.9-2.6-7-7.5-7.5 4.9-.5 7-2.6 7.5-7.5Z" />
          <path d="M18.6 14.6c.2 2 1.1 2.9 3.1 3.1-2 .2-2.9 1.1-3.1 3.1-.2-2-1.1-2.9-3.1-3.1 2-.2 2.9-1.1 3.1-3.1Z" opacity=".7" />
        </svg>
      </span>
      <span className="auth-prompt-text">
        {text}
        <i className="auth-prompt-caret" />
      </span>
      <span className="auth-prompt-send">
        <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none">
          <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    </div>
  );
}

/**
 * The right side of every auth screen on a wide web window: an inset rounded
 * card in the home page's wavy atmosphere, a floating "Ask PropLane" bar that
 * types a request, and two calm hints by role.
 *
 * Purely decorative: `aria-hidden`, no controls, no links, no names, no
 * figures. Hidden below `lg`, in the native shells and on the wide plan chooser
 * by `auth-split.css`.
 */
export function AuthBrandPanel() {
  return (
    <aside className="auth-brand-panel" data-auth-brand aria-hidden="true">
      <div className="auth-brand-card">
        <SiteBackdrop />
        <div className="auth-brand-glow" />
        <div className="auth-brand-stage">
          <div className="auth-hint auth-hint-a">
            <span className="auth-hint-icon">
              <AuthIconManager className="h-[18px] w-[18px]" />
            </span>
            <span className="auth-hint-text">
              <strong>Manager</strong>
              <small>Approve &amp; send</small>
            </span>
          </div>
          <AuthPromptBar />
          <div className="auth-hint auth-hint-b">
            <span className="auth-hint-icon">
              <AuthIconVendor className="h-[18px] w-[18px]" />
            </span>
            <span className="auth-hint-text">
              <strong>Vendor</strong>
              <small>Scheduled</small>
            </span>
          </div>
          <div className="auth-hint auth-hint-c">
            <span className="auth-hint-icon">
              <AuthIconResident className="h-[18px] w-[18px]" />
            </span>
            <span className="auth-hint-text">
              <strong>Resident</strong>
              <small>Rent paid</small>
            </span>
          </div>
        </div>
      </div>
    </aside>
  );
}
