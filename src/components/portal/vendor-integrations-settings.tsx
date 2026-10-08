"use client";

import { useCallback, useEffect, useState } from "react";
import { Hammer, House, Link2, Mail, MessageSquare, RotateCcw, Wrench, type LucideIcon } from "lucide-react";
import { GoogleCalendarConnectPanel } from "@/components/portal/google-calendar-connect-panel";
import { IntegrationRow } from "@/components/portal/integration-row";
import { formatWorkNumber } from "@/components/portal/integrations-messages-panel";
import { CopyIconAction, PortalIconAction } from "@/components/portal/portal-icon-action";
import { PortalSettingsGroup, PortalSettingsSection, PortalSettingsSections } from "@/components/portal/portal-settings-ui";
import { useConfirm, useOptionalAppUi } from "@/components/providers/app-ui-provider";
import { Button } from "@/components/ui/button";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { VENDOR_INTEGRATION_PROVIDERS, type VendorIntegrationProvider } from "@/lib/vendor-integrations";

type LinkState = { status: "loading" } | { status: "ready"; url: string } | { status: "error"; message: string };
type Channel = { value: string | null; loaded: boolean };

const DEMO_LINK = "https://proplane.ai/api/calendar/vendor/demo/demo-calendar-link.ics";
const DEMO_NUMBER = "+14255550177";
const DEMO_EMAIL = "dima@vendors.proplane.ai";

const PROVIDER_ICONS: Record<VendorIntegrationProvider, { icon: LucideIcon; tone: string }> = {
  jobber: { icon: Wrench, tone: "text-emerald-600" },
  housecall_pro: { icon: House, tone: "text-blue-600" },
  thumbtack: { icon: Hammer, tone: "text-sky-600" },
};

/**
 * Vendor Settings > Business > Integrations, built like the manager's page: grouped rows, one icon
 * tile each, one plain fact and one action on the right (`IntegrationRow`). Messages is the work
 * number and work email (edited only in Work number & email, which Manage opens); Calendar is
 * Google Calendar and the private calendar link; Job software is Jobber, Housecall Pro and
 * Thumbtack, "Coming soon" with the Request access action kept. Nothing is explained under a row
 * (AGENTS.md § No subtext).
 */
