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
import { PortalInboxNumberStrip } from "@/components/portal/portal-inbox-number-strip";
import { useManagerMessagingNumberStatus } from "@/hooks/use-manager-messaging-number-status";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { formatSmsPhoneLabel } from "@/lib/phone-e164";

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
    <PortalInboxNumberStrip
      dataAttr="manager-work-number-card"
      label="Work number"
      value={label}
      caption={`Residents and prospects text this number. ${caption}.`}
      ready={ready}
      leading={<Phone className="h-[15px] w-[15px]" strokeWidth={1.9} />}
      actions={[
        {
          key: "copy",
          label: copied ? "Copied" : "Copy number",
          dataAttr: "manager-work-number-copy",
          icon: copied ? (
            <Check className="h-[15px] w-[15px]" strokeWidth={2.2} />
          ) : (
            <Copy className="h-[15px] w-[15px]" strokeWidth={1.9} />
          ),
          // Clipboard access can be refused (insecure origin, permissions). A
          // refusal leaves the label unchanged rather than claiming a copy that
          // did not happen.
          onClick: () => {
            void navigator.clipboard
              ?.writeText(label)
              .then(() => setCopied(true))
              .catch(() => setCopied(false));
          },
        },
        ...(onTellResidents
          ? [
              {
                key: "tell",
                label: "Tell residents",
                dataAttr: "manager-work-number-tell-residents",
                icon: <Megaphone className="h-[15px] w-[15px]" strokeWidth={1.9} />,
                onClick: onTellResidents,
              },
            ]
          : []),
      ]}
    />
  );
}
