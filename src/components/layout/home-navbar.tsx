"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type MouseEvent } from "react";
import { ProPlaneMarkIcon } from "@/components/brand/axis-logo";
import { ArrowRight } from "lucide-react";
import { BOOK_DEMO_EVENT, BOOK_DEMO_HREF, GET_STARTED_HREF } from "@/lib/marketing/public-contact";
import type { PublicTextingConfig } from "@/lib/marketing/public-texting";
import { formatPublicPhone } from "@/lib/marketing/format-public-phone";
import { hasBrowserSessionHint } from "@/lib/auth/browser-session-hint";
import { isRentPath } from "@/components/layout/footer-text-number";
import styles from "@/components/layout/home-navbar.module.css";

const HomeMobileMenu = dynamic(
  () => import("@/components/layout/home-mobile-menu"),
  { ssr: false },
);
export type HomeTextingConfig = PublicTextingConfig;

export function HomeNavbar({ texting }: { texting: HomeTextingConfig }) {
  const pathname = usePathname();
  const [activeSection, setActiveSection] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  // Signed out (the server's and the first paint's answer) the bar's second button is Get started, to the portal
  // chooser; once the browser shows a session it is Portal, straight to /auth/continue, which drops a signed-in visitor into their own portal (and sends a stale cookie to sign-in).
  const [signedIn, setSignedIn] = useState(false);
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const phone = formatPublicPhone(texting.phone);
  const configured = Boolean(phone && texting.smsHref);
  const textHref = configured ? texting.smsHref! : GET_STARTED_HREF;

  useEffect(() => {
    if (pathname !== "/" || typeof window.IntersectionObserver !== "function")
      return;
    const observed = new Set<Element>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.target.id === "home-hero" && entry.isIntersecting)
            setActiveSection("");
        }
      },
      { threshold: 0 },
    );
    const attach = () => {
      for (const id of ["home-hero"]) {
        const element = document.getElementById(id);
        if (element && !observed.has(element)) {
          observer.observe(element);
          observed.add(element);
        }
      }
      return observed.size >= 1;
    };
    const pending = new MutationObserver(() => {
      if (attach()) pending.disconnect();
    });
    if (!attach())
      pending.observe(document.body, { subtree: true, childList: true });
    return () => {
      observer.disconnect();
      pending.disconnect();
    };
  }, [pathname]);

  useEffect(() => {
    if (pathname !== "/" || typeof window.IntersectionObserver !== "function")
      return;
    const observed = new Set<Element>();
    // IntersectionObserver resolves percentage margins against width, even vertically.
    // Keep the reading band at 20–35% of viewport height on every aspect ratio.
    const createObserver = () =>
      new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting)
              setActiveSection(
                entry.target.id,
              );
          }
        },
        {
          rootMargin: `-${Math.round(window.innerHeight * 0.2)}px 0px -${Math.round(window.innerHeight * 0.65)}px 0px`,
          threshold: 0,
        },
      );
    let observer = createObserver();
    const resize = () => {
      observer.disconnect();
      observer = createObserver();
      for (const node of observed) observer.observe(node);
    };
    const attach = () => {
      for (const id of ["how", "dashboard", "service", "pricing", "contact"]) {
        const node = document.getElementById(id);
        if (node && !observed.has(node)) {
          observer.observe(node);
          observed.add(node);
        }
      }
      return observed.size === 5;
    };
    const pending = new MutationObserver(() => {
      if (attach()) pending.disconnect();
    });
    if (!attach())
      pending.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", resize, { passive: true });
    return () => {
      observer.disconnect();
      pending.disconnect();
      window.removeEventListener("resize", resize);
    };
  }, [pathname]);

  useEffect(() => {
    setSignedIn(hasBrowserSessionHint());
  }, []);

  // Phone (640px and below) has no Menu: the bar is brand, Book a demo and Get started (Portal once signed in). Close the sheet if the window narrows to it.
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const phone = window.matchMedia("(max-width: 640px)");
    const close = () => { if (phone.matches) setMenuOpen(false); };
    phone.addEventListener?.("change", close);
    return () => phone.removeEventListener?.("change", close);
  }, []);

  const onHome = pathname === "/";
  // The bar's top-right action is Book a demo at every width on every public page (captain #26); the number stays in
  // the hero, the Contact section and the footer. On the homepage it opens the Contact form in place.
  const bookDemo = (event: MouseEvent<HTMLAnchorElement>) => {
    const form = onHome ? document.getElementById("contact") : null;
    if (!form || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    window.history.pushState(null, "", BOOK_DEMO_HREF);
    form.scrollIntoView({ behavior: "smooth", block: "start" });
    window.dispatchEvent(new Event(BOOK_DEMO_EVENT));
  };
  return (
    <>
      <div className={styles.spacer} aria-hidden="true" />
      <header id="axis-public-navbar" className={styles.header}>
        <div className={styles.bar}>
          <Link href="/" className={styles.brand} aria-label="PropLane home">
            <ProPlaneMarkIcon />
            PropLane
          </Link>
          <nav aria-label="Main navigation" className={styles.desktopLinks}>
            {[
              ["how", "How it works"],
              ["dashboard", "Software"],
              ["service", "Service"],
              ["pricing", "Pricing"],
              ["contact", "Contact"],
            ].map(([id, label]) => (
              <Link
                key={id}
                href={`/#${id}`}
                prefetch={false}
                aria-current={
                  pathname === "/" && activeSection === id
                    ? "location"
                    : undefined
                }
              >
                {label}
              </Link>
            ))}
          </nav>
          <div className={styles.desktopActions}>
            <a
              href={BOOK_DEMO_HREF}
              className={styles.textAction}
              onClick={bookDemo}
              data-attr="home-nav-book-demo-desktop"
            >
              Book a demo
            </a>
            {signedIn ? (
              <Link
                href="/auth/continue"
                prefetch={false}
                className={styles.portal}
                data-attr="home-nav-portal"
              >
                Portal <ArrowRight aria-hidden="true" size={16} />
              </Link>
            ) : (
              <Link
                href={GET_STARTED_HREF}
                prefetch={false}
                className={styles.portal}
                data-attr="home-nav-get-started"
              >
                Get started <ArrowRight aria-hidden="true" size={16} />
              </Link>
            )}
          </div>
          <div className={styles.mobileActions}>
            <a
              href={BOOK_DEMO_HREF}
              className={styles.textAction}
              onClick={bookDemo}
              data-attr="home-nav-book-demo-mobile"
            >
              Book a demo
            </a>
            <Link
              href={signedIn ? "/auth/continue" : GET_STARTED_HREF}
              prefetch={false}
              className={`${styles.portal} ${styles.phonePortal}`}
              data-attr={signedIn ? "home-nav-portal-phone" : "home-nav-get-started-phone"}
            >
              {signedIn ? "Portal" : "Get started"}
            </Link>
            <button
              ref={menuTrigger}
              type="button"
              className={styles.menuButton}
              aria-label="Open menu"
              aria-haspopup="dialog"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen(true)}
              data-attr="home-nav-menu"
            >
              Menu
            </button>
          </div>
        </div>
      </header>
      {menuOpen && (
        <HomeMobileMenu
          textHref={isRentPath(pathname) ? null : textHref}
          phone={configured && !isRentPath(pathname) ? phone : null}
          onClose={() => setMenuOpen(false)}
          restoreFocus={() => menuTrigger.current?.focus()}
        />
      )}
    </>
  );
}
