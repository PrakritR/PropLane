"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import styles from "@/components/layout/home-navbar.module.css";

/** Native disclosure keeps the home navigation independent of the full mega-menu bundle. */
export function HomeNavDropdown({ title, links, mobile = false, onNavigate }: {
  title: string;
  links: readonly { title: string; url: string }[];
  mobile?: boolean;
  onNavigate?: () => void;
}) {
  const disclosure = useRef<HTMLDetailsElement>(null);
  const summary = useRef<HTMLElement>(null);
  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      const element = disclosure.current;
      if (element?.open && event.target instanceof Node && !element.contains(event.target)) element.open = false;
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, []);
  return (
    <details ref={disclosure} className={mobile ? styles.mobileDropdown : styles.dropdown}
      name={mobile ? "home-mobile-navigation" : "home-desktop-navigation"}
      onBlur={(event) => {
        if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && event.currentTarget.open) {
          event.preventDefault();
          event.stopPropagation();
          event.currentTarget.open = false;
          summary.current?.focus();
        }
      }}>
      <summary ref={summary}>{title}<svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="m3 4.5 3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg></summary>
      <div className={styles.dropdownLinks}>
        {links.map((link) => <Link key={link.url} href={link.url} prefetch={false} onClick={() => {
          if (disclosure.current) disclosure.current.open = false;
          onNavigate?.();
        }}>{link.title}</Link>)}
      </div>
    </details>
  );
}
