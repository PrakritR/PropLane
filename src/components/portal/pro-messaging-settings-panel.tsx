"use client";

import Link from "next/link";
import { AlertCircle, CheckCircle2, MessageSquareText } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAppUi } from "@/components/providers/app-ui-provider";
import {
  PortalSettingsField,
  PortalSettingsGroup,
  PortalSettingsSection,
} from "@/components/portal/portal-settings-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal, ModalFooter } from "@/components/ui/modal";
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
import { ManagerCommsBillingPanel } from "@/components/portal/manager-comms-billing-panel";
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
  managerMessagingSenderPoolDiagnostic,
  type ManagerMessagingNumberStatus,
} from "@/lib/sms/manager-messaging-number";

const ENDPOINT = "/api/manager/messaging-number";

function announceStorageKey(phone: string): string {
  return `axis_work_number_announce_v1:${phone}`;
}

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
    .map((resident) => resident.email.trim())
    .filter((email) => email.includes("@"))
    .join(", ");
}

export function buildWorkNumberResidentAnnounceCopy(phone: string): {
  subject: string;
  text: string;
} {
  const formatted = formatManagerMessagingPhone(phone);
  return {
    subject: "New number to reach me",
    text: [
      "Hi,",
      "",
      `Please text me at this new number: ${formatted}`,
      "",
      "Save it in your contacts so maintenance updates, rent reminders, and day-to-day questions go to the right place.",
      "",
      "Thanks,",
      "Your property manager",
    ].join("\n"),
  };
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
  if (status.planTier === "free") {
    return "Upgrade to Pro or Business, then add a payment method for pay-as-you-go texting and voice.";
  }
  if (status.entitlement.eligible) return null;
  switch (status.entitlement.reason) {
    case "trialing":
      return "Dedicated messaging becomes available after your paid subscription begins.";
    case "past_due":
      return "Update your billing details to restore messaging eligibility.";
    case "canceled":
      return "Restart a paid Pro or Business plan to request a messaging number.";
    default:
      // free / legacy_unknown / plan_unreadable on a paid-or-unknown plan.
      return null;
  }
}

/**
 * A number that is provisioned and carrier-registered but still cannot send
 * because this deployment's texting runtime is off. Reporting that as
 * "Approval in progress" sends the manager to Twilio to chase an approval that
 * already happened, when the switch is on our side.
 */
function blockedOnDeploymentSending(
  status: ManagerMessagingNumberStatus,
): boolean {
  return (
    !status.canSend &&
    !status.sendingAvailable &&
    status.number?.state === "active" &&
    !status.number.setupNeedsAttention
  );
}

function numberStatusLabel(status: ManagerMessagingNumberStatus): string {
  if (status.canSend) return "Ready to send";
  if (status.number?.setupNeedsAttention) return "Setup needs attention";
  if (blockedOnDeploymentSending(status)) return "Texting turned off";
  switch (status.number?.state) {
    case "active":
      return "Approval in progress";
    case "provisioning":
      return "Setting up";
    case "failed":
      return "Setup needs attention";
    case "released":
      return "Inactive";
    case "pending_registration":
      return "Request received";
    default:
      return "Not requested";
  }
}

function registrationLabel(status: ManagerMessagingNumberStatus): string {
  if (!status.number) return "Not started";
  if (status.number.carrierRegistrationState === "registered")
    return "Registered";
  if (status.number.carrierRegistrationState === "failed")
    return "Needs attention";
  if (status.number.carrierRegistrationState === "deregistered")
    return "Inactive";
  return "Pending";
}

function inferredUsAreaCode(phone: string | null | undefined): string {
  const digits = phone?.replace(/\D/g, "") ?? "";
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1, 4);
  return digits.length === 10 ? digits.slice(0, 3) : "";
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
    Boolean(candidate.personalPhone) &&
    typeof candidate.personalPhone === "object"
  );
}

