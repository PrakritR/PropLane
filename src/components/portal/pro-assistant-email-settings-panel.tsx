"use client";

import Link from "next/link";
import { AlertCircle, CheckCircle2, Mail } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAppUi } from "@/components/providers/app-ui-provider";
import {
  PortalSettingsField,
  PortalSettingsGroup,
  PortalSettingsSection,
} from "@/components/portal/portal-settings-ui";
import { Button } from "@/components/ui/button";
import { copyTextToClipboard } from "@/lib/manager-property-links";
import {
  assistantEmailEntitlementIsUnverified,
  assistantEmailUpsellMessage,
} from "@/lib/manager-assistant-email/assistant-email-eligibility-copy";
import type { ManagerAssistantEmailStatus } from "@/lib/manager-assistant-email/manager-assistant-email-status";
import { WORK_CONTACT_ANNOUNCE_EVENT } from "@/lib/work-contact-announce";

const ENDPOINT = "/api/manager/assistant-email";

/** The Status row — the email's answer to the work number's "Status". */
export function workEmailStatusLabel(status: ManagerAssistantEmailStatus): string {
  switch (status.state) {
    case "ready":
      return "Ready";
    case "assigned_send_off":
      return "Assigned — replies off";
    case "assigned_plan_hold":
      return "Assigned — paused on your plan";
    case "requestable":
      return "Not set up";
    case "storage_unavailable":
      return "Setup unavailable";
    case "unavailable":
      return status.planTier === "free" ? "Not available on your plan" : "Not set up";
  }
}

/**
 * The "Who can write in" row.
 *
 * This is the email's analogue of the number's "Carrier registration": the one
 * fact a manager cannot guess from the address itself. Three different people
 * may write to it and each reaches a different assistant, and until now nothing
 * in the product said so anywhere.
 */
export function workEmailAudienceLabel(status: ManagerAssistantEmailStatus): string {
  if (status.state === "ready") return "You, your residents, and prospects";
  if (status.state === "assigned_send_off") return "Nobody until replies are switched on";
  if (status.state === "assigned_plan_hold") return "Nobody until your plan is active again";
  return "Nobody yet";
}

