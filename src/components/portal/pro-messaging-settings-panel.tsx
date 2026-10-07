"use client";

import { sharedGet, writeThroughFetch } from "@/lib/shared-get-cache";
import { WorkIdentityRow } from "./work-identity-row";
import { AlertCircle, Phone } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { useSettingsPropertyScope } from "@/components/portal/settings-property-scope";
import {
  PortalSettingsField,
  PortalSettingsGroup,
  PortalSettingsSection,
} from "@/components/portal/portal-settings-ui";
import { ChannelRow, ChannelRowMenu, type ChannelRowMenuItem } from "@/components/portal/portal-channel-row";
import { Button } from "@/components/ui/button";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { WorkNumberSetupModal } from "@/components/portal/pro-work-number-setup-modal";
import {
  PORTAL_MESSAGE_COMPOSE_TWO_COL_CLASS,
  PortalMessageBodyField,
  PortalMessageComposeModalBody,
  PortalMessageRecipientReadonly,
  PortalMessageSendViaDropdown,
  PortalMessageSubjectField,
  portalMessageChannelsFromSelection,
} from "@/components/portal/portal-message-compose-fields";
import type { InboxScopedContact } from "@/data/inbox-scoped-directory";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import { buildManagerInboxLiveContacts } from "@/lib/manager-inbox-contacts";
import { ManagerSmsWorkNumberHint } from "@/components/portal/pro-sms-work-number-hint";
import { useManagerCommunicationDeliverVia } from "@/hooks/use-manager-communication-deliver-via";
import {
  portalMessageSelectionFromDeliverVia,
} from "@/lib/manager-communication-deliver-via";
import { copyTextToClipboard } from "@/lib/manager-property-links";
import { deliverPortalInboxMessage } from "@/lib/portal-message-delivery";
import { track } from "@/lib/analytics/track-client";
import {
  formatManagerMessagingPhone,
  type ManagerMessagingNumberStatus,
} from "@/lib/sms/manager-messaging-number";
import { workNumberStatusWord, type WorkNumberStatusInput } from "@/lib/sms/work-number-status";
import { isManagerAssistantEmailStatus } from "@/lib/manager-assistant-email/manager-assistant-email-status";
import { ManagerAssistantEmailChannelRow } from "@/components/portal/pro-assistant-email-settings-panel";
import {
  buildWorkContactAnnounceCopy,
  hasAnyWorkContactChannel,
  WORK_CONTACT_ANNOUNCE_EVENT,
  workContactAnnounceChannelTag,
  workContactAnnounceStorageKey,
  type WorkContactChannels,
} from "@/lib/work-contact-announce";

const ENDPOINT = "/api/manager/messaging-number";
/** Mirrors `WORKSPACE_WORK_NUMBER_LIMIT` in src/lib/sms/work-numbers.server.ts (server-only, not importable from a client component). */
const WORKSPACE_NUMBER_LIMIT = 1;

type WorkspaceWithNumbers = NonNullable<ManagerMessagingNumberStatus["workspaces"]>[number];



/** Approved residents only — matches server broadcast resolution for `toBroadcast: ["resident"]`. */
export function approvedResidentsForWorkNumberAnnounce(
  userId: string | null,
): InboxScopedContact[] {
  return buildManagerInboxLiveContacts(userId).filter(
    (contact) => contact.role === "resident" && contact.tenancyStatus === "resident",
  );
}

export function formatWorkNumberAnnounceRecipientDisplay(
  residents: InboxScopedContact[],
): string {
  if (residents.length === 0) return "No residents to notify yet";
  return residents
    .map((resident) =>
      typeof resident?.email === "string" ? resident.email.trim() : "",
    )
    .filter((email) => email.includes("@"))
    .join(", ");
}

/**
 * Kept as the work number's own announcement for callers that only ever have a
 * number. The panel itself now composes one message covering every live
 * channel — see `buildWorkContactAnnounceCopy`.
 */
export function buildWorkNumberResidentAnnounceCopy(phone: string): {
  subject: string;
  text: string;
} {
  return buildWorkContactAnnounceCopy({ phone, email: null });
}

