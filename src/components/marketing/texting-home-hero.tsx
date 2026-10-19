"use client";

import Link from "next/link";
import { HomeHousingScene } from "./home-housing-scene";
import { HomeDiscoveryPhone } from "./home-discovery-phone";
import { GET_STARTED_HREF } from "@/lib/marketing/public-contact";
import type { PublicTextingConfig } from "@/lib/marketing/public-texting";
import { HOME_HEADLINE } from "@/lib/marketing/home-copy";
import { usePublicTexting } from "@/components/marketing/public-texting-context";
import { formatPublicPhone } from "@/lib/marketing/format-public-phone";

const WHO_TEXTS = ["Prospects", "Residents", "Vendors", "Owners"];

/** A green Messages-style tile with a white speech bubble, drawn inline (no trademarked image file). */
function MessagesTile() {
  return (
    <svg className="home-text-pill-icon" viewBox="0 0 40 40" aria-hidden="true">
      <rect width="40" height="40" rx="9" fill="#34c759" />
      <path d="M20 9c-6.6 0-12 4.2-12 9.4 0 2.9 1.6 5.4 4.2 7.1-.2 1.4-.8 2.7-1.7 3.7 2-.2 3.9-1 5.1-2 .8.2 1.6.3 2.4.3 6.6 0 12-4.2 12-9.5S26.6 9 20 9Z" fill="#fff" />
    </svg>
  );
}

/** A one-screen cover; its number comes from the server-rendered public snapshot. */
export function TextingHomeHero({ config: override }: { config?: PublicTextingConfig }) {
  const snapshot = usePublicTexting();
  const config = override ?? snapshot;
  const phone = formatPublicPhone(config.phone);
  const configured = Boolean(phone && config.smsHref);
  return <section id="home-hero" className="home-number-hero" aria-labelledby="home-title">
    <HomeHousingScene />
    <div className="home-number-cover-grid">
      <div className="home-number-cover-content">
        <h1 id="home-title" aria-label={HOME_HEADLINE}>{HOME_HEADLINE}</h1>
        {configured ? <div className="home-text-row">
          <a href={config.smsHref!} className="home-text-pill" aria-label={`Text PropLane ${phone}`} data-attr="home-text-proplane">
            <MessagesTile />
            <span>Text PropLane</span>
          </a>
          <span className="home-text-number" data-attr="home-text-number">{phone}</span>
        </div> : <Link href={GET_STARTED_HREF} className="home-number-start" data-attr="home-start-free">Start free</Link>}
      </div>
      <div className="home-hero-phone">
        <HomeDiscoveryPhone />
        <span className="home-sample-label">Sample conversation</span>
      </div>
    </div>
    <ul className="home-number-who" aria-label="Who texts PropLane">{WHO_TEXTS.map(role => <li key={role}>{role}</li>)}</ul>
  </section>;
}
