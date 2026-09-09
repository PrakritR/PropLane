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
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { formatSmsPhoneLabel } from "@/lib/phone-e164";

const ACTION_CLASS =
  "flex h-[42px] min-w-0 flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-xl border border-primary/35 bg-card px-2.5 text-[13px] font-semibold text-primary transition-colors hover:bg-primary/[0.06]";

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
    <div className="shrink-0 px-3.5 pb-4 pt-3.5" data-attr="vendor-contact-number-card">
      <div className="rounded-2xl border border-primary/25 bg-primary/[0.05] px-4 pb-4 pt-3.5">
        <p className="text-[12.5px] font-bold tracking-[-0.01em] text-primary">Your contact number</p>

        <div className="mt-3 flex items-center gap-3">
          <span
            className="grid h-[52px] w-[52px] shrink-0 place-items-center rounded-[15px] bg-primary/[0.12] text-primary"
            aria-hidden
          >
            <Phone className="h-6 w-6" strokeWidth={1.8} />
          </span>
          <div className="min-w-0">
            <p className="truncate text-[20px] font-extrabold tabular-nums tracking-[-0.01em] text-foreground">
              {label}
            </p>
            <p className="mt-0.5 text-[13px] leading-snug text-muted">Give this to the managers who dispatch you</p>
            <p className="mt-1.5 truncate text-xs text-muted">Change it in Settings</p>
          </div>
        </div>

        <div className="mt-4 flex gap-3">
          <button
            type="button"
            className={ACTION_CLASS}
            data-attr="vendor-contact-number-copy"
            onClick={() => {
              void navigator.clipboard
                ?.writeText(label)
                .then(() => setCopied(true))
                .catch(() => setCopied(false));
            }}
          >
            {copied ? (
              <Check className="h-4 w-4 shrink-0" strokeWidth={2.2} />
            ) : (
              <Copy className="h-4 w-4 shrink-0" strokeWidth={1.9} />
            )}
            <span className="truncate">{copied ? "Copied" : "Copy number"}</span>
          </button>
          {onTellManagers ? (
            <button
              type="button"
              className={ACTION_CLASS}
              data-attr="vendor-contact-number-tell-managers"
              onClick={onTellManagers}
            >
              <Megaphone className="h-4 w-4 shrink-0" strokeWidth={1.9} />
              <span className="truncate">Tell managers</span>
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
