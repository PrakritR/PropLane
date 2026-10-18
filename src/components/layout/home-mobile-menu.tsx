"use client";

import Link from "next/link";
import { Sheet, SheetClose, SheetContent, SheetTitle } from "@/components/ui/sheet";
import styles from "@/components/layout/home-navbar.module.css";

export default function HomeMobileMenu({ textHref, phone, onClose, restoreFocus }: {
  textHref: string; phone: string | null; onClose: () => void; restoreFocus: () => void;
}) {
  return <Sheet open onOpenChange={(open) => { if (!open) onClose(); }}>
    <SheetContent side="bottom" className={styles.menuPanel} aria-describedby={undefined} onCloseAutoFocus={(event) => { event.preventDefault(); restoreFocus(); }}>
      <SheetTitle className={styles.menuTitle}>PropLane</SheetTitle>
      <nav aria-label="Mobile navigation" className={styles.menuLinks}>
        {[["/#how", "How it works"], ["/#service", "Service"], ["/#pricing", "Pricing"], ["/#contact", "Contact"], ["/blog", "Blog"], ["/auth/sign-in", "Portal"]].map(([href, label]) => <SheetClose asChild key={href}><Link href={href} prefetch={false}>{label}</Link></SheetClose>)}
      </nav>
      <SheetClose asChild><a href={textHref} className={styles.menuNumber}>{phone ? `Text ${phone}` : "Start free"}</a></SheetClose>
    </SheetContent>
  </Sheet>;
}
