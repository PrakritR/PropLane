"use client";

/**
 * Vendor Settings panes backed by the vendor's OWN business record
 * (`vendor_business_profiles`): Business profile, Work contacts, Workspace
 * access, and Notifications. None of them wait on a manager link — the record
 * is the vendor's, and the shared fields are mirrored into every linked
 * directory row on save.
 */

import { VendorNotificationSettingsPane } from "@/components/portal/vendor-notification-settings-pane";
import { useCallback, useEffect, useState } from "react";
import { Building2, Mail, Phone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useAppUi } from "@/components/providers/app-ui-provider";
import {
  PortalSettingsFormBody,
  PortalSettingsGroup,
  PortalSettingsSection,
} from "@/components/portal/portal-settings-ui";
import type { VendorWorkIdentityResponse } from "@/lib/vendor-work-identity";

export type VendorBusinessProfileView = {
  businessName: string;
  contactName: string;
  workEmail: string;
  workPhone: string;
  serviceArea: string;
  notifyNewOffers: boolean;
  notifyScheduleChanges: boolean;
  notifyPayments: boolean;
};

export type VendorWorkspaceAccessView = {
  managerUserId: string;
  managerName: string;
  managerEmail: string;
  directoryId: string;
  propertyIds: string[];
  active: boolean;
};

const EMPTY: VendorBusinessProfileView = {
  businessName: "",
  contactName: "",
  workEmail: "",
  workPhone: "",
  serviceArea: "",
  notifyNewOffers: true,
  notifyScheduleChanges: true,
  notifyPayments: true,
};

