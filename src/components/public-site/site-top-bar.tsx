"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { ProPlaneMarkIcon } from "@/components/brand/axis-logo";
import { usePublicTexting } from "@/components/marketing/public-texting-context";
import { formatUsPhoneDisplay } from "@/lib/phone-e164";
import { SITE_NAV_LINKS, SITE_PORTAL_HREF, renterSmsHref } from "@/components/public-site/journey-paths";

/**
 * The approved homepage's top bar for the prospect journey: logo · How it works · Service · Pricing ·
 * Contact … the number (blue) · Portal. Phone: logo · Text us · Menu sheet. The number comes from the
 * layout's config snapshot (`usePublicTexting`), never a literal; with none configured the button hides.
 */
export function SiteTopBar() {
  const { phone } = usePublicTexting();
  const smsHref = renterSmsHref(phone);
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    // A link in the sheet navigated: close it.
    queueMicrotask(() => setOpen(false));
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <header className="ps ps-bar" id="axis-public-navbar">
      <div className="ps-wrap ps-bar-in">
        <Link href="/" className="ps-logo" aria-label="PropLane home" data-attr="site-bar-logo">
          <ProPlaneMarkIcon />
          <span>PropLane</span>
        </Link>
        <nav aria-label="Main navigation" className="ps-nav">
          {SITE_NAV_LINKS.map((link) => (
            <Link key={link.href} href={link.href} prefetch={false}>
              {link.label}
            </Link>
          ))}
        </nav>
        <div className="ps-bar-r">
          {smsHref ? (
            <a href={smsHref} className="ps-btn ps-btn-blue" data-attr="site-bar-text">
              <span className="max-[860px]:hidden">{formatUsPhoneDisplay(phone)}</span>
              <span className="min-[861px]:hidden">Text us</span>
            </a>
          ) : null}
          <Link href={SITE_PORTAL_HREF} prefetch={false} className="ps-btn ps-btn-line ps-bar-portal" data-attr="site-bar-portal">
            Portal
            <svg aria-hidden width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
          </Link>
          <button
            type="button"
            className="ps-btn ps-btn-line ps-menu-btn"
            aria-expanded={open}
            aria-controls="ps-site-sheet"
            onClick={() => setOpen((value) => !value)}
            data-attr="site-bar-menu"
          >
            {open ? "Close" : "Menu"}
          </button>
        </div>
      </div>
      {open ? (
        <nav id="ps-site-sheet" className="ps-sheet" aria-label="Menu">
          <Link href="/rent/browse" onClick={() => setOpen(false)}>Find a home</Link>
          {SITE_NAV_LINKS.map((link) => (
            <Link key={link.href} href={link.href} prefetch={false} onClick={() => setOpen(false)}>
              {link.label}
            </Link>
          ))}
          <Link href={SITE_PORTAL_HREF} prefetch={false} onClick={() => setOpen(false)}>Portal</Link>
        </nav>
      ) : null}
    </header>
  );
}
