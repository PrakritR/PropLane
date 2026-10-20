"use client";

import { usePathname } from "next/navigation";

/** Pages under /rent are the web channel: they never show a number or a text link (captain, Oct 20). */
export function isRentPath(pathname: string | null | undefined): boolean {
  return pathname === "/rent" || Boolean(pathname?.startsWith("/rent/"));
}

/** The footer's text-us number, drawn everywhere on the public site except /rent. */
export function FooterTextNumber({ phone, smsHref }: { phone: string; smsHref: string }) {
  if (isRentPath(usePathname())) return null;
  return (
    <a href={smsHref} aria-label={`Text ${phone}`} data-attr="footer-text">
      {phone}
    </a>
  );
}
