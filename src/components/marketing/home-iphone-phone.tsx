"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { BatteryFull, CalendarDays, ChevronLeft, ChevronRight, CreditCard, FileText, Mic, Plus, Signal, Video, Wifi, Wrench } from "lucide-react";
import { ProPlaneMarkIcon } from "@/components/brand/axis-logo";
import { formatPublicPhone } from "@/lib/marketing/format-public-phone";
import { usePublicTexting } from "./public-texting-context";
import type { PhoneIcon, PhoneItem } from "./resident-lifecycle-script";

const cardIcons = { file: FileText, calendar: CalendarDays, wrench: Wrench, card: CreditCard } satisfies Record<PhoneIcon, typeof FileText>;

/** A thread entry the Messages preview cannot draw itself (listing cards, a photo): the caller supplies the node. */
export type HomePhoneItem = PhoneItem | { kind: "node"; node: ReactNode };

/** Read-only Messages preview. The caller owns the scene and playback clock. */
export function HomeIphonePhone({ items, typing = null, label = "PropLane", className = "", showNumber = true }: {
  items: HomePhoneItem[];
  typing?: "in" | "out" | null;
  label?: string;
  className?: string;
  /** The number under "PropLane" in the header; How it works shows just "PropLane >" (captain #23). */
  showNumber?: boolean;
}) {
  const { phone } = usePublicTexting();
  const formattedPhone = formatPublicPhone(phone);
  const thread = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Only the thread moves; scene changes never scroll the surrounding page.
    if (thread.current) thread.current.scrollTop = thread.current.scrollHeight;
  }, [items, typing]);

  return <section className={`home-iphone ${className}`} aria-label={`${label} Messages conversation`}>
    <div className="home-iphone-screen">
      <div className="home-iphone-status" aria-hidden="true">
        <strong>9:41</strong>
        <span className="home-iphone-island" />
        <span className="home-iphone-indicators"><Signal /><Wifi /><BatteryFull /></span>
      </div>
      <header className="home-iphone-header">
        <span className="home-iphone-back" aria-hidden="true"><ChevronLeft /></span>
        <div className="home-iphone-contact">
          <span className="home-iphone-avatar" aria-hidden="true"><ProPlaneMarkIcon /></span>
          <strong>PropLane <ChevronRight aria-hidden="true" /></strong>
          {showNumber && formattedPhone ? <span className="home-iphone-number" data-attr="home-phone-number">{formattedPhone}</span> : null}
        </div>
        <span className="home-iphone-video" aria-hidden="true"><Video /></span>
      </header>
      <div className="home-iphone-thread" ref={thread} aria-label="Conversation with PropLane">
        <div className="home-iphone-date">iMessage <span>Today 9:41 AM</span></div>
        {items.map((item, index) => {
          if (item.kind === "node") return <div key={index} className="home-iphone-node">{item.node}</div>;
          if (item.kind === "time") return <div key={index} className="home-iphone-date">{item.text}</div>;
          if (item.kind === "card") {
            const Icon = cardIcons[item.icon];
            return <div key={index} className="home-iphone-card"><Icon aria-hidden="true" /><div><small>{item.eyebrow}</small><strong>{item.title}</strong><span>{item.sub}</span></div></div>;
          }
          return <div key={index} className={`home-iphone-message home-iphone-message--${item.kind}`}><span>{item.text}</span></div>;
        })}
        {typing ? <div className={`home-iphone-message home-iphone-message--${typing} home-iphone-typing`} role="status" aria-label="Typing"><span aria-hidden="true"><i /><i /><i /></span></div> : null}
      </div>
      <div className="home-iphone-composer" aria-hidden="true"><span className="home-iphone-plus"><Plus /></span><span className="home-iphone-input">iMessage<Mic /></span></div>
      <div className="home-iphone-home" aria-hidden="true"><span /></div>
    </div>
  </section>;
}
