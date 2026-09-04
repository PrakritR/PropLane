"use client";

import Link from "next/link";
import { AlertCircle, CheckCircle2, Mail } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
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
        if (!res.ok) throw new Error(body.error ?? "Could not update assistant email settings.");
        setStatus(body);
        if (action === "request_address" && body.address) {
          showToast("Your PropLane assistant email is ready.");
        } else if (action === "refresh_eligibility") {
          showToast("Eligibility updated.");
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

  const planMessage =
    status.workspaceRole === "co_manager"
      ? "Co-managers email the account owner's assistant address from the email on their PropLane profile."
      : assistantEmailUpsellMessage(status.planTier, status.entitlement);
  const isCoManager = status.workspaceRole === "co_manager";
  const unverifiedEntitlement = assistantEmailEntitlementIsUnverified(status.entitlement);
  const canRefreshEligibility =
    !status.entitlement.eligible && (Boolean(status.address) || unverifiedEntitlement);
  const storageBlocked = status.storageReady === false;

  return (
    <PortalSettingsSection
      title="Assistant email"
      description={
        isCoManager
          ? "Email the workspace owner's assistant address from your PropLane profile email."
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
              Your plan has not been checked yet. Check eligibility, then request your assistant
              email.
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

          {canRefreshEligibility ? (
            <Button
              type="button"
              variant="outline"
              disabled={pendingAction !== null}
              aria-busy={pendingAction === "refresh"}
              onClick={() => postAction("refresh_eligibility")}
              data-attr="assistant-email-refresh-eligibility"
            >
              {pendingAction === "refresh" ? "Checking…" : "Check eligibility"}
            </Button>
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
