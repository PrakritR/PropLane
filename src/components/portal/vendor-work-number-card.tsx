"use client";

/**
 * Work number and work email at the top of the vendor conversation list.
 *
 * Same always-on boxes as the manager Communication list. The number is the
 * vendor's `profiles.phone` (not a provisioned Twilio line); the email is the
 * signed-in account. Empty slots are "Set up work number" / "Set up work email"
 * linking to Settings — never a missing card.
 */
import { useEffect, useState } from "react";
import { Copy, Check } from "lucide-react";
import {
  PortalInboxContactCard,
  type PortalInboxContactCardAction,
} from "@/components/portal/portal-inbox-contact-card";
import { usePortalSession } from "@/hooks/use-portal-session";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { copyTextToClipboard } from "@/lib/manager-property-links";
import { formatSmsPhoneLabel } from "@/lib/phone-e164";

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

function IdentitySkeleton({ dataAttr }: { dataAttr: string }) {
  return <div className="h-[52px] animate-pulse rounded-2xl bg-muted" data-attr={dataAttr} aria-hidden />;
}

export function VendorWorkNumberCard({
  onTellManagers: _onTellManagers,
}: {
  /** @deprecated Setup cards link to Settings; compose stays on New message. */
  onTellManagers?: () => void;
}) {
  const { email: sessionEmail, ready: sessionReady } = usePortalSession();
  const [phone, setPhone] = useState<string | null>(null);
  const [ready, setReady] = useState(isDemoModeActive());
  const [copiedPhone, setCopiedPhone] = useState(false);
  const [copiedEmail, setCopiedEmail] = useState(false);

  useEffect(() => {
    if (isDemoModeActive()) {
      setReady(true);
      return;
    }
    let cancelled = false;
    void fetch("/api/vendor/profile", { credentials: "include", cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (cancelled || !body || typeof body !== "object") {
          if (!cancelled) setReady(true);
          return;
        }
        const value = String((body as { contact?: { phone?: string } }).contact?.phone ?? "").trim();
        setPhone(value || null);
        setReady(true);
      })
      .catch(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

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

  const workEmail = sessionEmail?.trim() || null;

  const numberBox = !ready ? (
    <IdentitySkeleton dataAttr="vendor-work-number-loading" />
  ) : phone ? (
    <PortalInboxContactCard
      padded={false}
      dataAttr="vendor-work-number-card"
      value={formatSmsPhoneLabel(phone) || phone}
      label="Your work number"
      actions={[
        copyIdentityAction({
          key: "copy",
          copied: copiedPhone,
          idleLabel: "Copy number",
          dataAttr: "vendor-work-number-copy",
          text: formatSmsPhoneLabel(phone) || phone,
          onCopied: () => setCopiedPhone(true),
        }),
      ]}
    />
  ) : (
    <PortalInboxContactCard
      padded={false}
      tone="setup"
      href="/vendor/profile"
      dataAttr="vendor-work-number-setup"
      value="Set up work number"
      label="Your work number"
      actions={[]}
    />
  );

  const emailBox = !sessionReady ? (
    <IdentitySkeleton dataAttr="vendor-work-email-loading" />
  ) : workEmail ? (
    <PortalInboxContactCard
      padded={false}
      dataAttr="vendor-work-email-card"
      value={workEmail}
      label="Your work email"
      actions={[
        copyIdentityAction({
          key: "copy-email",
          copied: copiedEmail,
          idleLabel: "Copy email",
          dataAttr: "vendor-work-email-copy",
          text: workEmail,
          onCopied: () => setCopiedEmail(true),
        }),
      ]}
    />
  ) : (
    <PortalInboxContactCard
      padded={false}
      tone="setup"
      href="/vendor/profile"
      dataAttr="vendor-work-email-setup"
      value="Set up work email"
      label="Your work email"
      actions={[]}
    />
  );

  return (
    <div className="grid gap-2 px-3 pt-3" data-attr="vendor-work-identity">
      {numberBox}
      {emailBox}
    </div>
  );
}
