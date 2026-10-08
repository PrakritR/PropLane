"use client";

/**
 * The identity boxes at the top of the admin Communication list - the same two
 * boxes the manager's list opens with (`ManagerWorkNumberCard`): the address mail
 * to PropLane arrives at, and the number texts go out on.
 *
 * The address is the public support mailbox (inbound mail to it lands in the
 * admin inbox, see `docs/agents/inbound-email-inbox.md`). The number is the line
 * the admin SMS stream reads, and is drawn only when that stream reported one - a
 * deployment with no admin number shows the email box alone, never a "set up"
 * prompt for a line admin cannot provision.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { Check, Copy, Mail, Phone } from "lucide-react";
import {
  PortalInboxContactCard,
  type PortalInboxContactCardAction,
} from "@/components/portal/portal-inbox-contact-card";
import { copyTextToClipboard } from "@/lib/manager-property-links";
import { PUBLIC_SUPPORT_EMAIL } from "@/lib/marketing/public-contact";
import { formatSmsPhoneLabel } from "@/lib/phone-e164";

/**
 * The admin SMS number, as the conversation stream last reported it. The inbox
 * already loads that stream, so the card reads it from here instead of making a
 * second request.
 */
let adminWorkNumber: string | null = null;
const listeners = new Set<() => void>();

export function publishAdminWorkNumber(next: string | null): void {
  const value = typeof next === "string" && next.trim() ? next.trim() : null;
  if (value === adminWorkNumber) return;
  adminWorkNumber = value;
  for (const listener of listeners) listener();
}

function useAdminWorkNumber(): string | null {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => {
        listeners.delete(onChange);
      };
    },
    () => adminWorkNumber,
    () => null,
  );
}

function copyAction(args: {
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

export function AdminWorkIdentityCard() {
  const number = useAdminWorkNumber();
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

  const formatted = number ? formatSmsPhoneLabel(number) || number : null;

  return (
    <div
      className={`grid shrink-0 gap-2 px-3.5 pb-1 pt-3 ${formatted ? "grid-cols-2" : "grid-cols-1"}`}
      data-attr="admin-work-identity"
    >
      {formatted ? (
        <PortalInboxContactCard
          padded={false}
          frame="box"
          leading={<Phone className="h-4 w-4 shrink-0 text-primary" strokeWidth={1.9} aria-hidden />}
          dataAttr="admin-work-number-card"
          value={formatted}
          label="PropLane number"
          actions={[
            copyAction({
              key: "copy",
              copied: copiedPhone,
              idleLabel: "Copy number",
              dataAttr: "admin-work-number-copy",
              text: formatted,
              onCopied: () => setCopiedPhone(true),
            }),
          ]}
        />
      ) : null}
      <PortalInboxContactCard
        padded={false}
        frame="box"
        leading={<Mail className="h-4 w-4 shrink-0 text-primary" strokeWidth={1.9} aria-hidden />}
        dataAttr="admin-work-email-card"
        value={PUBLIC_SUPPORT_EMAIL}
        label="PropLane email"
        actions={[
          copyAction({
            key: "copy-email",
            copied: copiedEmail,
            idleLabel: "Copy email",
            dataAttr: "admin-work-email-copy",
            text: PUBLIC_SUPPORT_EMAIL,
            onCopied: () => setCopiedEmail(true),
          }),
        ]}
      />
    </div>
  );
}
