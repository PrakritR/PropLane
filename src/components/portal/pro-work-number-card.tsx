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
import { Copy, Check, Mail, Phone, RefreshCw } from "lucide-react";
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
import {
  MANAGER_MESSAGING_SETTINGS_HREF,
  workspaceWorkNumber,
  type ManagerMessagingLineBlock,
} from "@/lib/sms/manager-messaging-number";
import { WORKSPACE_SELECTION_EVENT, selectedWorkspaceId } from "@/lib/workspaces/selection";
import { sharedGet } from "@/lib/shared-get-cache";
import { assistantEmailUrl } from "@/lib/manager-assistant-email/assistant-email-url";

/**
 * One plain line about whether the LINE can actually send right now, or "" when
 * it can. It reads `lineReady`, never the viewer's own `canSend`: a teammate
 * with read-only Communication is looking at the same live workspace number the
 * owner is, and reporting it as "Finishing setup" sends them hunting for a
 * control that is not theirs and does not exist.
 *
 * The WORDING is `lineBlocked`, the status route's own reason. Who is looking
 * is deliberately not an input: a caption that claims setup is unfinished over
 * a live, carrier-approved number is wrong whoever reads it, so "Finishing
 * setup" is reserved for a line that genuinely is not provisioned yet - a live
 * number held by a provider quarantine or grace window reads "Texting paused"
 * - and the teammate gets the same honest sentence the owner does.
 */
export function workNumberReadinessCaption(args: {
  lineReady: boolean;
  sendingAvailable: boolean;
  lineBlocked?: ManagerMessagingLineBlock | null;
}): string {
  if (args.lineReady && args.sendingAvailable) return "";
  if (!args.sendingAvailable) return "Texting is off for this deployment";
  switch (args.lineBlocked) {
    case "deployment":
      return "Texting is off for this deployment";
    case "billing":
      return "Texting is paused for billing";
    case "paused":
      return "Texting paused";
    case "unavailable":
      return "Texting is unavailable right now";
    // An older payload carries no reason at all; the number exists and the
    // deployment can send, so the remaining blocker really is its setup.
    default:
      return "Finishing setup";
  }
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
      void sharedGet(assistantEmailUrl(selectedWorkspaceId()))
        .then(async (res) => {
          if (!res.ok) return null;
          const data: unknown = res.data;
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
  // `bg-accent/50` matches the shimmer tone every other list/card skeleton in
  // the app uses (ListSkeleton, PanelSkeleton, …). The old `bg-muted` block
  // read as a broken, unstyled element rather than "still loading" next to
  // those (night UX sweep).
  return (
    <div
      className="h-[50px] animate-pulse rounded-lg bg-accent/50 motion-reduce:animate-none"
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
  const phone = workspaceWorkNumber(status);
  // "Work number", not "Your work number": the box is half of a two-column grid in the
  // inbox rail, and with a retry action sharing the label line the longer wording was
  // clipped to "Your work nu…". It also reads as a pair with "Work email" beside it.
  const numberLabel = coManager ? "Workspace number" : "Work number";
  const emailLabel = coManager ? "Workspace email" : "Work email";
  const owner = workspace?.ownerName?.trim() || "your workspace owner";

  const numberBox = (() => {
    if (statusError) {
      return (
        <PortalInboxContactCard
          padded={false}
          frame="box"
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
      const statusLine =
        workNumberReadinessCaption({
          lineReady: Boolean(status.lineReady),
          sendingAvailable: Boolean(status.sendingAvailable),
          lineBlocked: status.lineBlocked ?? null,
        }) || undefined;
      return (
        <PortalInboxContactCard
          padded={false}
          frame="box"
          leading={<Phone className="h-4 w-4 shrink-0 text-primary" strokeWidth={1.9} aria-hidden />}
          dataAttr="manager-work-number-card"
          value={formatted}
          label={numberLabel}
          note={statusLine}
          noteTone="warn"
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
          frame="box"
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
          frame="box"
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
        frame="box"
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
          frame="box"
          leading={<Mail className="h-4 w-4 shrink-0 text-primary" strokeWidth={1.9} aria-hidden />}
          dataAttr="manager-work-email-card"
          value={workEmail}
          label={emailLabel}
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
          frame="box"
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
        frame="box"
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
    <div
      // On a phone the two boxes cost ~100px before the first conversation; the number and email
      // are one tap away behind the header's Integrations icon, so they are desktop chrome.
      className="grid min-w-0 shrink-0 grid-cols-2 gap-2 px-3.5 pb-1 pt-3 max-lg:hidden"
      data-attr="manager-work-identity"
    >
      {numberBox}
      {emailBox}
    </div>
  );
}