export function ManagerAssistantEmailSettingsPanel() {
  const { showToast } = useAppUi();
  const [status, setStatus] = useState<ManagerAssistantEmailStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingAction, setPendingAction] = useState<"request" | "refresh" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(ENDPOINT, { credentials: "include", cache: "no-store", signal });
      const body = (await res.json().catch(() => ({}))) as ManagerAssistantEmailStatus & {
        error?: string;
      };
      if (!res.ok) throw new Error(body.error ?? "Could not load work email settings.");
      setStatus(body);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setError(cause instanceof Error ? cause.message : "Could not load work email settings.");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve().then(() => load(controller.signal));
    return () => controller.abort();
  }, [load]);

  const copyAddress = useCallback(async () => {
    const address = status?.address;
    if (!address) return;
    const ok = await copyTextToClipboard(address);
    showToast(ok ? "Work email copied." : "Could not copy address.");
  }, [showToast, status?.address]);

  /**
   * Settle an unverified plan by itself, instead of behind a button. Reading
   * the billing source needs no human judgement, and the account that saw
   * "Check eligibility" was a new one with no stored entitlement row — the
   * least likely to know what the button was for.
   *
   * It cannot become a billing ping: the server gates on the ABSENCE of that
   * row, throttles the endpoint to three calls a minute, and writes a row on
   * every resolved outcome; the ref holds this to a single attempt per mount.
   * Later plan changes arrive through the Stripe and RevenueCat webhooks,
   * which reconcile the same entitlement.
   */
  const settleAttemptedRef = useRef(false);
  const entitlementUnverified = status
    ? assistantEmailEntitlementIsUnverified(status.entitlement)
    : false;
  useEffect(() => {
    if (!entitlementUnverified || settleAttemptedRef.current) return;
    settleAttemptedRef.current = true;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(ENDPOINT, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "refresh_eligibility" }),
        });
        if (!res.ok) return;
        const body = (await res.json().catch(() => ({}))) as ManagerAssistantEmailStatus;
        if (!cancelled && body && typeof body === "object" && "entitlement" in body) {
          setStatus(body);
        }
      } catch {
        // Work the manager never asked for should not raise an error banner.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [entitlementUnverified]);

  const postAction = useCallback(
    async (action: "request_address" | "refresh_eligibility") => {
      setPendingAction(action === "refresh_eligibility" ? "refresh" : "request");
      setError(null);
      try {
        const res = await fetch(ENDPOINT, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        });
        const body = (await res.json().catch(() => ({}))) as ManagerAssistantEmailStatus & {
          error?: string;
        };
        if (!res.ok) {
          // A refusal still carries the updated status (e.g. an address that
          // already existed). Apply it so the button reflects what the server
          // will actually accept next.
          if (body && typeof body === "object" && "entitlement" in body) setStatus(body);
          throw new Error(
            body.error ??
              (action === "refresh_eligibility"
                ? "Could not refresh work email eligibility."
                : "Could not set up your work email."),
          );
        }
        setStatus(body);
        if (action === "refresh_eligibility") {
          showToast("Work email eligibility refreshed.");
        } else if (body.address) {
          showToast(
            body.canUse
              ? "Your PropLane work email is ready."
              : "Work email assigned. Replies are off for this workspace.",
          );
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not update work email settings.");
      } finally {
        setPendingAction(null);
      }
    },
    [showToast],
  );

  if (loading && !status) {
    return (
      <PortalSettingsSection
        title="Work email"
        description="Email your PropLane assistant from any device — same capabilities as texting your work number."
      >
        <PortalSettingsGroup>
          <p className="px-4 py-4 text-sm text-muted">Loading…</p>
        </PortalSettingsGroup>
      </PortalSettingsSection>
    );
  }

  if (error && !status) {
    return (
      <PortalSettingsSection title="Work email" description="PropLane assistant over email.">
        <PortalSettingsGroup>
          <div className="space-y-3 px-4 py-4">
            <p className="text-sm text-muted">{error}</p>
            <Button type="button" variant="outline" onClick={() => load()} data-attr="assistant-email-retry">
              Try again
            </Button>
          </div>
        </PortalSettingsGroup>
      </PortalSettingsSection>
    );
  }

  if (!status) return null;

  // A co-manager now gets their OWN address, so the upsell copy is the same for
  // everyone; only the scope sentence differs, because their assistant answers
  // about the houses assigned to them rather than a portfolio they own.
  const planMessage = assistantEmailUpsellMessage(status.planTier, status.entitlement);
  const isCoManager = status.workspaceRole === "co_manager";
  const unverifiedEntitlement = assistantEmailEntitlementIsUnverified(status.entitlement);

  return (
    <PortalSettingsSection
      title="Work email"
      description={
        isCoManager
          ? "Request your own address, then email it to ask about the houses assigned to you — same assistant as your work number texts."
          : "Request and manage the dedicated address residents and prospects use to reach your workspace."
      }
    >
      <PortalSettingsGroup>
        <PortalSettingsField
          label="Work email"
          value={status.address ?? "Not assigned"}
          action={
            status.address ? (
              <Button
                type="button"
                variant="ghost"
                className="min-h-10 px-3 text-xs"
                onClick={() => copyAddress()}
                data-attr="assistant-email-copy"
              >
                Copy
              </Button>
            ) : undefined
          }
        />
        <PortalSettingsField label="Status" value={workEmailStatusLabel(status)} />
        <PortalSettingsField label="Who can write in" value={workEmailAudienceLabel(status)} />
        <div className="space-y-4 px-4 py-4">
          {status.state === "ready" ? (
            <div className="flex items-start gap-2 text-sm text-foreground">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
              <p>
                Your address is live. Email it from your PropLane profile email to talk to PropLane
                Assistant; your residents can email it about their home and prospects about your
                listings. Everything appears in <strong>Communication</strong>.
              </p>
            </div>
          ) : status.state === "storage_unavailable" ? (
            <p className="text-sm leading-relaxed text-muted" role="status">
              Work email storage is not ready on this environment yet. A database migration must be
              applied before setup can complete.
            </p>
          ) : status.state === "assigned_send_off" ? (
            /* The email's version of the number's "registered, but texting is
               switched off for this workspace". Saying "ready" here would send
               a manager chasing their mail provider for a PropLane setting —
               and would hand residents an address that swallows their mail. */
            <p className="text-sm leading-relaxed text-muted">
              Your address is assigned, but email is switched off for this workspace, so nothing
              sends or replies yet. This is a PropLane setting, not something to chase with your mail
              provider. We are not showing this address to residents or on your listings while it
              cannot answer.
            </p>
          ) : status.state === "assigned_plan_hold" ? (
            /* The other reason the same address goes quiet, and the opposite
               advice: this one IS theirs to fix. */
            <div className="space-y-3">
              <p className="text-sm leading-relaxed text-muted">
                {planMessage ??
                  "Your address is assigned, but it is paused until your plan is active again."}{" "}
                While it is paused we are not showing it to residents or on your listings, because it
                cannot answer.
              </p>
              {unverifiedEntitlement ? null : (
                <Button asChild variant="outline" data-attr="assistant-email-open-billing">
                  <Link href="/portal/profile?tab=billing">View plans</Link>
                </Button>
              )}
            </div>
          ) : planMessage ? (
            <div className="space-y-3">
              <p className="text-sm leading-relaxed text-muted">{planMessage}</p>
              {unverifiedEntitlement ? null : (
                <Button asChild variant="outline" data-attr="assistant-email-open-billing">
                  <Link href="/portal/profile?tab=billing">View plans</Link>
                </Button>
              )}
            </div>
          ) : unverifiedEntitlement ? (
            <p className="text-sm leading-relaxed text-muted">
              We&apos;re confirming your plan. Reload the page if this doesn&apos;t clear.
            </p>
          ) : !status.provisioningAvailable ? (
            <p className="text-sm leading-relaxed text-muted">
              Work email setup is in a limited rollout. We&apos;ll make the request available here
              when your account is eligible.
            </p>
          ) : (
            <div className="flex items-start gap-2 text-sm text-muted">
              <Mail className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <p>
                Request one address for your manager account. You can email it to ask about your
                portfolio, your residents can email it about their home, and prospects can email it
                about your listings. It cannot be edited after assignment.
              </p>
            </div>
          )}

          {error ? (
            <div className="flex items-start gap-2 text-sm text-danger" role="alert">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <p>{error}</p>
            </div>
          ) : null}

          {!status.entitlement.eligible && !unverifiedEntitlement ? (
            <Button
              type="button"
              variant="outline"
              disabled={pendingAction !== null}
              aria-busy={pendingAction === "refresh"}
              onClick={() => postAction("refresh_eligibility")}
              data-attr="assistant-email-eligibility-refresh"
            >
              {pendingAction === "refresh" ? "Checking…" : "Refresh eligibility"}
            </Button>
          ) : null}

          {/* They said yes during setup but cannot act on it yet — usually a
              plan that does not include it. Saying so is the whole point of
              recording the intent; dropping it silently would leave them
              waiting for an address nobody is setting up. */}
          {status.requestedAtSignup && !status.canRequest && !status.address ? (
            <p className="text-xs text-muted" data-attr="assistant-email-signup-intent">
              You asked for a PropLane work email when you created this account. It is waiting on
              your plan — once it is included, you can request it here.
            </p>
          ) : null}

          {status.canRequest ? (
            <Button
              type="button"
              onClick={() => postAction("request_address")}
              loading={pendingAction === "request"}
              data-attr="assistant-email-request"
            >
              <Mail className="h-4 w-4" aria-hidden />
              Request work email
            </Button>
          ) : null}

          {/* Same rule as the number's broadcast: only ever advertise a channel
              that can actually carry a reply. */}
          {status.canUse ? (
            <Button
              type="button"
              variant="outline"
              className="min-h-10 rounded-full px-4 text-xs"
              onClick={() => window.dispatchEvent(new CustomEvent(WORK_CONTACT_ANNOUNCE_EVENT))}
              data-attr="assistant-email-announce-residents-open"
            >
              Tell residents about this address
            </Button>
          ) : null}

          {status.state === "assigned_send_off" ||
          status.state === "assigned_plan_hold" ||
          status.state === "storage_unavailable" ? (
            <Button
              type="button"
              variant="ghost"
              className="min-h-10 rounded-full px-3 text-xs"
              disabled={loading}
              onClick={() => load()}
              data-attr="assistant-email-status-refresh"
            >
              {loading ? "Checking…" : "Refresh status"}
            </Button>
          ) : null}
        </div>
      </PortalSettingsGroup>
    </PortalSettingsSection>
  );
}