export function ManagerMessagingSettingsPanel({
  personalPhoneRefreshKey = 0,
}: {
  personalPhoneRefreshKey?: number;
}) {
  const { showToast } = useAppUi();
  const { userId } = useManagerUserId();
  const [status, setStatus] = useState<ManagerMessagingNumberStatus | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [pendingAction, setPendingAction] = useState<
    "request" | "refresh" | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [areaCode, setAreaCode] = useState("");
  const [announceOpen, setAnnounceOpen] = useState(false);
  const [announceBusy, setAnnounceBusy] = useState(false);
  const [announceSubject, setAnnounceSubject] = useState("");
  const [announceBody, setAnnounceBody] = useState("");
  const [announceSendVia, setAnnounceSendVia] = useState<string[]>(["email"]);
  const { channelsFor } = useManagerCommunicationDeliverVia();

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(ENDPOINT, {
        credentials: "include",
        cache: "no-store",
        signal,
      });
      const body = (await res
        .json()
        .catch(() => ({}))) as ManagerMessagingNumberStatus & {
        error?: string;
      };
      if (!res.ok)
        throw new Error(body.error ?? "Could not load messaging settings.");
      setStatus(body);
      setAreaCode((current) =>
        current || !body.personalPhone.verifiedAt
          ? current
          : inferredUsAreaCode(body.personalPhone.phone),
      );
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
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve().then(() => load(controller.signal));
    return () => controller.abort();
  }, [load, personalPhoneRefreshKey]);

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

  const dismissAnnounce = useCallback((phone: string | null) => {
    if (phone) {
      try {
        window.localStorage.setItem(announceStorageKey(phone), "1");
      } catch {
        /* ignore quota */
      }
    }
    setAnnounceOpen(false);
  }, []);

  const openAnnounceModal = useCallback(
    (phone: string, canSend: boolean) => {
      const copy = buildWorkNumberResidentAnnounceCopy(phone);
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

  const postAction = useCallback(
    async (action: "request_number" | "refresh_eligibility") => {
      setError(null);
      setPendingAction(action === "request_number" ? "request" : "refresh");
      try {
        const res = await fetch(ENDPOINT, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action,
            ...(action === "request_number" && areaCode ? { areaCode } : {}),
          }),
        });
        const body = (await res
          .json()
          .catch(() => ({}))) as ManagerMessagingNumberStatus & {
          error?: string;
        };
        if (!res.ok) {
          // Failed provision responses include the updated public status (e.g.
          // quarantined provisioning with canRequest: false). Apply it so Retry
          // does not stay enabled against a server that will refuse another buy.
          if (isMessagingNumberStatus(body)) setStatus(body);
          setError(body.error ?? "Could not request a messaging number.");
          return;
        }
        setStatus(body);
        const assignedPhone = body.number?.phoneNumber?.trim() || null;
        if (action === "request_number" && assignedPhone) {
          const seenKey = announceStorageKey(assignedPhone);
          const alreadyAnnounced =
            typeof window !== "undefined" &&
            window.localStorage.getItem(seenKey) === "1";
          // Only invite the broadcast once the number can actually carry a
          // reply. See `announceReady` below for why an unusable number must
          // never be advertised to residents.
          if (!alreadyAnnounced && body.canSend)
            openAnnounceModal(assignedPhone, body.canSend);
          showToast(
            body.canSend
              ? "Messaging number ready."
              : "Messaging number assigned. Carrier registration may still be finishing.",
          );
        } else {
          showToast(
            action === "refresh_eligibility"
              ? "Messaging eligibility refreshed."
              : "Messaging number request received.",
          );
        }
      } catch {
        setError("Network error. Check your connection and try again.");
      } finally {
        setPendingAction(null);
      }
    },
    [areaCode, openAnnounceModal, showToast],
  );

  const announceChannels = portalMessageChannelsFromSelection(announceSendVia);
  const announceSmsBlocked = announceChannels.viaSms && !status?.canSend;
  const announceResidents = useMemo(
    () => approvedResidentsForWorkNumberAnnounce(userId),
    [userId, announceOpen],
  );
  const announceRecipientDisplay = formatWorkNumberAnnounceRecipientDisplay(announceResidents);

  const sendResidentAnnounce = useCallback(async () => {
    const phone = status?.number?.phoneNumber?.trim();
    if (!phone) return;
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
      });
      dismissAnnounce(phone);
      showToast(
        result.skipped
          ? "No residents to notify yet."
          : "Residents notified about your new number.",
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
    status?.number?.phoneNumber,
  ]);

  const copyNumber = useCallback(async () => {
    const phone = status?.number?.phoneNumber?.trim();
    if (!phone) return;
    const copied = await copyTextToClipboard(phone);
    showToast(copied ? "Work number copied." : "Could not copy work number.");
  }, [showToast, status?.number?.phoneNumber]);

  if (loading && !status) {
    return (
      <PortalSettingsSection
        title="Work number"
        description="Your dedicated PropLane number for resident and prospect texts."
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
        description="Your dedicated PropLane number for resident and prospect texts."
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
  const phoneNumber = status.number?.phoneNumber ?? null;
  const isCoManager = status.workspaceRole === "co_manager";
  const unverifiedEntitlement = entitlementIsUnverified(status);
  /**
   * Whether it is safe to tell every resident "text me at this number".
   *
   * A stored number is not proof we own it. A record written while one Twilio
   * account was configured keeps reading as an active, carrier-registered work
   * number after the credentials move to a different account — that shipped,
   * and the number in the record resolved to nothing we control. Broadcasting
   * it would have pointed a whole portfolio of residents at a stranger's
   * phone, and an email plus SMS blast is not recallable.
   *
   * `canSend` is the one signal that the number is genuinely operational here:
   * it requires the plan, the send runtime, and a sendable provisioned number.
   * Require it before offering the broadcast, so an unusable number — or one
   * belonging to another account — is never advertised to residents.
   */
  const announceReady = Boolean(phoneNumber) && status.canSend;
  const failureDiagnostic = managerMessagingSenderPoolDiagnostic(
    status.number?.lastError,
  );
  // An unchecked plan must stay actionable before a number exists - otherwise
  // the one account that sees "not checked yet" (a new one, with no number) is
  // the one account with no control that resolves it.
  const canRefreshEligibility =
    !status.entitlement.eligible &&
    (Boolean(phoneNumber) || unverifiedEntitlement);
  const requestPending = numberInProgress;

  return (
    <>
    <ManagerCommsBillingPanel />
    <PortalSettingsSection
      title="Work number"
      description={
        isCoManager
          ? "Your dedicated PropLane number for resident and prospect texts on properties you help manage."
          : "Request and manage the dedicated number residents and prospects use to reach your workspace."
      }
    >
      <PortalSettingsGroup>
        <PortalSettingsField
          label="Work number"
          value={
            phoneNumber
              ? formatManagerMessagingPhone(phoneNumber)
              : "Not assigned"
          }
          action={
            phoneNumber ? (
              <Button
                type="button"
                variant="ghost"
                className="min-h-10 px-3 text-xs"
                onClick={() => copyNumber()}
                data-attr="messaging-number-copy"
              >
                Copy
              </Button>
            ) : undefined
          }
        />
        <PortalSettingsField label="Status" value={numberStatusLabel(status)} />
        <PortalSettingsField
          label="Carrier registration"
          value={registrationLabel(status)}
        />
        <div className="space-y-4 px-4 py-4">
          {status.canSend ? (
            <div className="flex items-start gap-2 text-sm text-foreground">
              <CheckCircle2
                className="mt-0.5 h-4 w-4 shrink-0 text-primary"
                aria-hidden
              />
              <p>
                Your number is ready. New conversations and replies can use it.
              </p>
            </div>
          ) : planMessage ? (
            <div className="space-y-3">
              <p className="text-sm leading-relaxed text-muted">
                {planMessage}
              </p>
              {unverifiedEntitlement ? null : (
                <Button
                  asChild
                  variant="outline"
                  data-attr="messaging-open-billing"
                >
                  <Link href="/portal/profile?tab=billing">View plans</Link>
                </Button>
              )}
            </div>
          ) : status.number?.state === "failed" ? (
            <div className="space-y-2 text-sm leading-relaxed text-muted">
              <p>
                Setup failed before a work number became active. PropLane will
                not purchase another number automatically. Fix the issue below,
                then retry setup when you&apos;re ready.
              </p>
              {failureDiagnostic ? (
                <p
                  className="break-words text-xs"
                  data-attr="messaging-number-failure-diagnostic"
                >
                  Diagnostic: {failureDiagnostic}
                </p>
              ) : null}
            </div>
          ) : status.number?.setupNeedsAttention ? (
            <p className="text-sm leading-relaxed text-muted">
              Setup requires PropLane review, so sending remains off. Your
              existing provider request is preserved and no additional number
              will be purchased automatically.
            </p>
          ) : blockedOnDeploymentSending(status) ? (
            <p className="text-sm leading-relaxed text-muted">
              Your number is registered and assigned, but texting is switched
              off for this workspace, so nothing sends or replies yet. Carrier
              approval is already done — this is a PropLane setting, not
              something to chase with the carrier.
            </p>
          ) : requestPending ? (
            <p className="text-sm leading-relaxed text-muted">
              Your request is in progress. Carrier registration can take time;
              no action is needed right now.
            </p>
          ) : !status.provisioningAvailable ? (
            <p className="text-sm leading-relaxed text-muted">
              Dedicated number setup is in a limited rollout. We&apos;ll make
              the request available here when your account is eligible.
            </p>
          ) : (
            <div className="flex items-start gap-2 text-sm text-muted">
              <MessageSquareText
                className="mt-0.5 h-4 w-4 shrink-0"
                aria-hidden
              />
              <p>
                Request one number for your manager account. Outbound texts from
                Communication, applications, tasks, and reminders use this line.
                It cannot be edited after assignment.
              </p>
            </div>
          )}

          {error ? (
            <div
              className="flex items-start gap-2 text-sm text-danger"
              role="alert"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <p>{error}</p>
            </div>
          ) : null}

          {canRefreshEligibility ? (
            <Button
              type="button"
              variant="outline"
              disabled={pendingAction !== null}
              aria-busy={pendingAction === "refresh"}
              onClick={() => postAction("refresh_eligibility")}
              data-attr="messaging-eligibility-refresh"
            >
              {pendingAction === "refresh"
                ? "Checking…"
                : "Check eligibility"}
            </Button>
          ) : null}

          {/* They said yes during setup but cannot act on it yet — usually a
              plan that does not include messaging. Saying so is the whole point
              of recording the intent; dropping it silently would leave them
              waiting for a number nobody is getting. */}
          {status.requestedAtSignup && !status.canRequest && !status.number?.phoneNumber ? (
            <p className="text-xs text-muted" data-attr="messaging-number-signup-intent">
              You asked for a PropLane number when you created this account. It is waiting on your plan — once messaging
              is included, you can request it here.
            </p>
          ) : null}

          {status.canRequest ? (
            <div className="space-y-3">
              <div className="max-w-44 space-y-1.5">
                <label
                  htmlFor="messaging-number-area-code"
                  className="text-xs font-semibold text-muted"
                >
                  Preferred area code <span className="font-normal">(optional)</span>
                </label>
                <Input
                  id="messaging-number-area-code"
                  inputMode="numeric"
                  autoComplete="tel-area-code"
                  maxLength={3}
                  placeholder="206"
                  value={areaCode}
                  onChange={(event) =>
                    setAreaCode(event.target.value.replace(/\D/g, "").slice(0, 3))
                  }
                  disabled={pendingAction !== null}
                />
              </div>
              <Button
                type="button"
                variant="primary"
                className="min-h-10 rounded-full px-4 text-xs"
                disabled={pendingAction !== null || (areaCode.length > 0 && areaCode.length !== 3)}
                aria-busy={pendingAction === "request"}
                onClick={() => postAction("request_number")}
                data-attr="messaging-number-request"
              >
                {pendingAction === "request"
                  ? "Requesting…"
                  : status.number?.state === "failed"
                    ? "Retry setup"
                    : "Request work number"}
              </Button>
            </div>
          ) : null}

          {announceReady ? (
            <Button
              type="button"
              variant="outline"
              className="min-h-10 rounded-full px-4 text-xs"
              disabled={announceBusy}
              onClick={() => phoneNumber && openAnnounceModal(phoneNumber, status.canSend)}
              data-attr="messaging-announce-residents-open"
            >
              Tell residents about this number
            </Button>
          ) : null}

          {requestPending ? (
            <Button
              type="button"
              variant="ghost"
              className="min-h-10 rounded-full px-3 text-xs"
              disabled={loading}
              onClick={() => load()}
              data-attr="messaging-number-status-refresh"
            >
              {loading ? "Checking…" : "Refresh status"}
            </Button>
          ) : null}
        </div>
      </PortalSettingsGroup>
    </PortalSettingsSection>

    <Modal
      open={announceOpen}
      onClose={() => dismissAnnounce(phoneNumber)}
      title="Tell your residents?"
      description="Move day-to-day texts onto your new PropLane number."
      panelClassName="max-w-lg"
      dataAttr="messaging-announce-residents-modal"
      footer={
        <ModalFooter>
          <Button
            type="button"
            variant="ghost"
            disabled={announceBusy}
            onClick={() => dismissAnnounce(phoneNumber)}
            data-attr="messaging-announce-residents-skip"
          >
            Not now
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={announceBusy || !phoneNumber || announceSmsBlocked}
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
          Want to send a message to all your residents to text this new number now?
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
            footerNote="We'll email and text every resident in your portfolio. Numbers without SMS consent still get the email and portal inbox copy."
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
