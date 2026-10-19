"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { HomeSectionHeader } from "@/components/marketing/home-section-header";
import { MessagesTile } from "@/components/marketing/messages-tile";
import { usePublicTexting } from "@/components/marketing/public-texting-context";
import { formatPublicPhone } from "@/lib/marketing/format-public-phone";
import type { PublicTextingConfig } from "@/lib/marketing/public-texting";
import {
  RESIDENT_GET_STARTED_HREF,
  VENDOR_GET_STARTED_HREF,
} from "@/lib/marketing/public-contact";

/**
 * The people who do not run homes. Each row's first action is the number itself (captain #22): a resident finds
 * housing by text, a vendor gets jobs by text; Sign up free stays beside it, to that role's own sign-up.
 */
const ROWS = [
  { id: "resident", role: "Resident", line: "Find housing by text", href: RESIDENT_GET_STARTED_HREF },
  { id: "vendor", role: "Vendor", line: "Get jobs by text", href: VENDOR_GET_STARTED_HREF },
] as const;

export function HomeJoinFree({ config: override }: { config?: PublicTextingConfig }) {
  const snapshot = usePublicTexting();
  const config = override ?? snapshot;
  const phone = formatPublicPhone(config.phone);
  const smsHref = phone ? config.smsHref : null;
  return (
    <section className="home-join" aria-labelledby="home-join-title">
      <div className="swiss-wrap home-join-wrap">
        <HomeSectionHeader id="home-join-title">Join free</HomeSectionHeader>
        <ul className="home-join-rows">
          {ROWS.map((row) => (
            <li key={row.id}>
              <span className="home-join-role">{row.role}</span>
              <span className="home-join-line">{row.line}</span>
              <span className="home-join-actions">
                {smsHref ? (
                  <a href={smsHref} className="home-join-text" aria-label={`Text ${phone}`} data-attr={`home-join-${row.id}-text`}>
                    <MessagesTile className="home-join-text-icon" />
                    {phone}
                  </a>
                ) : null}
                <Link href={row.href} prefetch={false} className="home-join-cta" data-attr={`home-join-${row.id}`}>
                  Sign up free
                  <ArrowRight aria-hidden="true" size={16} />
                </Link>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
