"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import {
  ArrowUpRight,
  ChevronLeft,
  MessageCircle,
  Play,
  RotateCcw,
} from "lucide-react";
import { AxisLogoGlyph } from "@/components/brand/axis-logo";
import { Button } from "@/components/ui/button";
import { useReducedMotion } from "@/components/ui/motion/use-reduced-motion";
import { phoneScriptFor } from "@/components/marketing/resident-lifecycle-script";
import { TextLinkForm } from "@/components/marketing/text-link-form";
import { GET_STARTED_HREF } from "@/lib/marketing/public-contact";
import type { PublicTextingConfig } from "@/lib/marketing/public-texting";
import { HOME_DESCRIPTION, HOME_HEADLINE } from "@/lib/marketing/home-copy";
import { usePublicTexting } from "@/components/marketing/public-texting-context";

const WebDemo = dynamic(() => import("./texting-web-demo"), { ssr: false });
const conversation = phoneScriptFor("resident", "tour").items.filter(
  (item) => item.kind !== "time",
);

/** Fixture conversation only. The interactive demo loads on demand into a modal. */
export function TextingHomeHero({
  config: configOverride,
  qrDataUrl: qrOverride,
}: {
  config?: PublicTextingConfig;
  qrDataUrl?: string | null;
}) {
  const snapshot = usePublicTexting();
  const config = configOverride ?? snapshot;
  const qrDataUrl = qrOverride === undefined ? snapshot.qrDataUrl ?? null : qrOverride;
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(1);
  const [replay, setReplay] = useState(0);
  const [demoOpen, setDemoOpen] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (new URLSearchParams(window.location.search).get("demo") === "open")
        setDemoOpen(true);
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  useEffect(() => {
    if (reduced) return;
    const timers = conversation
      .slice(1)
      .map((_, i) => window.setTimeout(() => setShown(i + 2), 1400 + i * 750));
    return () => timers.forEach(window.clearTimeout);
  }, [reduced, replay]);
  const visible = reduced ? conversation.length : shown;
  const closeDemo = () => {
    setDemoOpen(false);
    const url = new URL(window.location.href);
    if (url.searchParams.has("demo")) {
      url.searchParams.delete("demo");
      window.history.replaceState(
        null,
        "",
        `${url.pathname}${url.search}${url.hash}`,
      );
    }
  };
  return (
    <section
      id="home-hero"
      className="texting-hero texting-shell"
      aria-labelledby="home-title"
    >
      <div className="texting-hero-copy">
        <span className="texting-eyebrow">
          <span aria-hidden="true" /> ONE NUMBER. EVERY CONVERSATION.
        </span>
        <h1 id="home-title">{HOME_HEADLINE}</h1>
        <p className="texting-hero-description">{HOME_DESCRIPTION}</p>
        <div className="texting-hero-actions">
          <Button asChild className="texting-primary texting-phone-cta">
            <a
              href={config.smsHref ?? GET_STARTED_HREF}
              data-attr="home-text-proplane"
            >
              <MessageCircle aria-hidden="true" className="h-5 w-5" />
              {config.smsHref ? "Text PropLane" : "Start free"}
            </a>
          </Button>
          <Button asChild className="texting-primary texting-desktop-cta">
            <a
              href={config.smsHref ? "#text-proplane" : GET_STARTED_HREF}
              data-attr="home-desktop-text-proplane"
            >
              <MessageCircle aria-hidden="true" className="h-5 w-5" />
              {config.smsHref ? "Text PropLane" : "Start free"}
            </a>
          </Button>
          <Button
            variant="ghost"
            className="texting-demo-button"
            onClick={() => setDemoOpen(true)}
            data-attr="home-open-demo"
          >
            <Play aria-hidden="true" className="h-4 w-4" />
            Open the demo
          </Button>
        </div>
        {config.smsHref && qrDataUrl ? (
          <div id="text-proplane" className="texting-desktop-connect">
            <a
              href={config.smsHref}
              aria-label="Text PropLane using your messaging app"
              className="texting-qr"
              data-attr="home-text-qr"
            >
              {/* Server-generated QR: no client QR library or network image. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={qrDataUrl}
                width="104"
                height="104"
                alt="Scan to text PropLane"
              />
            </a>
            <div className="min-w-0 flex-1">
              <a className="texting-number" href={config.smsHref}>
                {config.phone?.replace(
                  /^\+1(\d{3})(\d{3})(\d{4})$/,
                  "+1 ($1) $2-$3",
                )}
                <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
              </a>
              <TextLinkForm />
            </div>
          </div>
        ) : null}
      </div>
      <div className="texting-phone-wrap">
        <div
          className="texting-phone"
          role="group"
          aria-label="Sample Room 3 text conversation"
        >
          <div className="texting-phone-status" aria-hidden="true">
            <span>9:41</span>
            <span className="texting-phone-island" />
            <span>▮▮▮ ▰</span>
          </div>
          <div className="texting-phone-contact">
            <ChevronLeft className="h-5 w-5 text-blue-600" aria-hidden="true" />
            <div>
              <span className="texting-contact-mark">
                <AxisLogoGlyph size="compact" />
              </span>
              <strong>PropLane</strong>
            </div>
            <span className="texting-sample-label">Demo</span>
          </div>
          <div className="texting-phone-messages">
            <span className="texting-conversation-time">Today 9:41 AM</span>
            {conversation.slice(0, visible).map((item, index) =>
              item.kind === "card" ? (
                <div key={index} className="texting-tour-card">
                  <span>{item.eyebrow}</span>
                  <strong>{item.title}</strong>
                  <span>{item.sub}</span>
                </div>
              ) : (
                <div
                  key={index}
                  className={`texting-bubble texting-bubble-${item.kind}`}
                >
                  {item.text}
                </div>
              ),
            )}
            {visible < conversation.length && (
              <span className="texting-typing" aria-label="PropLane is typing">
                <i />
                <i />
                <i />
              </span>
            )}
          </div>
          <div className="texting-phone-bottom">
            <span>Text message</span>
            <span className="texting-send-glyph" aria-hidden="true">
              ↑
            </span>
          </div>
          <div className="texting-home-indicator" aria-hidden="true" />
        </div>
        {!reduced && (
          <button
            className="texting-replay"
            onClick={() => {
              setShown(1);
              setReplay((n) => n + 1);
            }}
            aria-label="Replay sample conversation"
            data-attr="home-replay-conversation"
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
            Replay
          </button>
        )}
      </div>
      {demoOpen && <WebDemo onClose={closeDemo} />}
    </section>
  );
}
