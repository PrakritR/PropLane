"use client";

/**
 * "Your work number" — the card at the top of the manager's conversation list.
 *
 * The complement of {@link ManagerWorkNumberButton}, which is the SETUP cta in
 * the page header. That button self-hides once a number is assigned; this card
 * only appears once one is. So exactly one of the two is on screen at a time,
 * and neither can be deleted without losing a state: the button is the only
 * entry to provisioning (and the free-tier upsell behind it), the card is the
 * only place the manager can read the number their residents actually text.
 *
 * Both read the same status through `useManagerMessagingNumberStatus`, so they
 * can never disagree about whether a number exists.
 */
import { useEffect, useState } from "react";
import { Copy, Check, Megaphone, Phone } from "lucide-react";
import { useManagerMessagingNumberStatus } from "@/hooks/use-manager-messaging-number-status";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { formatSmsPhoneLabel } from "@/lib/phone-e164";

const ACTION_CLASS =
  "flex h-[42px] min-w-0 flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-xl border border-primary/35 bg-card px-2.5 text-[13px] font-semibold text-primary transition-colors hover:bg-primary/[0.06]";

/** One plain line about whether the number can actually send right now. */
export function workNumberReadinessCaption(args: {
  canSend: boolean;
  sendingAvailable: boolean;
  carrierRegistered: boolean;
}): string {
  if (!args.sendingAvailable) return "Texting is off for this deployment";
  if (!args.canSend) return "Finishing setup";
  return args.carrierRegistered ? "Ready to send · carrier registered" : "Ready to send";
}

export function ManagerWorkNumberCard({
  onTellResidents,
}: {
  /** Opens compose so the manager can send the number to their residents. */
  onTellResidents?: () => void;
}) {
  const { status } = useManagerMessagingNumberStatus();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const phone = status?.number?.phoneNumber?.trim() || null;
  // No number is not an empty state here — the header's setup button is the
  // surface for that, so this card is simply absent.
  if (!phone || isDemoModeActive()) return null;

  const label = formatSmsPhoneLabel(phone) || phone;
  const ready = Boolean(status?.canSend) && Boolean(status?.sendingAvailable);
  const caption = workNumberReadinessCaption({
    canSend: Boolean(status?.canSend),
    sendingAvailable: Boolean(status?.sendingAvailable),
    carrierRegistered: status?.number?.carrierRegistrationState === "registered",
  });

  return (
    <div className="shrink-0 px-3.5 pb-4 pt-3.5" data-attr="manager-work-number-card">
      <div className="rounded-2xl border border-primary/25 bg-primary/[0.05] px-4 pb-4 pt-3.5">
        <p className="text-[12.5px] font-bold tracking-[-0.01em] text-primary">Your work number</p>

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
            <p className="mt-0.5 text-[13px] leading-snug text-muted">Residents and prospects text this number</p>
            <p className="mt-1.5 flex items-center gap-2 text-xs text-muted">
              <span
                className={`h-[7px] w-[7px] shrink-0 rounded-full ${
                  ready ? "bg-[var(--status-confirmed-fg)]" : "bg-[var(--status-pending-fg)]"
                }`}
                aria-hidden
              />
              {caption}
            </p>
          </div>
        </div>

        <div className="mt-4 flex gap-3">
          <button
            type="button"
            className={ACTION_CLASS}
            data-attr="manager-work-number-copy"
            onClick={() => {
              // Clipboard access can be refused (insecure origin, permissions).
              // A refusal leaves the label unchanged rather than claiming a copy
              // that did not happen.
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
          {onTellResidents ? (
            <button
              type="button"
              className={ACTION_CLASS}
              data-attr="manager-work-number-tell-residents"
              onClick={onTellResidents}
            >
              <Megaphone className="h-4 w-4 shrink-0" strokeWidth={1.9} />
              <span className="truncate">Tell residents</span>
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
