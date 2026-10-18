"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { BigNumber } from "@/components/marketing/big-number";
import { GET_STARTED_HREF } from "@/lib/marketing/public-contact";
import type { PublicTextingConfig } from "@/lib/marketing/public-texting";
import { HOME_HEADLINE } from "@/lib/marketing/home-copy";
import { usePublicTexting } from "@/components/marketing/public-texting-context";
import { formatPublicPhone } from "@/lib/marketing/format-public-phone";

const WHO_TEXTS = [
  ["Prospects", "Looking for a room"],
  ["Residents", "Rent, repairs, house questions"],
  ["Vendors", "Jobs, photos, invoices"],
  ["Owners", "How is my house, approve repairs"],
];

/** The layout snapshot supplies the real number and QR in the first HTML response. */
export function TextingHomeHero({ config: override, qrDataUrl: qrOverride }: { config?: PublicTextingConfig; qrDataUrl?: string | null }) {
  const snapshot = usePublicTexting();
  const config = override ?? snapshot;
  // An explicit alternate configuration must also bring its matching QR.
  const qrDataUrl = qrOverride !== undefined ? qrOverride : override ? null : snapshot.qrDataUrl;
  const configured = Boolean(formatPublicPhone(config.phone) && config.smsHref);
  return <section id="home-hero" className="home-number-hero" aria-labelledby="home-title">
    <div className="home-number-cover-top">
      <div className="home-number-wrap">
        <h1 id="home-title" aria-label={HOME_HEADLINE}>{HOME_HEADLINE.split(/ (?=Property)/).map((line, index) => <span key={line}>{index > 0 ? " " : ""}{line}</span>)}</h1>
      </div>
    </div>
    <div className="home-number-slab">
      <div className="home-number-wrap">
        <div className="home-number-slab-main">
          <div>
            {configured ? <>
              <div className="home-number-text-label">Text us <ArrowRight aria-hidden="true" /></div>
              <BigNumber config={config} dataAttr="home-text-proplane" />
            </> : <Link href={GET_STARTED_HREF} className="home-number-start" data-attr="home-start-free">Start free <ArrowRight aria-hidden="true" /></Link>}
          </div>
          {configured && qrDataUrl && <a href={config.smsHref!} className="home-number-qr" aria-label="Scan to text PropLane" data-attr="home-text-qr">
            {/* Server-generated QR bytes require no image optimization request. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={qrDataUrl} alt="QR code to text PropLane" width={320} height={320} />
          </a>}
        </div>
        <ul className="home-number-who" aria-label="Who texts PropLane">
          {WHO_TEXTS.map(([role, description], index) => <li key={role}>
            <span className="home-number-who-index">{String(index + 1).padStart(2, "0")}</span>
            <span className="home-number-who-role">{role}</span>
            <span className="home-number-who-description">{description}</span>
          </li>)}
        </ul>
      </div>
    </div>
  </section>;
}
