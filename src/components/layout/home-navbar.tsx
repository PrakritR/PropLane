"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { AxisLogoLink } from "@/components/brand/axis-logo";
import { Button } from "@/components/ui/button";
import { GET_STARTED_HREF } from "@/lib/marketing/public-contact";
import type { PublicTextingConfig } from "@/lib/marketing/public-texting";
import { HomeNavDropdown } from "@/components/layout/home-nav-dropdown";
import { PUBLIC_PRICING_LINKS, PUBLIC_WHY_LINKS } from "@/components/layout/public-navbar-links";
import styles from "@/components/layout/home-navbar.module.css";

const HomeMobileMenu = dynamic(() => import("@/components/layout/home-mobile-menu"), { ssr: false });
export type HomeTextingConfig = PublicTextingConfig;

/** Home's public header makes no session/profile requests and loads its sheet on demand. */
export function HomeNavbar({ texting }: { texting: HomeTextingConfig }) {
  const [scrolled, setScrolled] = useState(false);
  const [heroPassed, setHeroPassed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const configured = Boolean(texting.phone && texting.smsHref);
  const mobileHref = configured ? texting.smsHref! : GET_STARTED_HREF;
  const desktopHref = configured ? "#text-proplane" : GET_STARTED_HREF;

  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      setScrolled(window.scrollY > 48);
      if (!("IntersectionObserver" in window)) {
        const hero = document.getElementById("home-hero");
        setHeroPassed(Boolean(hero && hero.getBoundingClientRect().bottom <= 0));
      }
    };
    const scroll = () => { if (!frame) frame = window.requestAnimationFrame(update); };
    scroll();
    window.addEventListener("scroll", scroll, { passive: true });
    return () => { window.removeEventListener("scroll", scroll); window.cancelAnimationFrame(frame); };
  }, []);

  useEffect(() => {
    if (!("IntersectionObserver" in window)) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry) setHeroPassed(!entry.isIntersecting && entry.boundingClientRect.bottom <= 0);
    }, { threshold: 0 });
    const attach = () => {
      const hero = document.getElementById("home-hero");
      if (!hero) return false;
      observer.observe(hero);
      return true;
    };
    // A streamed page may arrive after its layout has hydrated.
    const pending = new MutationObserver(() => { if (attach()) pending.disconnect(); });
    if (!attach()) pending.observe(document.body, { subtree: true, childList: true });
    return () => { observer.disconnect(); pending.disconnect(); };
  }, []);

  return (
    <>
      <header id="axis-public-navbar" className={styles.header} data-scrolled={scrolled}>
        <div className={styles.bar}>
          <div className={styles.brand}><AxisLogoLink href="/" size="compact" /></div>
          <nav aria-label="Main navigation" className={styles.desktopLinks}>
            <a href="#how-it-works">How it works</a>
            <HomeNavDropdown title="Why PropLane" links={PUBLIC_WHY_LINKS} />
            <HomeNavDropdown title="Pricing" links={PUBLIC_PRICING_LINKS} />
            <Link href="/service" prefetch={false}>Service</Link>
          </nav>
          <div className={styles.desktopActions}>
            <Link href="/auth/sign-in" prefetch={false} className={styles.signIn} data-attr="home-nav-sign-in">Sign in</Link>
            <Button asChild className={styles.textAction}>
              <a href={desktopHref} data-attr="home-nav-text-desktop">{configured ? "Text PropLane" : "Start free"}</a>
            </Button>
          </div>
          <div className={styles.mobileActions}>
            <Button asChild className={styles.textAction}>
              <a href={mobileHref} data-attr="home-nav-text-mobile">{configured ? "Text us" : "Start free"}</a>
            </Button>
            <Button ref={menuTrigger} type="button" variant="ghost" className={styles.menuButton}
              aria-label="Open menu" aria-haspopup="dialog" aria-expanded={menuOpen}
              onClick={() => setMenuOpen(true)} data-attr="home-nav-menu">
              <svg aria-hidden width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
                <path d="M4 7h16M4 12h16M4 17h16" />
              </svg>
            </Button>
          </div>
        </div>
      </header>
      {menuOpen ? <HomeMobileMenu onClose={() => setMenuOpen(false)} restoreFocus={() => menuTrigger.current?.focus()} /> : null}
      {heroPassed && !menuOpen ? (
        <div className={styles.stickyCta} data-attr="home-sticky-text-bar">
          <Button asChild className={styles.stickyAction}>
            <a href={mobileHref} data-attr="home-sticky-text">{configured ? "Text PropLane" : "Start free"}</a>
          </Button>
        </div>
      ) : null}
    </>
  );
}
