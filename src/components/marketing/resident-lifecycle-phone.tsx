"use client";

/**
 * The phone beside the demo window (captain 2026-10-07): one phone that stays on screen down the
 * home page. It draws a thread it is handed and a typing indicator, so a message is always on its
 * way; the engine in `resident-lifecycle-prototypes.tsx` decides which lines exist and when. The
 * caption names the role that owns the phone ("Resident's phone"), never a person.
 */

import "./resident-lifecycle-phone.css";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, BatteryFull, CalendarDays, CreditCard, FileText, Plus, Send, Signal, Video, Wifi, Wrench } from "lucide-react";
import type { PhoneIcon, PhoneItem } from "./resident-lifecycle-script";

const cardIcons: Record<PhoneIcon, React.ReactNode> = {
  file: <FileText aria-hidden />,
  calendar: <CalendarDays aria-hidden />,
  wrench: <Wrench aria-hidden />,
  card: <CreditCard aria-hidden />,
};

type Props = {
  /** Whose phone this is, by role: "Resident's phone". */
  caption: string;
  /** The person on the other end of the thread, by role. */
  contact: { initials: string; name: string; sub: string };
  items: PhoneItem[];
  /** A message is being typed: on the other party's side (`in`) or the owner's (`out`). */
  typing?: "in" | "out" | null;
};

export function ResidentLifecyclePhone({ caption, contact, items, typing = null }: Props) {
  const [reply, setReply] = useState("");
  const [localReplies, setLocalReplies] = useState<string[]>([]);
  const threadRef = useRef<HTMLDivElement>(null);

  // Keep the newest line in view, inside the phone only (never the page).
  useEffect(() => {
    const thread = threadRef.current;
    if (!thread) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    thread.scrollTo({ top: thread.scrollHeight, behavior: reduced ? "auto" : "smooth" });
  }, [items.length, typing, localReplies.length]);

  function sendReply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = reply.trim();
    if (!text) return;
    setLocalReplies((current) => [...current, text]);
    setReply("");
  }

  return (
    <section className="rl-phone-wrap" aria-label={`${caption} Messages conversation`}>
      <div className="rl-phone-caption">
        <span className="rl-phone-caption-dot" />
        {caption}
      </div>
      <div className="rl-phone-device">
        <div className="rl-phone-screen">
          <div className="rl-phone-status">
            <strong>9:41</strong>
            <div className="rl-phone-island" aria-hidden="true" />
            <span className="rl-phone-status-icons">
              <Signal aria-hidden />
              <Wifi aria-hidden />
              <BatteryFull aria-hidden />
            </span>
          </div>
          <header className="rl-phone-header">
            <button type="button" className="rl-phone-header-back" aria-label="Back to conversations">
              <ArrowLeft aria-hidden />
              <span>2</span>
            </button>
            <div className="rl-phone-contact">
              <span className="rl-phone-contact-avatar">{contact.initials}</span>
              <strong>{contact.name}</strong>
              <small>{contact.sub}</small>
            </div>
            <button type="button" className="rl-phone-video" aria-label="Video call">
              <Video aria-hidden />
            </button>
          </header>
          <div ref={threadRef} className="rl-phone-thread" aria-label={`Conversation with ${contact.name}`}>
            {items.map((item, index) =>
              item.kind === "time" ? (
                <div key={index} className="rl-phone-time">
                  {item.text}
                </div>
              ) : item.kind === "card" ? (
                <div key={index} className="rl-phone-rich-card">
                  <div className="rl-phone-rich-icon">{cardIcons[item.icon]}</div>
                  <div>
                    <small>{item.eyebrow}</small>
                    <strong>{item.title}</strong>
                    <span>{item.sub}</span>
                  </div>
                </div>
              ) : (
                <div key={index} className={`rl-phone-message ${item.kind === "out" ? "rl-phone-outgoing" : "rl-phone-incoming"}`}>
                  <span>{item.text}</span>
                </div>
              ),
            )}
            {localReplies.map((text, index) => (
              <div key={`local-${index}`} className="rl-phone-message rl-phone-outgoing">
                <span>{text}</span>
              </div>
            ))}
            {typing ? (
              <div
                className={`rl-phone-message rl-phone-typing ${typing === "out" ? "rl-phone-outgoing" : "rl-phone-incoming"}`}
                role="status"
                aria-label="Typing"
                data-phone-typing={typing}
              >
                <span>
                  <i />
                  <i />
                  <i />
                </span>
              </div>
            ) : null}
          </div>
          <form className="rl-phone-composer" onSubmit={sendReply}>
            <button type="button" className="rl-phone-add" aria-label="Add attachment">
              <Plus aria-hidden />
            </button>
            <input aria-label="Write a reply" placeholder="Text Message" value={reply} onChange={(event) => setReply(event.target.value)} />
            <button type="submit" className="rl-phone-send" aria-label="Send sample reply" disabled={!reply.trim()}>
              <Send aria-hidden />
            </button>
          </form>
          <div className="rl-phone-bottom" aria-hidden="true">
            <span />
          </div>
        </div>
      </div>
    </section>
  );
}
