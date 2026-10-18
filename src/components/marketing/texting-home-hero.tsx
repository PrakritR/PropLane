"use client";

import Link from "next/link";
import { BigNumber } from "@/components/marketing/big-number";
import { GET_STARTED_HREF } from "@/lib/marketing/public-contact";
import type { PublicTextingConfig } from "@/lib/marketing/public-texting";
import { HOME_HEADLINE } from "@/lib/marketing/home-copy";
import { usePublicTexting } from "@/components/marketing/public-texting-context";
import { formatPublicPhone } from "@/lib/marketing/format-public-phone";

/** The cover has one decision. Its configured number is already present in server HTML. */
export function TextingHomeHero({ config: override }: { config?: PublicTextingConfig }) {
  const snapshot = usePublicTexting();
  const config = override ?? snapshot;
  const configured = Boolean(formatPublicPhone(config.phone) && config.smsHref);
  return <section id="home-hero" className="home-number-hero" aria-labelledby="home-title">
    <h1 id="home-title" aria-label={HOME_HEADLINE}>{HOME_HEADLINE.split(/ (?=Property)/).map((line, index) => <span key={line}>{index > 0 ? " " : ""}{line}</span>)}</h1>
    {configured ? <BigNumber config={config} label="Text us" dataAttr="home-text-proplane" /> :
      <Link href={GET_STARTED_HREF} className="home-number-start" data-attr="home-start-free">Start free</Link>}
  </section>;
}
