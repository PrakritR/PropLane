"use client";

import Link from "next/link";
import { HomeHousingScene } from "./home-housing-scene";
import { RESIDENT_GET_STARTED_HREF, VENDOR_GET_STARTED_HREF } from "@/lib/marketing/public-contact";
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

/** A green Messages-style tile with a white speech bubble, drawn inline (no trademarked image file). */
function MessagesTile() {
  return (
    <svg className="home-number-start-icon" viewBox="0 0 40 40" aria-hidden="true">
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
    <div className="home-number-cover-content">
      <h1 id="home-title" aria-label={HOME_HEADLINE}>{HOME_HEADLINE}</h1>
      {/* The cover's one action is always the text-us button (captain #21), never Start free: the configured number
          as an sms: link; with no public line at all, the same button opens Contact. */}
      {configured
        ? <a href={config.smsHref!} className="home-number-start" aria-label={`Text ${phone}`} data-attr="home-text-proplane"><MessagesTile />Text {phone}</a>
        : <Link href="/#contact" className="home-number-start" data-attr="home-text-proplane"><MessagesTile />Text PropLane</Link>}
    </div>
    <ul className="home-number-who" aria-label="Who texts PropLane">{WHO_TEXTS.map(({ role, href }) => <li key={role}><Link href={href} prefetch={false} data-attr={`home-who-${role.toLowerCase()}`}>{role}</Link></li>)}</ul>
  </section>;
}
