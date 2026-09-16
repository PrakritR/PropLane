"use client";

/**
 * Work number and work email at the top of the manager conversation list.
 *
 * Both boxes are always on screen. A live value shows the number/address plus
 * copy; an empty slot is the same box with "Set up work number" / "Set up work
 * email". There is no Phone glyph and no toolbar setup CTA — this stack is
 * the only entry to provisioning from Communication.
 */
import { useEffect, useState } from "react";
import { Copy, Check, RefreshCw } from "lucide-react";
import {
  PortalInboxContactCard,
  type PortalInboxContactCardAction,
} from "@/components/portal/portal-inbox-contact-card";
import { useManagerMessagingNumberStatus } from "@/hooks/use-manager-messaging-number-status";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import {
  isManagerAssistantEmailStatus,
  managerWorkEmailInUse,
  MANAGER_ASSISTANT_EMAIL_SETTINGS_HREF,
} from "@/lib/manager-assistant-email/manager-assistant-email-status";
import { copyTextToClipboard } from "@/lib/manager-property-links";
import { formatSmsPhoneLabel } from "@/lib/phone-e164";
import { MANAGER_MESSAGING_SETTINGS_HREF } from "@/lib/sms/manager-messaging-number";
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

function useManagerWorkEmail(): { email: string | null; ready: boolean } {
  const [email, setEmail] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let epoch = 0;

    const load = () => {
      const thisEpoch = ++epoch;
      setReady(false);
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
          setReady(true);
        })
        .catch(() => {
          if (cancelled || thisEpoch !== epoch) return;
          setEmail(null);
          setReady(true);
        });
    };

    load();
    window.addEventListener(WORKSPACE_SELECTION_EVENT, load);
    return () => {
      cancelled = true;
      window.removeEventListener(WORKSPACE_SELECTION_EVENT, load);
    };
  }, []);

  return { email, ready };
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

function IdentitySkeleton({ dataAttr }: { dataAttr: string }) {
  return (
    <div
      className="h-[52px] animate-pulse rounded-2xl bg-muted"
      data-attr={dataAttr}
      aria-hidden
    />
  );
}

export function ManagerWorkNumberCard() {
  const { ready, resolved, statusError, status, retry } = useManagerMessagingNumberStatus();
  const { email: workEmail, ready: emailReady } = useManagerWorkEmail();
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

  const coManager = status?.workspaceRole === "co_manager";
  const workspace = status?.workspaceNumber ?? null;
  const phone =
    (coManager ? workspace?.phoneNumber?.trim() : status?.number?.phoneNumber?.trim()) || null;
  const numberLabel = coManager ? "Workspace number" : "Your work number";
  const emailLabel = coManager ? "Workspace email" : "Your work email";
  const owner = workspace?.ownerName?.trim() || "your workspace owner";

  const numberBox = (() => {
    if (statusError) {
      return (
        <PortalInboxContactCard
          padded={false}
          tone="setup"
          dataAttr="manager-work-number-card"
          value="Messaging status unavailable"
          label={numberLabel}
          actions={[
            {
              key: "retry",
              label: "Retry messaging status",
              dataAttr: "messaging-status-retry",
              icon: <RefreshCw className="h-4 w-4" strokeWidth={1.9} />,
              onClick: retry,
            },
          ]}
        />
      );
    }
    if (!ready || !resolved || !status) {
      return <IdentitySkeleton dataAttr="manager-work-number-loading" />;
    }
    if (phone) {
      const formatted = formatSmsPhoneLabel(phone) || phone;
      const sendReady = Boolean(status.canSend) && Boolean(status.sendingAvailable);
      const caption = coManager
        ? `${workspace?.ownerName?.trim() ? `${workspace.ownerName.trim()}'s workspace` : "Shared by your workspace"} · ${
            sendReady ? "Ready to send" : "Finishing setup"
          }`
        : workNumberReadinessCaption({
            canSend: Boolean(status.canSend),
            sendingAvailable: Boolean(status.sendingAvailable),
            carrierRegistered: status.number?.carrierRegistrationState === "registered",
          });
      return (
        <PortalInboxContactCard
          padded={false}
          dataAttr="manager-work-number-card"
          value={formatted}
          label={numberLabel}
          note={caption}
          noteTone={sendReady ? "muted" : "warn"}
          actions={[
            copyIdentityAction({
              key: "copy",
              copied: copiedPhone,
              idleLabel: "Copy number",
              dataAttr: "manager-work-number-copy",
              text: formatted,
              onCopied: () => setCopiedPhone(true),
            }),
          ]}
        />
      );
    }
    if (coManager) {
      return (
        <PortalInboxContactCard
          padded={false}
          tone="setup"
          dataAttr="manager-work-number-card"
          value="No work number yet"
          label={numberLabel}
          note={`Ask ${owner} to set one up in Settings → Messaging`}
          noteTone="warn"
          actions={[]}
        />
      );
    }
    if (status.planTier === "free") {
      return (
        <PortalInboxContactCard
          padded={false}
          tone="setup"
          disabled
          dataAttr="messaging-upsell-locked"
          value="Set up work number"
          label={numberLabel}
          note="Subscribe to Pro to unlock SMS"
          noteTone="warn"
          actions={[]}
        />
      );
    }
    return (
      <PortalInboxContactCard
        padded={false}
        tone="setup"
        href={MANAGER_MESSAGING_SETTINGS_HREF}
        dataAttr="manager-work-number-setup"
        value="Set up work number"
        label={numberLabel}
        actions={[]}
      />
    );
  })();

  const emailBox = (() => {
    if (!emailReady) {
      return <IdentitySkeleton dataAttr="manager-work-email-loading" />;
    }
    if (workEmail) {
      return (
        <PortalInboxContactCard
          padded={false}
          dataAttr="manager-work-email-card"
          value={workEmail}
          label={emailLabel}
          note="Ready to send"
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
    if (coManager) {
      return (
        <PortalInboxContactCard
          padded={false}
          tone="setup"
          dataAttr="manager-work-email-card"
          value="No work email yet"
          label={emailLabel}
          note={`Ask ${owner} to set one up in Settings → Messaging`}
          noteTone="warn"
          actions={[]}
        />
      );
    }
    return (
      <PortalInboxContactCard
        padded={false}
        tone="setup"
        href={MANAGER_ASSISTANT_EMAIL_SETTINGS_HREF}
        dataAttr="manager-work-email-setup"
        value="Set up work email"
        label={emailLabel}
        actions={[]}
      />
    );
  })();

  return (
    <div className="shrink-0 space-y-2 px-3.5 pb-2 pt-3.5" data-attr="manager-work-identity">
      {numberBox}
      {emailBox}
    </div>
  );
}
