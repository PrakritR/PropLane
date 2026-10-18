"use client";

import Link from "next/link";
import { homeSwissFont } from "@/components/marketing/fonts/home-swiss-font";
import { ProPlaneMarkIcon } from "@/components/brand/axis-logo";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetTitle,
} from "@/components/ui/sheet";
import styles from "@/components/layout/home-navbar.module.css";

export default function HomeMobileMenu({
  textHref,
  phone,
  onClose,
  restoreFocus,
}: {
  textHref: string;
  phone: string | null;
  onClose: () => void;
  restoreFocus: () => void;
}) {
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent
        side="bottom"
        className={`${styles.menuPanel} ${homeSwissFont.variable}`}
        aria-describedby={undefined}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreFocus();
        }}
      >
        <div className={styles.menuHeader}>
          <SheetTitle className={styles.menuTitle}>
            <ProPlaneMarkIcon />
            PropLane
          </SheetTitle>
          <SheetClose asChild>
            <button type="button" className={styles.menuButton}>
              Close
            </button>
          </SheetClose>
        </div>
        <nav aria-label="Mobile navigation" className={styles.menuLinks}>
          {[
            ["/#how", "How it works", "01"],
            ["/#service", "Service", "03"],
            ["/#pricing", "Pricing", "04"],
            ["/#contact", "Contact", "05"],
            ["/blog", "Blog", "Read"],
            ["/auth/sign-in", "Portal", "Sign in"],
          ].map(([href, label, detail]) => (
            <SheetClose asChild key={href}>
              <Link href={href} prefetch={false} aria-label={label}>
                {label}
                <small aria-hidden="true">{detail}</small>
              </Link>
            </SheetClose>
          ))}
        </nav>
        <SheetClose asChild>
          <a href={textHref} className={styles.menuNumber}>
            {phone ? `Text ${phone}` : "Start free"}
          </a>
        </SheetClose>
      </SheetContent>
    </Sheet>
  );
}