/**
 * An entitlement a billing re-read can still resolve, as opposed to a settled
 * answer about the plan. A brand-new manager lands here: they have no stored
 * entitlement row yet, and a missing row reads back as `plan_unreadable`.
 */
function entitlementIsUnverified(
  status: ManagerMessagingNumberStatus,
): boolean {
  return (
    !status.entitlement.eligible &&
    (status.entitlement.reason === "plan_unreadable" ||
      status.entitlement.reason === "legacy_unknown")
  );
}

/**
 * The upsell/billing line shown above "View plans". Only a genuinely FREE plan,
 * or a paid plan whose subscription has lapsed, warrants it. A paid manager
 * whose entitlement simply hasn't been reconciled yet (`legacy_unknown` /
 * `plan_unreadable` — the state of every paid account before its first number
 * request) must NOT see a free-tier prompt; it falls through to the request
 * flow, where POST performs the authoritative Stripe/Apple reconciliation.
 */
function messagingUpsellMessage(
  status: ManagerMessagingNumberStatus,
): string | null {
  if (status.entitlement.eligible || entitlementIsUnverified(status)) return null;
  // Round 3 plan model: a work number is a paid feature. Free upgrades; a
  // trial waits for its first payment (a promo-code plan counts as paid).
  switch (status.entitlement.reason) {
    case "free":
      return "Free accounts cannot use a work number. Upgrade to a paid Pro or Business plan to activate one.";
    case "trialing":
      return "Available on Pro. Start Pro to set up a work number.";
    case "past_due":
      return "Your subscription payment is past due. Update your card to keep your work number.";
    case "canceled":
      return "Your paid plan has ended. Choose Pro or Business to set up a work number again.";
    default:
      return "Refresh eligibility to verify your plan.";
  }
}

function isMessagingNumberStatus(
  value: unknown,
): value is ManagerMessagingNumberStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<ManagerMessagingNumberStatus>;
  return (
    typeof candidate.mode === "string" &&
    typeof candidate.workspaceRole === "string" &&
    typeof candidate.provisioningAvailable === "boolean" &&
    typeof candidate.canRequest === "boolean" &&
    typeof candidate.canSend === "boolean" &&
    Boolean(candidate.entitlement) &&
    typeof candidate.entitlement === "object" &&
    Boolean(candidate.personalPhone) &&
    typeof candidate.personalPhone === "object"
  );
}

