"use client";

import Link from "next/link";
import { HomeHousingScene } from "./home-housing-scene";
import { GET_STARTED_HREF, RESIDENT_GET_STARTED_HREF, VENDOR_GET_STARTED_HREF } from "@/lib/marketing/public-contact";
import type { PublicTextingConfig } from "@/lib/marketing/public-texting";
import { HOME_HEADLINE } from "@/lib/marketing/home-copy";
import { usePublicTexting } from "@/components/marketing/public-texting-context";
import { formatPublicPhone } from "@/lib/marketing/format-public-phone";

/** Each audience goes to its own start: browse homes, resident and vendor sign-up, and the managed service for owners. */
const WHO_TEXTS = [
  { role: "Prospects", href: "/rent/browse" },
  { role: "Residents", href: RESIDENT_GET_STARTED_HREF },
  { role: "Vendors", href: VENDOR_GET_STARTED_HREF },
  { role: "Owners", href: "#how-owners" },
] as const;

/** A one-screen cover; its number comes from the server-rendered public snapshot. */
export function TextingHomeHero({ config: override }: { config?: PublicTextingConfig }) {
  const snapshot = usePublicTexting();
  const config = override ?? snapshot;
  const phone = formatPublicPhone(config.phone);
  const configured = Boolean(phone && config.smsHref);
  return <section id="home-hero" className="home-number-hero" aria-labelledby="home-title">
    <HomeHousingScene />
    <div className="home-number-cover-content">
      <h1 id="home-title" aria-label={HOME_HEADLINE}>{HOME_HEADLINE}</h1>
      {/* The cover's one action: text the configured number (captain #19); with no number there is nothing to text. */}
      {configured
        ? <a href={config.smsHref!} className="home-number-start" data-attr="home-text-proplane">Text {phone}</a>
        : <Link href={GET_STARTED_HREF} className="home-number-start" data-attr="home-start-free">Start free</Link>}
    </div>
    <ul className="home-number-who" aria-label="Who texts PropLane">{WHO_TEXTS.map(({ role, href }) => <li key={role}><Link href={href} prefetch={false} data-attr={`home-who-${role.toLowerCase()}`}>{role}</Link></li>)}</ul>
  </section>;
}
