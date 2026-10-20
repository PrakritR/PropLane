"use client";

import Link from "next/link";
import { HomeHousingScene } from "./home-housing-scene";
import { MANAGER_GET_STARTED_HREF, RESIDENT_GET_STARTED_HREF, VENDOR_GET_STARTED_HREF } from "@/lib/marketing/public-contact";
import type { PublicTextingConfig } from "@/lib/marketing/public-texting";
import { HOME_HEADLINE } from "@/lib/marketing/home-copy";
import { usePublicTexting } from "@/components/marketing/public-texting-context";
import { formatPublicPhone } from "@/lib/marketing/format-public-phone";
import { MessagesTile } from "@/components/marketing/messages-tile";
import { HOME_ROLES, type HomeRoleId } from "@/lib/marketing/home-roles";

/**
 * Where each audience goes: prospects browse homes; residents and vendors open their own sign-up; managers and owners
 * open the Property portal sign-up (captain #31: an owner's account is a Property account).
 */
const WHO_HREF: Record<HomeRoleId, string> = {
  prospects: "/rent/browse",
  residents: RESIDENT_GET_STARTED_HREF,
  vendors: VENDOR_GET_STARTED_HREF,
  managers: MANAGER_GET_STARTED_HREF,
  owners: MANAGER_GET_STARTED_HREF,
};
/** The strip under the cover: the shared roles (names and order from HOME_ROLES), each to its own start. */
const WHO_TEXTS = HOME_ROLES.map((role) => ({ role: role.label, href: WHO_HREF[role.id] }));

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
    <ul className="home-number-who" aria-label="Who texts PropLane">{WHO_TEXTS.map(({ role, href }) => <li key={role}><Link href={href} prefetch={false} data-attr={`home-who-${role.toLowerCase()}`}>{role}</Link></li>)}</ul>
  </section>;
}
