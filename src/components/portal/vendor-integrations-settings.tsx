"use client";

import { useCallback, useEffect, useState } from "react";
import { RotateCcw } from "lucide-react";
import { GoogleCalendarConnectPanel } from "@/components/portal/google-calendar-connect-panel";
import { CopyIconAction, PortalIconAction } from "@/components/portal/portal-icon-action";
import {
  PortalSettingsGroup,
  PortalSettingsRow,
  PortalSettingsSection,
  PortalSettingsSections,
} from "@/components/portal/portal-settings-ui";
import { useConfirm, useOptionalAppUi } from "@/components/providers/app-ui-provider";
import { Button } from "@/components/ui/button";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import {
  VENDOR_INTEGRATION_PROVIDERS,
  type VendorIntegrationProvider,
} from "@/lib/vendor-integrations";

type LinkState = { status: "loading" } | { status: "ready"; url: string } | { status: "error"; message: string };

const DEMO_LINK = "https://proplane.ai/api/calendar/vendor/demo/demo-calendar-link.ics";

/**
 * Vendor Settings > Business > Integrations. Google Calendar (the existing vendor connect), the
 * private iCal Calendar link, and "Request access" rows for providers that are not built yet.
 * Labels and controls only: nothing is explained under a row (AGENTS.md § No subtext).
 */
export function VendorIntegrationsSettings() {
  const demo = isDemoModeActive();
  const appUi = useOptionalAppUi();
  const confirm = useConfirm();
  const [link, setLink] = useState<LinkState>(demo ? { status: "ready", url: DEMO_LINK } : { status: "loading" });
  const [resetting, setResetting] = useState(false);
  const [requested, setRequested] = useState<ReadonlySet<VendorIntegrationProvider>>(new Set());
  const [pending, setPending] = useState<VendorIntegrationProvider | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);

  const toast = useCallback((message: string) => appUi?.showToast(message), [appUi]);

  useEffect(() => {
    if (demo) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/vendor/calendar-feed", { credentials: "include" });
        const data = (await res.json().catch(() => null)) as { ok?: boolean; url?: string | null; error?: string } | null;
        if (cancelled) return;
        if (res.ok && data?.ok && data.url) setLink({ status: "ready", url: data.url });
        else setLink({ status: "error", message: data?.error ?? "Could not load your calendar link." });
      } catch {
        if (!cancelled) setLink({ status: "error", message: "Could not load your calendar link." });
      }
    })();
    (async () => {
      try {
        const res = await fetch("/api/vendor/integration-requests", { credentials: "include" });
        const data = (await res.json().catch(() => null)) as { ok?: boolean; requested?: VendorIntegrationProvider[] } | null;
        if (!cancelled && res.ok && data?.ok && Array.isArray(data.requested)) setRequested(new Set(data.requested));
      } catch {
        /* the rows simply read as not yet requested */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [demo]);

  const copyLink = useCallback(async () => {
    if (link.status !== "ready") return;
    try {
      await navigator.clipboard.writeText(link.url);
      toast("Calendar link copied.");
    } catch {
      toast("Could not copy the link.");
    }
  }, [link, toast]);

  const resetLink = useCallback(async () => {
    const ok = await confirm({
      title: "Reset link",
      description: "Reset your calendar link? Calendars using the old link stop updating.",
      confirmLabel: "Reset",
      tone: "danger",
      note: null,
      dataAttr: "vendor-integrations-calendar-link-reset-confirm",
    });
    if (!ok) return;
    if (demo) {
      setLink({ status: "ready", url: `${DEMO_LINK.replace(".ics", "")}-new.ics` });
      return;
    }
    setResetting(true);
    try {
      const res = await fetch("/api/vendor/calendar-feed", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reset" }),
      });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; url?: string | null; error?: string } | null;
      if (res.ok && data?.ok && data.url) {
        setLink({ status: "ready", url: data.url });
        toast("Calendar link reset.");
      } else {
        toast(data?.error ?? "Could not reset the link.");
      }
    } catch {
      toast("Could not reset the link.");
    } finally {
      setResetting(false);
    }
  }, [confirm, demo, toast]);

  const requestAccess = useCallback(
    async (provider: VendorIntegrationProvider) => {
      setRequestError(null);
      if (demo) {
        setRequested((prev) => new Set(prev).add(provider));
        return;
      }
      setPending(provider);
      try {
        const res = await fetch("/api/vendor/integration-requests", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider }),
        });
        if (!res.ok) throw new Error("request failed");
        setRequested((prev) => new Set(prev).add(provider));
      } catch {
        setRequestError("Could not send your request");
      } finally {
        setPending(null);
      }
    },
    [demo],
  );

  return (
    <PortalSettingsSections>
      <PortalSettingsSection title="Google Calendar">
        {demo ? (
          <PortalSettingsGroup>
            <PortalSettingsRow label="Google Calendar">
              <Button variant="ghost" data-attr="vendor-integrations-google-calendar-connect">
                Connect
              </Button>
            </PortalSettingsRow>
          </PortalSettingsGroup>
        ) : (
          <GoogleCalendarConnectPanel apiBase="/api/vendor/google-calendar" showVendorPushToggle />
        )}
      </PortalSettingsSection>

      <PortalSettingsSection title="Calendar">
        <PortalSettingsGroup>
          <PortalSettingsRow label="Calendar link">
            <div className="flex items-center justify-end gap-1" data-attr="vendor-integrations-calendar-link">
              {link.status === "loading" ? <span className="text-sm text-muted">Loading…</span> : null}
              {link.status === "error" ? (
                <span role="alert" className="text-sm text-danger">
                  {link.message}
                </span>
              ) : null}
              {link.status === "ready" ? (
                <span
                  className="hidden max-w-[16rem] truncate font-mono text-xs text-muted sm:inline"
                  data-attr="vendor-integrations-calendar-link-url"
                >
                  {link.url}
                </span>
              ) : null}
              <CopyIconAction
                label="Copy link"
                onCopy={copyLink}
                disabled={link.status !== "ready"}
                data-attr="vendor-integrations-calendar-link-copy"
              />
              <PortalIconAction
                icon={RotateCcw}
                label="Reset link"
                disabled={resetting || link.status === "loading"}
                onClick={() => void resetLink()}
                data-attr="vendor-integrations-calendar-link-reset"
              />
            </div>
          </PortalSettingsRow>
        </PortalSettingsGroup>
      </PortalSettingsSection>

      <PortalSettingsSection title="Connections">
        <PortalSettingsGroup>
          {VENDOR_INTEGRATION_PROVIDERS.map((provider) => (
            <PortalSettingsRow key={provider.id} label={provider.label}>
              {requested.has(provider.id) ? (
                <span className="text-sm text-muted" data-attr={`vendor-integrations-${provider.id}-requested`}>
                  Requested
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-sm text-muted">
                  Coming soon ·
                  <Button
                    variant="ghost"
                    disabled={pending === provider.id}
                    onClick={() => requestAccess(provider.id)}
                    data-attr={`vendor-integrations-${provider.id}-request-access`}
                  >
                    Request access
                  </Button>
                </span>
              )}
            </PortalSettingsRow>
          ))}
        </PortalSettingsGroup>
        {requestError ? (
          <p role="alert" className="px-1 text-sm text-danger" data-attr="vendor-integrations-request-error">
            {requestError}
          </p>
        ) : null}
      </PortalSettingsSection>
    </PortalSettingsSections>
  );
}