export function ManagerMessagingSettingsPanel() {
  const { showToast } = useAppUi();
  const { userId } = useManagerUserId();
  const scope = useSettingsPropertyScope();
  const messagingUrl = scope.workspaceId
    ? `${ENDPOINT}?workspaceId=${encodeURIComponent(scope.workspaceId)}`
    : ENDPOINT;
  const [status, setStatus] = useState<ManagerMessagingNumberStatus | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [announceOpen, setAnnounceOpen] = useState(false);
  const [announceBusy, setAnnounceBusy] = useState(false);
  const [announceSubject, setAnnounceSubject] = useState("");
  const [announceBody, setAnnounceBody] = useState("");
  const [announceSendVia, setAnnounceSendVia] = useState<string[]>(["email"]);
  /**
   * The work email, read only so the announcement can name it. The Work email
   * card owns its own setup; this panel just needs to know whether that channel
   * is live, because a resident should hear "here is how to reach me" once.
   */
  const [workEmail, setWorkEmail] = useState<string | null>(null);
  const { channelsFor } = useManagerCommunicationDeliverVia();

  // Channels list: which owned workspace's rows are visible, the Add-number
  // sheet's target + busy state, and per-row remove busy keys.
  const channelFilter = scope.workspaceId || status?.workspace?.id || "";
  const [addNumberOpen, setAddNumberOpen] = useState(false);
  const [addNumberWorkspaceId, setAddNumberWorkspaceId] = useState("");
  const [rowBusyKey, setRowBusyKey] = useState<string | null>(null);


  const load = useCallback(async (signal?: AbortSignal, opts?: { refreshEligibility?: boolean }) => {
    setLoading(true);
    setError(null);
    try {
      let body: (ManagerMessagingNumberStatus & { error?: string }) | null = null;
      let ok = false;
      if (opts?.refreshEligibility) {
        // A write: it settles eligibility server-side, so every cached read of the route is dropped.
        const res = await writeThroughFetch(
          ENDPOINT,
          {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "refresh_eligibility",
              ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}),
            }),
            signal,
          },
          { invalidatePrefix: ENDPOINT },
        );
        if (res.ok) {
          ok = true;
          body = (await res.json().catch(() => ({}))) as ManagerMessagingNumberStatus & { error?: string };
        } else {
          const read = await sharedGet(messagingUrl);
          ok = read.ok;
          body = read.data as typeof body;
        }
      } else {
        const read = await sharedGet(messagingUrl);
        ok = read.ok;
        body = read.data as typeof body;
      }
      if (signal?.aborted) return;
      if (!ok) throw new Error(body?.error ?? "Could not load messaging settings.");
      if (!body || !isMessagingNumberStatus(body)) {
        throw new Error("Messaging settings returned an invalid response.");
      }
      setStatus(body);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not load messaging settings.",
      );
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [messagingUrl, scope.workspaceId]);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve().then(() => load(controller.signal, { refreshEligibility: true }));
    return () => controller.abort();
  }, [load]);

  // Best-effort: a failed read simply leaves the announcement about the number,
  // exactly as it was before there was an email to name.
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch(
          scope.workspaceId
            ? `/api/manager/assistant-email?workspaceId=${encodeURIComponent(scope.workspaceId)}`
            : "/api/manager/assistant-email",
          {
            credentials: "include",
            cache: "no-store",
            signal: controller.signal,
          },
        );
        if (!res.ok) return;
        const body: unknown = await res.json().catch(() => null);
        if (!isManagerAssistantEmailStatus(body)) return;
        setWorkEmail(body.canUse ? body.address?.trim() || null : null);
      } catch {
        /* the announcement degrades to number-only */
      }
    })();
    return () => controller.abort();
  }, [scope.workspaceId]);

  const numberInProgress =
    status?.number?.state === "pending_registration" ||
    status?.number?.state === "provisioning";
  useEffect(() => {
    if (!numberInProgress) return;
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 12_000);
    return () => window.clearInterval(interval);
  }, [load, numberInProgress]);

  const dismissAnnounce = useCallback((channels: WorkContactChannels) => {
    if (hasAnyWorkContactChannel(channels)) {
      try {
        window.localStorage.setItem(workContactAnnounceStorageKey(channels), "1");
      } catch {
        /* ignore quota */
      }
    }
    setAnnounceOpen(false);
  }, []);

  const openAnnounceModal = useCallback(
    (channels: WorkContactChannels, canSend: boolean) => {
      if (!hasAnyWorkContactChannel(channels)) return;
      const copy = buildWorkContactAnnounceCopy(channels);
      const messageDefaults = channelsFor("messages");
      setAnnounceSubject(copy.subject);
      setAnnounceBody(copy.text);
      setAnnounceSendVia(
        portalMessageSelectionFromDeliverVia(messageDefaults, canSend),
      );
      setAnnounceOpen(true);
    },
    [channelsFor],
  );

  const announceChannels = portalMessageChannelsFromSelection(announceSendVia);
  const announceSmsBlocked = announceChannels.viaSms && !status?.canSend;
  const statusPhoneNumber =
    typeof status?.number?.phoneNumber === "string"
      ? status.number.phoneNumber.trim()
      : "";
  const announceResidents = announceOpen
    ? approvedResidentsForWorkNumberAnnounce(userId)
    : [];
  const announceRecipientDisplay = formatWorkNumberAnnounceRecipientDisplay(announceResidents);

  const sendResidentAnnounce = useCallback(async () => {
    const channels: WorkContactChannels = { phone: statusPhoneNumber || null, email: workEmail };
    if (!hasAnyWorkContactChannel(channels)) return;
    const subject = announceSubject.trim();
    const body = announceBody.trim();
    if (!subject || !body) {
      setError("Subject and message are required.");
      showToast("Subject and message are required.");
      return;
    }
    if (!announceChannels.viaEmail && !announceChannels.viaSms) {
      showToast("Choose at least one channel under Send via.");
      return;
    }
    if (announceSmsBlocked) {
      showToast("Finish work number setup before sending SMS.");
      return;
    }
    setAnnounceBusy(true);
    setError(null);
    try {
      const result = await deliverPortalInboxMessage({
        fromName: "Property Manager",
        toBroadcast: ["resident"],
        subject,
        text: body,
        deliverViaEmail: announceChannels.viaEmail,
        deliverViaSms: announceChannels.viaSms,
        eventCategory: "messages",
      });
      if (!result.ok) {
        setError(result.error ?? "Could not notify residents.");
        showToast(result.error ?? "Could not notify residents.");
        return;
      }
      track("work_number_announce_sent", {
        channel:
          announceChannels.viaEmail && announceChannels.viaSms
            ? "email_sms"
            : announceChannels.viaSms
              ? "sms"
              : "email",
        announced: workContactAnnounceChannelTag(channels),
      });
      dismissAnnounce(channels);
      showToast(
        result.skipped
          ? "No residents to notify yet."
          : "Residents notified about how to reach you.",
      );
    } catch {
      setError("Could not notify residents.");
      showToast("Could not notify residents.");
    } finally {
      setAnnounceBusy(false);
    }
  }, [
    announceBody,
    announceChannels.viaEmail,
    announceChannels.viaSms,
    announceSmsBlocked,
    announceSubject,
    dismissAnnounce,
    showToast,
    statusPhoneNumber,
    workEmail,
  ]);

  const copyNumber = useCallback(async (override?: string) => {
    const phone = override || statusPhoneNumber;
    if (!phone) return;
    const copied = await copyTextToClipboard(phone);
    showToast(copied ? "Work number copied." : "Could not copy work number.");
  }, [showToast, statusPhoneNumber]);

  const removeNumber = useCallback(
    async (workspaceId: string, numberId: string) => {
      setRowBusyKey(`${workspaceId}:${numberId}:remove`);
      setError(null);
      try {
        const res = await writeThroughFetch(
          ENDPOINT,
          {
            method: "PATCH",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "unassign", numberId, workspaceId }),
          },
          { invalidatePrefix: ENDPOINT },
        );
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) {
          const message = body.error ?? "Could not remove this number.";
          setError(message);
          showToast(message);
          return;
        }
        showToast("Number removed from this workspace.");
        void load();
      } catch {
        setError("Network error. Check your connection and try again.");
      } finally {
        setRowBusyKey(null);
      }
    },
    [load, showToast],
  );

  /**
   * The Work email card's "Tell residents about this address" opens THIS
   * composer rather than growing a second one, so a resident is told once and
   * the message names every live channel. Both cards are always rendered
   * together by the profile client, so the event always has a listener.
   */
  const canSend = status?.canSend === true;
  useEffect(() => {
    const open = () =>
      openAnnounceModal({ phone: canSend ? statusPhoneNumber || null : null, email: workEmail }, canSend);
    window.addEventListener(WORK_CONTACT_ANNOUNCE_EVENT, open);
    return () => window.removeEventListener(WORK_CONTACT_ANNOUNCE_EVENT, open);
  }, [canSend, openAnnounceModal, statusPhoneNumber, workEmail]);

  if (loading && !status) {
    return (
      <PortalSettingsSection
        title="Work number"
      >
        <PortalSettingsGroup>
          <div
            className="space-y-3 px-4 py-5"
            aria-label="Loading messaging settings"
          >
            <div className="h-4 w-36 animate-pulse rounded bg-accent motion-reduce:animate-none" />
            <div className="h-3 w-full max-w-md animate-pulse rounded bg-accent motion-reduce:animate-none" />
            <div className="h-11 w-32 animate-pulse rounded-full bg-accent motion-reduce:animate-none" />
          </div>
        </PortalSettingsGroup>
      </PortalSettingsSection>
    );
  }

  if (!status) {
    return (
      <PortalSettingsSection
        title="Work number"
      >
        <PortalSettingsGroup>
          <div className="flex flex-col items-start gap-3 px-4 py-5">
            <div className="flex items-center gap-2 text-danger">
              <AlertCircle className="h-4 w-4" aria-hidden />
              <p className="text-sm font-medium">
                Couldn&apos;t load messaging settings
              </p>
            </div>
            <p className="text-sm text-muted">
              {error ?? "Try again in a moment."}
            </p>
            <Button
              type="button"
              variant="outline"
              onClick={() => load()}
              data-attr="messaging-status-retry"
            >
              Try again
            </Button>
          </div>
        </PortalSettingsGroup>
      </PortalSettingsSection>
    );
  }

  const planMessage = messagingUpsellMessage(status);
  const phoneNumber = statusPhoneNumber || null;
  const isCoManager = status.workspaceRole === "co_manager";
  // One line per WORKSPACE. When the account can see more than one, the
  // section header offers every workspace's line, owned or shared, so a
  // manager with a second workspace sees at a glance which has a number and
  // whose it is — and never mistakes a neighbour's for this one's.
  const allWorkspaces = status.workspaces ?? [];
  const unverifiedEntitlement = entitlementIsUnverified(status);
  // Only advertise a number that can actually carry a reply (canSend) — never an
  // unusable or foreign number (see the announce modal).
  const announceChannelsLive: WorkContactChannels = {
    phone: phoneNumber && status.canSend ? phoneNumber : null,
    email: workEmail,
  };
  const announceReady = hasAnyWorkContactChannel(announceChannelsLive);

  // One work number per workspace. A co-manager reads the owner's line here —
  // nothing to request, no plan upsell, no area code. A legacy line of their
  // own (bought before numbers were workspace-owned) is named so they know it
  // is being retired, but it is never the number this panel leads with.
  if (isCoManager) {
    const workspacePhone = status.workspaceNumber?.phoneNumber?.trim() || "";
    return <PortalSettingsSection title="Work identity"><PortalSettingsGroup>
      <WorkIdentityRow label="Workspace number" value={workspacePhone ? `${formatManagerMessagingPhone(workspacePhone)} · ${status.canSend ? "Ready" : "Not ready"}` : "Not set up"}>
        <PortalSettingsField label="Workspace number" value={workspacePhone ? formatManagerMessagingPhone(workspacePhone) : "Not set up"} />
        <PortalSettingsField label="Managed by" value={status.workspaceNumber?.ownerName || "Workspace owner"} />
        {workspacePhone ? <Button variant="ghost" onClick={() => copyNumber(workspacePhone)}>Copy number</Button> : null}
      </WorkIdentityRow>
      <ManagerAssistantEmailChannelRow filterWorkspaceId={channelFilter} />
    </PortalSettingsGroup></PortalSettingsSection>;
  }

  // Every owned workspace — the ones the Channels list actually manages.
  // A co-manager never reaches this branch (handled above).
  const ownedWorkspaces: WorkspaceWithNumbers[] = allWorkspaces.filter((w) => w.owned);
  const visibleWorkspaces =
    ownedWorkspaces.filter((w) => w.workspaceId === channelFilter);
  const canAddNumberTo = (workspace: WorkspaceWithNumbers) => {
    const numbers = workspace.numbers ?? [];
    return !numbers.some((n) => n.isPrimary) && numbers.length < WORKSPACE_NUMBER_LIMIT;
  };
  /**
   * The row for the account's own currently-active number gets the richer
   * carrier/setup detail `status.number` carries; every other row (another
   * owned workspace's line) only has `WorkspaceNumberEntry.provisionState` —
   * see `work-number-status.ts`'s doc comment for why that is unavoidable.
   */
  const rowStatusInput = (workspace: WorkspaceWithNumbers, entry: NonNullable<WorkspaceWithNumbers["numbers"]>[number]): WorkNumberStatusInput => {
    if (workspace.workspaceId === status.workspace?.id && entry.isPrimary && status.number) {
      return {
        state: status.number.state,
        carrierRegistrationState: status.number.carrierRegistrationState,
        setupNeedsAttention: status.number.setupNeedsAttention,
        canSend: status.canSend,
      };
    }
    return { state: entry.provisionState };
  };
  const openAddNumberSheet = (workspaceId: string) => {
    setAddNumberWorkspaceId(workspaceId);
    setError(null);
    setAddNumberOpen(true);
  };
  const addNumberWorkspaceName =
    ownedWorkspaces.find((w) => w.workspaceId === addNumberWorkspaceId)?.workspaceName ??
    status.workspace?.name ??
    "Workspace";

  return (
    <>
    <PortalSettingsSection title="Work identity">
      <PortalSettingsGroup>
        {visibleWorkspaces.map((workspace) => {
          const numbers = workspace.numbers ?? [];
          const canRequest = canAddNumberTo(workspace);
          return (
            <div key={workspace.workspaceId}>
              {numbers.map((entry) => {
                // One work number per workspace. Set-up (primary) → Share /
                // Copy only — never Remove. Legacy shared-in rows keep Remove
                // so the list can shed retired cross-workspace shares.
                const menuItems: ChannelRowMenuItem[] = entry.isPrimary
                  ? [
                      {
                        key: "share",
                        label: "Share with residents",
                        onClick: () =>
                          window.dispatchEvent(new CustomEvent(WORK_CONTACT_ANNOUNCE_EVENT)),
                      },
                      ...(entry.phoneNumber
                        ? [
                            {
                              key: "copy",
                              label: "Copy number",
                              onClick: () => void copyNumber(entry.phoneNumber ?? undefined),
                            } satisfies ChannelRowMenuItem,
                          ]
                        : []),
                    ]
                  : [
                      {
                        key: "remove",
                        label: "Remove",
                        tone: "danger" as const,
                        disabled: rowBusyKey === `${workspace.workspaceId}:${entry.numberId}:remove`,
                        onClick: () => void removeNumber(workspace.workspaceId, entry.numberId),
                      },
                    ];
                return (
                  <WorkIdentityRow key={entry.numberId} label="Work number" value={`${entry.phoneNumber ? formatManagerMessagingPhone(entry.phoneNumber) : "Assigning"} · ${workNumberStatusWord(rowStatusInput(workspace, entry))}`}><ChannelRow
                    icon={Phone}
                    channel={
                      <>Work number · {entry.phoneNumber ? formatManagerMessagingPhone(entry.phoneNumber) : "assigning"}</>
                    }
                    workspace={
                      entry.isPrimary
                        ? workspace.workspaceName
                        : `${workspace.workspaceName} · shared with ${entry.sharedWithWorkspaceNames[0] || "another workspace"}`
                    }
                    status={workNumberStatusWord(rowStatusInput(workspace, entry))}
                    menu={
                      <ChannelRowMenu
                        label={`${entry.phoneNumber ? formatManagerMessagingPhone(entry.phoneNumber) : "Work number"} actions`}
                        items={menuItems}
                        dataAttr="channel-number-menu"
                      />
                    }
                    dataAttr="channel-row-number"
                  /></WorkIdentityRow>
                );
              })}
              {/* One number per workspace: empty → placeholder row; Setup only in ⋯ (no header + / dashed Add). */}
              {canRequest ? (
                <WorkIdentityRow label="Work number" value="Set up" onOpen={() => openAddNumberSheet(workspace.workspaceId)} dataAttr="channel-row-number-empty" />
              ) : null}
            </div>
          );
        })}
        <ManagerAssistantEmailChannelRow filterWorkspaceId={channelFilter} />
        {error ? (
          <div className="flex items-start gap-2 px-4 py-3 text-sm text-danger" role="alert">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <p>{error}</p>
          </div>
        ) : null}
      </PortalSettingsGroup>
    </PortalSettingsSection>

    {addNumberOpen && addNumberWorkspaceId ? (
      <WorkNumberSetupModal
        open={addNumberOpen}
        onClose={() => {
          setAddNumberOpen(false);
          void load();
        }}
        workspaceId={addNumberWorkspaceId}
        workspaceName={addNumberWorkspaceName}
        status={status}
        planMessage={planMessage}
        unverifiedEntitlement={unverifiedEntitlement}
        onStatusChange={(next) => {
          const workspace = next.workspaces?.find((w) => w.workspaceId === addNumberWorkspaceId);
          const prevEntry = status.workspaces?.find((w) => w.workspaceId === addNumberWorkspaceId);
          const hadPhone = Boolean(
            prevEntry?.numbers?.find((n) => n.isPrimary)?.phoneNumber?.trim(),
          );
          setStatus(next);
          const assignedPhone =
            workspace?.numbers?.find((n) => n.isPrimary)?.phoneNumber?.trim() ||
            (next.workspace?.id === addNumberWorkspaceId
              ? next.number?.phoneNumber?.trim()
              : "") ||
            null;
          if (assignedPhone && !hadPhone && next.canSend) {
            const channels = { phone: assignedPhone, email: workEmail };
            const alreadyAnnounced =
              typeof window !== "undefined" &&
              window.localStorage.getItem(workContactAnnounceStorageKey(channels)) === "1";
            if (!alreadyAnnounced) openAnnounceModal(channels, next.canSend);
          }
        }}
      />
    ) : null}

    <Modal
      open={announceOpen}
      onClose={() => dismissAnnounce(announceChannelsLive)}
      title="Tell your residents?"
      description={
        announceChannelsLive.phone && announceChannelsLive.email
          ? "Move day-to-day messages onto your PropLane number and work email."
          : announceChannelsLive.email
            ? "Move day-to-day messages onto your new PropLane work email."
            : "Move day-to-day texts onto your new PropLane number."
      }
      panelClassName="max-w-lg"
      dataAttr="messaging-announce-residents-modal"
      footer={
        <ModalFooter>
          
          <Button
            type="button"
            variant="primary"
            disabled={announceBusy || !announceReady || announceSmsBlocked}
            aria-busy={announceBusy}
            onClick={() => sendResidentAnnounce()}
            data-attr="messaging-announce-residents-send"
          >
            {announceBusy ? "Sending…" : "Notify all residents"}
          </Button>
        </ModalFooter>
      }
    >
      <PortalMessageComposeModalBody>
        <p className="text-sm leading-relaxed text-muted">
          Want to send a message to all your residents about how to reach you now?
        </p>
        <PortalMessageRecipientReadonly
          recipient={announceRecipientDisplay}
          wrap={announceResidents.length > 1}
        />
        <div className={PORTAL_MESSAGE_COMPOSE_TWO_COL_CLASS}>
          <PortalMessageSubjectField
            id="work-number-announce-subject"
            value={announceSubject}
            onChange={setAnnounceSubject}
            disabled={announceBusy}
            dataAttr="messaging-announce-subject"
          />
          <PortalMessageSendViaDropdown
            selected={announceSendVia}
            onChange={setAnnounceSendVia}
            smsAvailable={status?.canSend === true}
            disabled={announceBusy}
            footerNote=""
            dataAttr="messaging-announce-send-via"
          />
        </div>
        <PortalMessageBodyField
          id="work-number-announce-body"
          value={announceBody}
          onChange={setAnnounceBody}
          disabled={announceBusy}
          minHeightClass="min-h-[8rem]"
          dataAttr="messaging-announce-body"
        />
        {announceChannels.viaSms && phoneNumber ? (
          <ManagerSmsWorkNumberHint show phone={phoneNumber} canSend={status?.canSend === true} />
        ) : announceSmsBlocked ? (
          <ManagerSmsWorkNumberHint
            show
            phone={phoneNumber}
            canSend={false}
          />
        ) : null}
      </PortalMessageComposeModalBody>
    </Modal>
    </>
  );
}

