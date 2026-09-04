"use client";

import Link from "next/link";
import { CheckCircle2, Mail } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useAppUi } from "@/components/providers/app-ui-provider";
import {
  PortalSettingsField,
  PortalSettingsGroup,
  PortalSettingsSection,
} from "@/components/portal/portal-settings-ui";
import { Button } from "@/components/ui/button";
import { copyTextToClipboard } from "@/lib/manager-property-links";
import type { ManagerAssistantEmailStatus } from "@/lib/manager-assistant-email/manager-assistant-email-status";

const ENDPOINT = "/api/manager/assistant-email";

function upsellMessage(status: ManagerAssistantEmailStatus): string | null {
  if (status.workspaceRole === "co_manager") {
    return "Co-managers email the account owner's assistant address from the email on their PropLane profile.";
  }
  if (status.entitlement.eligible) return null;
  if (status.entitlement.reason === "free") {
    return "Upgrade to Pro or Business to get a dedicated PropLane assistant email.";
  }
  if (
    status.entitlement.reason === "plan_unreadable" ||
    status.entitlement.reason === "legacy_unknown"
  ) {
    return "We could not confirm your plan yet. Refresh eligibility or request your assistant email to check again.";
  }
  return "A paid Pro or Business plan is required for a PropLane assistant email.";
}

export function ManagerAssistantEmailSettingsPanel() {
  const { showToast } = useAppUi();
  const [status, setStatus] = useState<ManagerAssistantEmailStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
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
    showToast(ok ? "Assistant email copied." : "Could not copy address.", ok ? "success" : "error");
  }, [showToast, status?.address]);

  const requestAddress = useCallback(async () => {
    setPending(true);
    setError(null);
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "request_address" }),
      });
      const body = (await res.json().catch(() => ({}))) as ManagerAssistantEmailStatus & {
        error?: string;
      };
      if (!res.ok) throw new Error(body.error ?? "Could not set up assistant email.");
      setStatus(body);
      showToast("Your PropLane assistant email is ready.", "success");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not set up assistant email.");
    } finally {
      setPending(false);
    }
  }, [showToast]);

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

  const planMessage = upsellMessage(status);
  const isCoManager = status.workspaceRole === "co_manager";

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
          {status.canUse ? (
            <div className="flex items-start gap-2 text-sm text-foreground">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
              <p>
                Email this address from your PropLane account email to reach the assistant. Reply
                with <strong>YES</strong> or <strong>NO</strong> to confirm proposed actions, just
                like SMS.
              </p>
            </div>
          ) : planMessage ? (
            <div className="space-y-3">
              <p className="text-sm leading-relaxed text-muted">{planMessage}</p>
              {status.entitlement.reason === "free" ? (
                <Button asChild variant="outline" data-attr="assistant-email-open-billing">
                  <Link href="/portal/profile?tab=billing">View plans</Link>
                </Button>
              ) : null}
            </div>
          ) : null}

          {status.canRequest ? (
            <Button
              type="button"
              onClick={() => requestAddress()}
              loading={pending}
              data-attr="assistant-email-request"
            >
              <Mail className="h-4 w-4" aria-hidden />
              Set up assistant email
            </Button>
          ) : null}

          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>
      </PortalSettingsGroup>
    </PortalSettingsSection>
  );
}
