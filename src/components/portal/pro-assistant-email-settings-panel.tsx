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

const ENDPOINT = "/api/manager/assistant-email";

export function ManagerAssistantEmailSettingsPanel() {
  const { showToast } = useAppUi();
  const [status, setStatus] = useState<ManagerAssistantEmailStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingAction, setPendingAction] = useState<"request" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(ENDPOINT, { credentials: "include", cache: "no-store", signal });
      const body = (await res.json().catch(() => ({}))) as ManagerAssistantEmailStatus & {
        error?: string;
      };
      if (!res.ok) throw new Error(body.error ?? "Could not load assistant email settings.");
      setStatus(body);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setError(cause instanceof Error ? cause.message : "Could not load assistant email settings.");
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
    showToast(ok ? "Assistant email copied." : "Could not copy address.");
  }, [showToast, status?.address]);

  /**
   * Settle an unverified plan by itself, instead of behind a button. Reading
   * the billing source needs no human judgement, and the account that saw
   * "Check eligibility" was a new one with no stored entitlement row — the
   * least likely to know what the button was for.
   *
   * It cannot become a billing ping: the server gates on the ABSENCE of that
   * row and writes one on every resolved outcome, and the ref holds this to a
   * single attempt per mount. Later plan changes arrive through the Stripe and
   * RevenueCat webhooks, which reconcile the same entitlement.
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
    async (action: "request_address") => {
      setPendingAction("request");
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
        if (!res.ok) throw new Error(body.error ?? "Could not update assistant email settings.");
        setStatus(body);
        if (body.address) {
          showToast("Your PropLane assistant email is ready.");
        }
      } catch (cause) {
        setError(
          cause instanceof Error ? cause.message : "Could not update assistant email settings.",
        );
      } finally {
        setPendingAction(null);
      }
    },
    [showToast],
  );

  if (loading && !status) {
    return (
      <PortalSettingsSection
        title="Assistant email"
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
      <PortalSettingsSection title="Assistant email" description="PropLane assistant over email.">
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
  const storageBlocked = status.storageReady === false;

  return (
    <PortalSettingsSection
      title="Assistant email"
      description={
        isCoManager
          ? "Request your own address, then email it to ask about the houses assigned to you — same assistant as your work number texts."
          : "Request a dedicated address, then email it to ask about your portfolio — same assistant as your work number texts."
      }
    >
      <PortalSettingsGroup>
        <PortalSettingsField
          label="Assistant email"
          value={status.address ?? "Not set up"}
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
        <div className="space-y-4 px-4 py-4">
          {status.address ? (
            <div className="flex items-start gap-2 text-sm text-foreground">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
              <p>
                Email this address from your PropLane profile email to talk to PropLane Assistant.
                Messages also appear in{" "}
                <strong>Communication → PropLane Assistant</strong>. Share the address with
                co-managers on your workspace — only verified workspace emails are accepted.
              </p>
            </div>
          ) : planMessage ? (
            <div className="space-y-3">
              <p className="text-sm leading-relaxed text-muted">{planMessage}</p>
              {status.planTier === "free" ||
              (!status.entitlement.eligible && status.entitlement.reason === "free") ? (
                <Button asChild variant="outline" data-attr="assistant-email-open-billing">
                  <Link href="/portal/profile?tab=billing">View plans</Link>
                </Button>
              ) : null}
            </div>
          ) : unverifiedEntitlement ? (
            <p className="text-sm leading-relaxed text-muted">
              We&apos;re confirming your plan. Reload the page if this doesn&apos;t clear.
            </p>
          ) : null}

          {storageBlocked ? (
            <p className="text-sm leading-relaxed text-muted" role="status">
              Assistant email storage is not ready on this environment yet. A database migration
              must be applied before setup can complete.
            </p>
          ) : null}

          {error ? (
            <div className="flex items-start gap-2 text-sm text-danger" role="alert">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <p>{error}</p>
            </div>
          ) : null}

          {status.canRequest ? (
            <Button
              type="button"
              onClick={() => postAction("request_address")}
              loading={pendingAction === "request"}
              data-attr="assistant-email-request"
            >
              <Mail className="h-4 w-4" aria-hidden />
              Set up assistant email
            </Button>
          ) : null}
        </div>
      </PortalSettingsGroup>
    </PortalSettingsSection>
  );
}
