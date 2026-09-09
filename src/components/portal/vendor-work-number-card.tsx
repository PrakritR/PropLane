"use client";

/**
 * The number a vendor gives out, at the top of their conversation list.
 *
 * ⚠️ It is deliberately labelled "Your contact number", NOT "work number".
 * A PropLane work number is a PROVISIONED, carrier-registered line
 * (`manager-number-provisioning.server.ts`) and nothing in the product
 * provisions one for a vendor account today. What this reads is the vendor's
 * own `profiles.phone` — the number the dispatch flow already reaches them on.
 * Calling that a work number would claim a managed line that does not exist,
 * which is the exact confusion AGENTS.md's SMS rules guard against.
 *
 * Renders nothing when the vendor has not saved a number, rather than an empty
 * card: Settings is where a number gets added.
 */
import { useEffect, useState } from "react";
import { Check, Copy, Megaphone, Phone } from "lucide-react";
import { PortalInboxNumberStrip } from "@/components/portal/portal-inbox-number-strip";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { formatSmsPhoneLabel } from "@/lib/phone-e164";

export function VendorWorkNumberCard({
  onTellManagers,
}: {
  /** Opens compose so the vendor can send the number to a manager. */
  onTellManagers?: () => void;
}) {
  const [phone, setPhone] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (isDemoModeActive()) return;
    let cancelled = false;
    void fetch("/api/vendor/profile", { credentials: "include", cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (cancelled || !body || typeof body !== "object") return;
        const value = (body as { phone?: unknown }).phone;
        setPhone(typeof value === "string" && value.trim() ? value.trim() : null);
      })
      .catch(() => {
        // A missing number is not an error worth showing — the card is absent,
        // exactly as it is before a vendor has saved one.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  if (!phone) return null;
  const label = formatSmsPhoneLabel(phone) || phone;

  return (
    <PortalInboxNumberStrip
      dataAttr="vendor-contact-number-card"
      label="Your number"
      value={label}
      caption="Give this to the managers who dispatch you. Change it in Settings."
      leading={<Phone className="h-[15px] w-[15px]" strokeWidth={1.9} />}
      actions={[
        {
          key: "copy",
          label: copied ? "Copied" : "Copy number",
          dataAttr: "vendor-contact-number-copy",
          icon: copied ? (
            <Check className="h-[15px] w-[15px]" strokeWidth={2.2} />
          ) : (
            <Copy className="h-[15px] w-[15px]" strokeWidth={1.9} />
          ),
          onClick: () => {
            void navigator.clipboard
              ?.writeText(label)
              .then(() => setCopied(true))
              .catch(() => setCopied(false));
          },
        },
        ...(onTellManagers
          ? [
              {
                key: "tell",
                label: "Tell managers",
                dataAttr: "vendor-contact-number-tell-managers",
                icon: <Megaphone className="h-[15px] w-[15px]" strokeWidth={1.9} />,
                onClick: onTellManagers,
              },
            ]
          : []),
      ]}
    />
  );
}
