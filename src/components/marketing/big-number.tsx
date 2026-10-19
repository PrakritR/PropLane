"use client";

import { MessageCircle } from "lucide-react";
import { usePublicTexting } from "@/components/marketing/public-texting-context";
import type { PublicTextingConfig } from "@/lib/marketing/public-texting";
import { formatPublicPhone } from "@/lib/marketing/format-public-phone";

/** The layout snapshot renders the real number in the first HTML response. */
export function BigNumber({
  config: override,
  className = "",
  label,
  dataAttr = "home-big-number",
}: {
  config?: PublicTextingConfig;
  className?: string;
  dataAttr?: string;
  label?: string;
}) {
  const snapshot = usePublicTexting();
  const config = override ?? snapshot;
  const phone = formatPublicPhone(config.phone);
  if (!phone || !config.smsHref) return null;
  return (
    <a
      href={config.smsHref}
      aria-label={label ? `${label} ${phone}` : `Text ${phone}`}
      className={`home-big-number ${className}`}
      data-attr={dataAttr}
    >
      <MessageCircle aria-hidden="true" className="home-big-number-glyph" />
      {label && (
        <>
          <span className="home-big-number-label">{label}</span>{" "}
        </>
      )}
      <span className="home-big-number-value">{phone}</span>
    </a>
  );
}
