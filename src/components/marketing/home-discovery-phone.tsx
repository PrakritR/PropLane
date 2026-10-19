"use client";

import { useEffect, useRef, useState } from "react";
import { BatteryFull, CalendarDays, ChevronLeft, ChevronRight, House, Mic, Plus, Signal, Video, Wifi } from "lucide-react";
import { ProPlaneMarkIcon } from "@/components/brand/axis-logo";
import { formatPublicPhone } from "@/lib/marketing/format-public-phone";
import { usePublicTexting } from "./public-texting-context";
import {
  DISCOVERY_LINES,
  DISCOVERY_LISTINGS,
  type DiscoveryLine,
  type DiscoveryListing,
} from "./home-discovery-script";

/** The tour card keeps the look of the phone's existing TOUR card (`home-iphone-card`). */
function TourCard({ line }: { line: Extract<DiscoveryLine, { kind: "tour" }> }) {
  const listing = DISCOVERY_LISTINGS.find((l) => l.street === line.street);
  return (
    <div className="home-iphone-card">
      <CalendarDays aria-hidden="true" />
      <div>
        <small>TOUR · {line.street.toUpperCase()}</small>
        <strong>{line.dayLabel}, {line.timeLabel}</strong>
        {listing ? <span>{listing.neighborhood}, Seattle</span> : null}
      </div>
    </div>
  );
}

/** One listing: a no-photo tile (never an invented picture), title and neighborhood, rent and availability. */
function ListingCard({ listing }: { listing: DiscoveryListing }) {
  return (
    <div className="home-discovery-listing">
      <span className="home-discovery-tile" aria-hidden="true"><House aria-hidden="true" /></span>
      <div>
        <strong>{listing.title}</strong>
        <span>{listing.neighborhood}</span>
      </div>
      <div className="home-discovery-listing-meta">
        <strong>{listing.rentLabel}</strong>
        <span>{listing.availableLabel}</span>
      </div>
    </div>
  );
}

const STEP_MS = 1500;

/**
 * The hero's sample conversation: the shared discovery script, played line by line once the phone is on screen.
 * Reduced motion shows the whole thread at once. The frame is fixed, so playback never moves the page.
 */
export function HomeDiscoveryPhone({ className = "" }: { className?: string }) {
  const { phone } = usePublicTexting();
  const formattedPhone = formatPublicPhone(phone);
  const root = useRef<HTMLElement>(null);
  const thread = useRef<HTMLDivElement>(null);
  const total = DISCOVERY_LINES.length;
  const [shown, setShown] = useState(1);
  const [typing, setTyping] = useState(false);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined" || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      const showAll = setTimeout(() => setShown(total), 0);
      return () => clearTimeout(showAll);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let next = 1;
    let started = false;
    const step = () => {
      if (next >= total) return;
      if (DISCOVERY_LINES[next].kind === "proplane") {
        // A reply from PropLane is preceded by the typing dots; everything else just arrives.
        setTyping(true);
        timer = setTimeout(() => {
          setTyping(false);
          setShown(++next);
          timer = setTimeout(step, STEP_MS);
        }, 800);
        return;
      }
      setShown(++next);
      timer = setTimeout(step, STEP_MS);
    };
    const observer = new IntersectionObserver((entries) => {
      if (started || !entries.some((e) => e.isIntersecting)) return;
      started = true;
      timer = setTimeout(step, 900);
    }, { threshold: 0.3 });
    observer.observe(el);
    return () => {
      observer.disconnect();
      if (timer) clearTimeout(timer);
    };
    // The script is a module constant; playback restarts only on mount.
  }, [total]);

  useEffect(() => {
    // Only the thread scrolls; the page never does.
    if (thread.current) thread.current.scrollTop = thread.current.scrollHeight;
  }, [shown, typing]);

  return (
    <section ref={root} className={`home-iphone home-discovery-phone ${className}`} aria-label="Sample Messages conversation with PropLane">
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
            {formattedPhone ? <span className="home-iphone-number">{formattedPhone}</span> : null}
          </div>
          <span className="home-iphone-video" aria-hidden="true"><Video /></span>
        </header>
        <div className="home-iphone-thread" ref={thread} aria-label="Conversation with PropLane">
          <div className="home-iphone-date">iMessage <span>Today 9:41 AM</span></div>
          {DISCOVERY_LINES.slice(0, shown).map((line, index) => {
            switch (line.kind) {
              case "prospect":
                return <div key={index} className="home-iphone-message home-iphone-message--out"><span>{line.text}</span></div>;
              case "proplane":
                return <div key={index} className="home-iphone-message home-iphone-message--in"><span>{line.text}</span></div>;
              case "listings":
                return <div key={index} className="home-discovery-listings">{line.listings.map((l) => <ListingCard key={l.id} listing={l} />)}</div>;
              case "tour":
                return <TourCard key={index} line={line} />;
              case "divider":
                return <div key={index} className="home-iphone-date">{line.text}</div>;
            }
          })}
          {typing ? <div className="home-iphone-message home-iphone-message--in home-iphone-typing" role="status" aria-label="Typing"><span aria-hidden="true"><i /><i /><i /></span></div> : null}
        </div>
        <div className="home-iphone-composer" aria-hidden="true"><span className="home-iphone-plus"><Plus /></span><span className="home-iphone-input">iMessage<Mic /></span></div>
        <div className="home-iphone-home" aria-hidden="true"><span /></div>
      </div>
    </section>
  );
}
