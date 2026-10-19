"use client";

import Link from "next/link";
import type { MouseEvent } from "react";
import { HomeHousingScene } from "./home-housing-scene";
import { RESIDENT_GET_STARTED_HREF, VENDOR_GET_STARTED_HREF } from "@/lib/marketing/public-contact";
import type { PublicTextingConfig } from "@/lib/marketing/public-texting";
import { HOME_HEADLINE } from "@/lib/marketing/home-copy";
import { usePublicTexting } from "@/components/marketing/public-texting-context";
import { formatPublicPhone } from "@/lib/marketing/format-public-phone";
import { MessagesTile } from "@/components/marketing/messages-tile";

/** Each audience goes to its own start: browse homes, resident and vendor sign-up, and the managed service for owners. */
const WHO_TEXTS = [
  { role: "Prospects", href: "/rent/browse" },
  { role: "Residents", href: RESIDENT_GET_STARTED_HREF },
  { role: "Vendors", href: VENDOR_GET_STARTED_HREF },
  { role: "Owners", href: "#how-owners" },
] as const;

/**
 * The How it works anchors: the desktop phones, or (up to 1024px) the role list whose items carry `<id>-list`. On a
 * phone neither is drawn (the page is hero, Contact, Join free), so Owners goes to Contact, where the managed service lives.
 */
function followHowAnchor(event: MouseEvent<HTMLAnchorElement>, href: string) {
  if (!href.startsWith("#how-")) return;
  const id = href.slice(1);
  const drawn = (element: HTMLElement | null) => (element?.getClientRects().length ? element : null);
  if (drawn(document.getElementById(id))) return;
  const target = drawn(document.getElementById(`${id}-list`)) ?? drawn(document.getElementById("contact"));
  if (!target) return;
  event.preventDefault();
  target.scrollIntoView({ behavior: "smooth", block: "start" });
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
        ? <a href={config.smsHref!} className="home-number-start" aria-label={`Text ${phone}`} data-attr="home-text-proplane"><MessagesTile className="home-number-start-icon" />Text {phone}</a>
        : <Link href="/#contact" className="home-number-start" data-attr="home-text-proplane"><MessagesTile className="home-number-start-icon" />Text PropLane</Link>}
    </div>
    <ul className="home-number-who" aria-label="Who texts PropLane">{WHO_TEXTS.map(({ role, href }) => <li key={role}><Link href={href} prefetch={false} onClick={(event) => followHowAnchor(event, href)} data-attr={`home-who-${role.toLowerCase()}`}>{role}</Link></li>)}</ul>
  </section>;
}