export function VendorIntegrationsSettings({ onManage }: { onManage?: () => void } = {}) {
  const demo = isDemoModeActive();
  const appUi = useOptionalAppUi();
  const confirm = useConfirm();
  const [link, setLink] = useState<LinkState>(demo ? { status: "ready", url: DEMO_LINK } : { status: "loading" });
  const [resetting, setResetting] = useState(false);
  const [requested, setRequested] = useState<ReadonlySet<VendorIntegrationProvider>>(new Set());
  const [pending, setPending] = useState<VendorIntegrationProvider | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [number, setNumber] = useState<Channel>(demo ? { value: DEMO_NUMBER, loaded: true } : { value: null, loaded: false });
  const [email, setEmail] = useState<Channel>(demo ? { value: DEMO_EMAIL, loaded: true } : { value: null, loaded: false });

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
    (async () => {
      let sms: string | null = null;
      let mail: string | null = null;
      try {
        const res = await fetch("/api/vendor/work-identity", { credentials: "include", cache: "no-store" });
        const body = (await res.json().catch(() => null)) as {
          identity?: { sms?: { value?: unknown }; email?: { value?: unknown } };
        } | null;
        if (res.ok) {
          const smsValue = body?.identity?.sms?.value;
          const emailValue = body?.identity?.email?.value;
          sms = typeof smsValue === "string" && smsValue.trim() ? smsValue.trim() : null;
          mail = typeof emailValue === "string" && emailValue.trim() ? emailValue.trim() : null;
        }
      } catch {
        /* the rows read as not set up */
      }
      if (cancelled) return;
      setNumber({ value: sms, loaded: true });
      setEmail({ value: mail, loaded: true });
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

  const manage = (which: "number" | "email") => (
    <Button variant="ghost" data-attr={`vendor-integrations-${which}-manage`} onClick={onManage}>
      Manage
    </Button>
  );
  const channelFact = (channel: Channel, format: (value: string) => string) =>
    !channel.loaded ? "" : channel.value ? format(channel.value) : "Not set up";

  const linkFact =
    link.status === "loading" ? (
      "Loading…"
    ) : link.status === "error" ? (
      <span role="alert" className="text-danger">
        {link.message}
      </span>
    ) : (
      <span className="hidden max-w-[16rem] truncate font-mono sm:inline-block" data-attr="vendor-integrations-calendar-link-url">
        {link.url}
      </span>
    );

  return (
    <PortalSettingsSections>
      <div data-attr="vendor-integrations-section-messages">
        <PortalSettingsSection title="Messages">
          <PortalSettingsGroup>
            <IntegrationRow
              icon={MessageSquare}
              tone="text-emerald-600"
              name="Work number"
              fact={channelFact(number, formatWorkNumber)}
              factDataAttr="vendor-integrations-number"
              dataAttr="vendor-integrations-number-row"
              action={manage("number")}
            />
            <IntegrationRow
              icon={Mail}
              tone="text-blue-600"
              name="Work email"
              fact={channelFact(email, (value) => value)}
              factDataAttr="vendor-integrations-email"
              dataAttr="vendor-integrations-email-row"
              action={manage("email")}
            />
          </PortalSettingsGroup>
        </PortalSettingsSection>
      </div>

      <div data-attr="vendor-integrations-section-calendar">
        <PortalSettingsSection title="Calendar">
          <PortalSettingsGroup>
            {demo ? (
              <IntegrationRow
                icon={Link2}
                tone="text-blue-500"
                name="Google Calendar"
                dataAttr="integrations-google-calendar-row"
                action={
                  <Button variant="ghost" data-attr="vendor-integrations-google-calendar-connect">
                    Connect
                  </Button>
                }
              />
            ) : (
              <GoogleCalendarConnectPanel apiBase="/api/vendor/google-calendar" showVendorPushToggle presentation="integration" />
            )}
            <IntegrationRow
              icon={Link2}
              tone="text-violet-600"
              name="Calendar link"
              dataAttr="vendor-integrations-calendar-link"
              fact={linkFact}
              action={
                <div className="flex items-center gap-1">
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
              }
            />
          </PortalSettingsGroup>
        </PortalSettingsSection>
      </div>

      <div data-attr="vendor-integrations-section-job-software">
        <PortalSettingsSection title="Job software">
          <PortalSettingsGroup>
            {VENDOR_INTEGRATION_PROVIDERS.map((provider) => {
              const glyph = PROVIDER_ICONS[provider.id];
              return requested.has(provider.id) ? (
                <IntegrationRow
                  key={provider.id}
                  icon={glyph.icon}
                  tone={glyph.tone}
                  name={provider.label}
                  dataAttr={`vendor-integrations-${provider.id}-row`}
                  action={
                    <span className="text-sm text-muted" data-attr={`vendor-integrations-${provider.id}-requested`}>
                      Requested
                    </span>
                  }
                />
              ) : (
                <IntegrationRow
                  key={provider.id}
                  icon={glyph.icon}
                  tone={glyph.tone}
                  name={provider.label}
                  comingSoon
                  dataAttr={`vendor-integrations-${provider.id}-row`}
                  comingSoonAction={
                    <Button
                      variant="ghost"
                      disabled={pending === provider.id}
                      onClick={() => requestAccess(provider.id)}
                      data-attr={`vendor-integrations-${provider.id}-request-access`}
                    >
                      Request access
                    </Button>
                  }
                />
              );
            })}
          </PortalSettingsGroup>
          {requestError ? (
            <p role="alert" className="px-1 text-sm text-danger" data-attr="vendor-integrations-request-error">
              {requestError}
            </p>
          ) : null}
        </PortalSettingsSection>
      </div>
    </PortalSettingsSections>
  );
}