export function useVendorBusinessProfile(enabled: boolean) {
  const { showToast } = useAppUi();
  const [profile, setProfile] = useState<VendorBusinessProfileView>(EMPTY);
  const [workspaces, setWorkspaces] = useState<VendorWorkspaceAccessView[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/vendor/business-profile", { credentials: "include", cache: "no-store" });
      const body = (await res.json().catch(() => ({}))) as {
        profile?: VendorBusinessProfileView;
        workspaces?: VendorWorkspaceAccessView[];
        error?: string;
      };
      if (!res.ok) throw new Error(body.error ?? "Could not load your business profile.");
      setProfile({ ...EMPTY, ...(body.profile ?? {}) });
      setWorkspaces(body.workspaces ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load your business profile.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    void load();
  }, [enabled, load]);

  const save = useCallback(
    async (patch: Partial<VendorBusinessProfileView>) => {
      setSaving(true);
      try {
        const res = await fetch("/api/vendor/business-profile", {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        const body = (await res.json().catch(() => ({}))) as { profile?: VendorBusinessProfileView; error?: string };
        if (!res.ok || !body.profile) throw new Error(body.error ?? "Could not save.");
        setProfile({ ...EMPTY, ...body.profile });
        showToast("Saved.");
        return true;
      } catch (e) {
        showToast(e instanceof Error ? e.message : "Could not save.");
        return false;
      } finally {
        setSaving(false);
      }
    },
    [showToast],
  );

  return { profile, workspaces, loading, saving, error, save, reload: load };
}

type Ctx = ReturnType<typeof useVendorBusinessProfile>;

export function VendorBusinessProfilePane({ ctx }: { ctx: Ctx }) {
  const [draft, setDraft] = useState(ctx.profile);
  useEffect(() => setDraft(ctx.profile), [ctx.profile]);
  return (
    <PortalSettingsSection
      title="Business profile"
    >
      <PortalSettingsGroup>
        {ctx.loading ? (
          <p className="px-4 py-4 text-sm text-muted">Loading…</p>
        ) : (
          <PortalSettingsFormBody>
            {ctx.error ? (
              <p role="alert" className="rounded-lg border px-3 py-2 text-sm portal-banner-danger">
                {ctx.error}{" "}
                <button type="button" className="font-semibold underline" onClick={() => void ctx.reload()}>
                  Retry
                </button>
              </p>
            ) : null}
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-xs font-medium text-muted sm:col-span-2">
                Business name
                <Input
                  value={draft.businessName}
                  maxLength={120}
                  onChange={(e) => setDraft({ ...draft, businessName: e.target.value })}
                  data-attr="vendor-business-name"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-muted">
                Contact name
                <Input
                  value={draft.contactName}
                  maxLength={120}
                  onChange={(e) => setDraft({ ...draft, contactName: e.target.value })}
                  data-attr="vendor-business-contact-name"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-muted">
                Service area
                <Input
                  value={draft.serviceArea}
                  maxLength={200}
                  placeholder="Seattle · Plumbing and property maintenance"
                  onChange={(e) => setDraft({ ...draft, serviceArea: e.target.value })}
                  data-attr="vendor-business-service-area"
                />
              </label>
            </div>
          </PortalSettingsFormBody>
        )}
        <div className="border-t border-border px-4 py-4">
          <Button
            variant="primary"
            className="px-4 text-[13px]"
            disabled={ctx.loading || ctx.saving}
            onClick={() =>
              ctx.save({ businessName: draft.businessName, contactName: draft.contactName, serviceArea: draft.serviceArea })
            }
            data-attr="vendor-business-profile-save"
          >
            {ctx.saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </PortalSettingsGroup>
    </PortalSettingsSection>
  );
}

export function VendorWorkContactsPane({ ctx }: { ctx: Ctx }) {
  const [draft, setDraft] = useState(ctx.profile);
  useEffect(() => setDraft(ctx.profile), [ctx.profile]);
  return (
    <PortalSettingsSection
      title="Work contacts"
    >
      <PortalSettingsGroup>
        {ctx.loading ? (
          <p className="px-4 py-4 text-sm text-muted">Loading…</p>
        ) : (
          <PortalSettingsFormBody>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-xs font-medium text-muted">
                <span className="inline-flex items-center gap-1.5">
                  <Phone className="size-3.5" aria-hidden /> Work number
                </span>
                <Input
                  type="tel"
                  value={draft.workPhone}
                  placeholder="(206) 555-0142"
                  onChange={(e) => setDraft({ ...draft, workPhone: e.target.value })}
                  data-attr="vendor-work-phone"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-muted">
                <span className="inline-flex items-center gap-1.5">
                  <Mail className="size-3.5" aria-hidden /> Work email
                </span>
                <Input
                  type="email"
                  value={draft.workEmail}
                  placeholder="office@yourbusiness.com"
                  onChange={(e) => setDraft({ ...draft, workEmail: e.target.value })}
                  data-attr="vendor-work-email"
                />
              </label>
            </div>
          </PortalSettingsFormBody>
        )}
        <div className="border-t border-border px-4 py-4">
          <Button
            variant="primary"
            className="px-4 text-[13px]"
            disabled={ctx.loading || ctx.saving}
            onClick={() => ctx.save({ workPhone: draft.workPhone, workEmail: draft.workEmail })}
            data-attr="vendor-work-contacts-save"
          >
            {ctx.saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </PortalSettingsGroup>
    </PortalSettingsSection>
  );
}

/** Provider readiness is separate from the saved business contact model. */
export function VendorWorkIdentityPane({ channel }: { channel: "email" | "sms" }) {
  const [identity, setIdentity] = useState<VendorWorkIdentityResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    setLoading(true); setFailed(false);
    try {
      const res = await fetch("/api/vendor/work-identity", { credentials: "include", cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.identity) throw new Error("unavailable");
      setIdentity(body.identity as VendorWorkIdentityResponse);
    } catch { setFailed(true); } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const value = identity?.[channel];
  const status = !value ? "Unavailable" : value.blockedReason === "provider_disabled" ? "Disabled" : value.blockedReason === "provider_unconfigured" ? "Unavailable" : value.blockedReason === "platform_capacity_reached" ? "Capacity reached" : value.state === "provisioning" || value.state === "reconciling" ? "Pending" : value.state === "blocked" || value.state === "quarantined" ? "Failed" : value.state === "disabled" || value.state === "released" ? "Disabled" : value.sendReady && value.receiveReady ? "Ready" : value.state === "ready" ? value.sendReady ? "Send ready" : value.receiveReady ? "Receive ready" : "Failed" : "Not set up";
  const setup = async () => {
    setSaving(true); setFailed(false);
    try {
      const res = await fetch("/api/vendor/work-identity", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ channel, idempotencyKey: crypto.randomUUID() }) });
      if (!res.ok) throw new Error("unavailable");
      const body = await res.json(); setIdentity(body.identity as VendorWorkIdentityResponse); setFailed(false);
    } catch { setFailed(true); } finally { setSaving(false); }
  };
  return <PortalSettingsSection title={channel === "email" ? "Work email" : "Work number"}>
    <PortalSettingsGroup><PortalSettingsFormBody>
      {loading ? <p className="px-4 py-4 text-sm text-muted" role="status">Loading</p> : failed ? <p className="px-4 py-4 text-sm text-danger" role="alert">Could not load <button type="button" className="font-semibold underline" onClick={() => void load()}>Retry</button></p> : <div className="space-y-2"><div className="flex items-center justify-between gap-3"><span className="text-sm font-medium">{status}</span>{value?.value ? <span className="text-sm text-muted">{value.value}</span> : null}<span className="text-xs">Send {value?.sendReady ? "ready" : "unavailable"} · Receive {value?.receiveReady ? "ready" : "unavailable"}</span></div><div className="flex items-center justify-between gap-3 text-sm"><span>Cost</span><span className="font-medium">Free · covered by PropLane</span></div></div>}
    </PortalSettingsFormBody>
    <div className="border-t border-border px-4 py-4"><Button variant="primary" disabled={loading || saving || !value?.canSetup} onClick={() => setup()}>{saving ? "Saving…" : "Set up"}</Button></div>
    </PortalSettingsGroup>
  </PortalSettingsSection>;
}

export function VendorWorkspaceAccessPane({
  ctx,
  propertyLabel,
}: {
  ctx: Ctx;
  propertyLabel: (id: string) => string;
}) {
  return (
    <PortalSettingsSection
      title="Workspace access"
    >
      <PortalSettingsGroup>
        {ctx.loading ? (
          <p className="px-4 py-4 text-sm text-muted">Loading…</p>
        ) : ctx.workspaces.length === 0 ? (
          <p className="px-4 py-4 text-sm text-muted" data-attr="vendor-workspaces-empty">
            No manager has linked you yet. Ask a manager for their vendor invite link, or wait for one to add you.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {ctx.workspaces.map((workspace) => (
              <li key={workspace.directoryId} className="flex items-start gap-3 px-4 py-3" data-attr="vendor-workspace-row">
                <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent text-primary" aria-hidden>
                  <Building2 className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm font-semibold text-foreground">{workspace.managerName}</span>
                    <Badge tone={workspace.active ? "success" : "neutral"}>{workspace.active ? "Active" : "Inactive"}</Badge>
                  </span>
                  {workspace.managerEmail ? <span className="block truncate text-xs text-muted">{workspace.managerEmail}</span> : null}
                  <span className="mt-1 block text-xs text-muted">
                    {workspace.propertyIds.length === 0
                      ? "No houses assigned yet."
                      : workspace.propertyIds.map(propertyLabel).join(" · ")}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </PortalSettingsGroup>
    </PortalSettingsSection>
  );
}

/** The notification pane no longer reads the business profile: its settings live in
 * `notification_preferences` and are honoured at send (PLAN-0915). The `ctx` prop is
 * kept so the settings shell's pane table needs no change. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function VendorNotificationsPane(_props: { ctx: Ctx }) {
  return <VendorNotificationSettingsPane />;
}
