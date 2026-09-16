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
 * can never disagree about whether a number exists. Work email rides the same
 * card when the workspace has an address.
 */
import { useEffect, useState } from "react";
import { Copy, Check, Mail, Phone } from "lucide-react";
import {
  PORTAL_INBOX_CONTACT_CARD_GLYPH_CLASS,
  PortalInboxContactCard,
  type PortalInboxContactCardAction,
} from "@/components/portal/portal-inbox-contact-card";
import { useManagerMessagingNumberStatus } from "@/hooks/use-manager-messaging-number-status";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import {
  isManagerAssistantEmailStatus,
  managerWorkEmailInUse,
} from "@/lib/manager-assistant-email/manager-assistant-email-status";
import { copyTextToClipboard } from "@/lib/manager-property-links";
import { formatSmsPhoneLabel } from "@/lib/phone-e164";
import { WORKSPACE_SELECTION_EVENT } from "@/lib/workspaces/selection";

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

function useManagerWorkEmail(): string | null {
  const [email, setEmail] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let epoch = 0;

    const load = () => {
      const thisEpoch = ++epoch;
      void fetch("/api/manager/assistant-email", { credentials: "include", cache: "no-store" })
        .then(async (res) => {
          if (!res.ok) return null;
          const data: unknown = await res.json();
          if (!isManagerAssistantEmailStatus(data)) return null;
          return managerWorkEmailInUse(data);
        })
        .then((next) => {
          if (cancelled || thisEpoch !== epoch) return;
          setEmail(next);
        })
        .catch(() => {
          if (cancelled || thisEpoch !== epoch) return;
          setEmail(null);
        });
    };

    load();
    window.addEventListener(WORKSPACE_SELECTION_EVENT, load);
    return () => {
      cancelled = true;
      window.removeEventListener(WORKSPACE_SELECTION_EVENT, load);
    };
  }, []);

  return email;
}

function copyIdentityAction(args: {
  key: string;
  copied: boolean;
  idleLabel: string;
  dataAttr: string;
  text: string;
  onCopied: () => void;
}): PortalInboxContactCardAction {
  return {
    key: args.key,
    label: args.copied ? "Copied" : args.idleLabel,
    dataAttr: args.dataAttr,
    icon: args.copied ? (
      <Check className="h-4 w-4" strokeWidth={2.2} />
    ) : (
      <Copy className="h-4 w-4" strokeWidth={1.9} />
    ),
    onClick: () => {
      void copyTextToClipboard(args.text).then((ok) => {
        if (ok) args.onCopied();
      });
    },
  };
}

export function ManagerWorkNumberCard() {
  const { status } = useManagerMessagingNumberStatus();
  const workEmail = useManagerWorkEmail();
  const [copiedPhone, setCopiedPhone] = useState(false);
  const [copiedEmail, setCopiedEmail] = useState(false);

  useEffect(() => {
    if (!copiedPhone) return;
    const timer = window.setTimeout(() => setCopiedPhone(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copiedPhone]);

  useEffect(() => {
    if (!copiedEmail) return;
    const timer = window.setTimeout(() => setCopiedEmail(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copiedEmail]);

  if (isDemoModeActive()) return null;

  // One work number per workspace. A co-manager leads with the owner's line —
  // the number their replies actually go out from — never a line of their own.
  const coManager = status?.workspaceRole === "co_manager";
  const workspace = status?.workspaceNumber ?? null;
  const phone = (coManager ? workspace?.phoneNumber?.trim() : status?.number?.phoneNumber?.trim()) || null;
  const emailLabel = coManager ? "Workspace email" : "Your work email";
  const emailSecondary = workEmail
    ? {
        leading: (
          <span className={PORTAL_INBOX_CONTACT_CARD_GLYPH_CLASS}>
            <Mail className="h-[18px] w-[18px]" strokeWidth={1.9} />
          </span>
        ),
        value: workEmail,
        label: emailLabel,
        actions: [
          copyIdentityAction({
            key: "copy-email",
            copied: copiedEmail,
            idleLabel: "Copy email",
            dataAttr: "manager-work-email-copy",
            text: workEmail,
            onCopied: () => setCopiedEmail(true),
          }),
        ],
      }
    : undefined;

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
        secondary={emailSecondary}
      />
    );
  }

  // No number is not an empty state here — the header's setup button is the
  // surface for that. An address alone still belongs on this card.
  if (!phone && !workEmail) return null;

  if (!phone && workEmail) {
    return (
      <PortalInboxContactCard
        dataAttr="manager-work-number-card"
        value={workEmail}
        label={emailLabel}
        leading={
          <span className={PORTAL_INBOX_CONTACT_CARD_GLYPH_CLASS}>
            <Mail className="h-[18px] w-[18px]" strokeWidth={1.9} />
          </span>
        }
        actions={[
          copyIdentityAction({
            key: "copy-email",
            copied: copiedEmail,
            idleLabel: "Copy email",
            dataAttr: "manager-work-email-copy",
            text: workEmail,
            onCopied: () => setCopiedEmail(true),
          }),
        ]}
      />
    );
  }

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
        copyIdentityAction({
          key: "copy",
          copied: copiedPhone,
          idleLabel: "Copy number",
          dataAttr: "manager-work-number-copy",
          text: label,
          onCopied: () => setCopiedPhone(true),
        }),
      ]}
      secondary={emailSecondary}
    />
  );
}
