"use client";

import Link from "next/link";
import { Sheet, SheetClose, SheetContent, SheetTitle } from "@/components/ui/sheet";
import styles from "@/components/layout/home-navbar.module.css";

export default function HomeMobileMenu({ onClose, restoreFocus }: { onClose: () => void; restoreFocus: () => void }) {
  return (
    <Sheet open onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent side="bottom" className={styles.menuPanel} aria-describedby={undefined}
        onCloseAutoFocus={(event) => { event.preventDefault(); restoreFocus(); }}>
        <SheetTitle className={styles.menuTitle}>PropLane</SheetTitle>
        <nav aria-label="Mobile navigation" className={styles.menuLinks}>
          {[
            ["#how-it-works", "How it works"],
            ["/why-proplane", "Why PropLane"],
            ["#pricing", "Pricing"],
            ["/service", "Service"],
            ["/auth/sign-in", "Sign in"],
          ].map(([href, label]) => (
            <SheetClose asChild key={href}>
              <Link href={href} prefetch={false} data-attr={`home-menu-${href.replace(/[^a-z-]/g, "")}`}>{label}</Link>
            </SheetClose>
          ))}
        </nav>
      </SheetContent>
    </Sheet>
  );
}
