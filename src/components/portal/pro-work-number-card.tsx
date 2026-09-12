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
import {
  PORTAL_INBOX_CONTACT_CARD_GLYPH_CLASS,
  PortalInboxContactCard,
} from "@/components/portal/portal-inbox-contact-card";
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

  if (isDemoModeActive()) return null;

  // One work number per workspace. A co-manager leads with the owner's line —
  // the number their replies actually go out from — never a line of their own.
  const coManager = status?.workspaceRole === "co_manager";
  const workspace = status?.workspaceNumber ?? null;
  if (coManager && workspace && !workspace.phoneNumber) {
    // The owner has not set one up. Unlike an owner, the co-manager has no
    // setup button to fall back to, so the card has to say whose job it is.
    const owner = workspace.ownerName?.trim() || "your workspace owner";
    return (
      <PortalInboxContactCard
        dataAttr="manager-work-number-card"
        value="No work number yet"
        label="Workspace number"
        note={`Ask ${owner} to set one up in Settings → Messaging`}
        noteTone="warn"
        leading={
          <span className={PORTAL_INBOX_CONTACT_CARD_GLYPH_CLASS}>
            <Phone className="h-[18px] w-[18px]" strokeWidth={1.9} />
          </span>
        }
        actions={[]}
      />
    );
  }

  const phone = (coManager ? workspace?.phoneNumber?.trim() : status?.number?.phoneNumber?.trim()) || null;
  // No number is not an empty state here — the header's setup button is the
  // surface for that, so this card is simply absent.
  if (!phone) return null;

  const label = formatSmsPhoneLabel(phone) || phone;
  const ready = Boolean(status?.canSend) && Boolean(status?.sendingAvailable);
  const caption = coManager
    ? `${workspace?.ownerName?.trim() ? `${workspace.ownerName.trim()}'s workspace` : "Shared by your workspace"} · ${
        ready ? "Ready to send" : "Finishing setup"
      }`
    : workNumberReadinessCaption({
        canSend: Boolean(status?.canSend),
        sendingAvailable: Boolean(status?.sendingAvailable),
        carrierRegistered: status?.number?.carrierRegistrationState === "registered",
      });

  return (
    <PortalInboxContactCard
      dataAttr="manager-work-number-card"
      value={label}
      label={coManager ? "Workspace number" : "Your work number"}
      note={caption}
      noteTone={ready ? "muted" : "warn"}
      leading={
        <span className={PORTAL_INBOX_CONTACT_CARD_GLYPH_CLASS}>
          <Phone className="h-[18px] w-[18px]" strokeWidth={1.9} />
        </span>
      }
      actions={[
        {
          key: "copy",
          label: copied ? "Copied" : "Copy number",
          dataAttr: "manager-work-number-copy",
          icon: copied ? (
            <Check className="h-4 w-4" strokeWidth={2.2} />
          ) : (
            <Copy className="h-4 w-4" strokeWidth={1.9} />
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
                icon: <Megaphone className="h-4 w-4" strokeWidth={1.9} />,
                onClick: onTellResidents,
              },
            ]
          : []),
      ]}
    />
  );
}
