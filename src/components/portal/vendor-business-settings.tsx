"use client";

/**
 * Vendor Settings panes backed by the vendor's OWN business record
 * (`vendor_business_profiles`): Business profile, Work contacts, Workspace
 * access, and Notifications. None of them wait on a manager link — the record
 * is the vendor's, and the shared fields are mirrored into every linked
 * directory row on save.
 */

import { VendorNotificationSettingsPane } from "@/components/portal/vendor-notification-settings-pane";
import { useCallback, useEffect, useRef, useState } from "react";
import { Building2, Check, Copy, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CheckboxMultiSelect } from "@/components/ui/checkbox-multi-select";
import { ListSkeleton } from "@/components/ui/list-skeleton";
import { Badge } from "@/components/ui/badge";
import { copyTextToClipboard } from "@/lib/manager-property-links";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import {
  PortalSettingsAutosaveField,
  PortalSettingsFormBody,
  PortalSettingsGroup,
  PortalSettingsRow,
  PortalSettingsSection,
  type PortalSettingsSaveState,
} from "@/components/portal/portal-settings-ui";
import type { VendorWorkIdentityResponse } from "@/lib/vendor-work-identity";
import type { VendorAiInfo } from "@/lib/vendor-ai-info";

/** Section-title badge, matching `PortalSettingsAutosaveField`'s own indicator styling. */
export function SectionSaveBadge({ state }: { state: PortalSettingsSaveState }) {
  if (state === "idle") return null;
  return (
    <span aria-live="polite" className="text-[11.5px] font-semibold tabular-nums" data-attr="settings-section-save-state">
      {state === "saving" ? <span className="text-muted">Saving…</span> : null}
      {state === "saved" ? <span className="text-[var(--status-confirmed-fg,#15803d)]">Saved</span> : null}
      {state === "error" ? <span className="text-red-600">Failed</span> : null}
    </span>
  );
}

/** Worst-first: an in-flight save always wins the section badge over a stale "saved". */
export function worstSaveState(states: PortalSettingsSaveState[]): PortalSettingsSaveState {
  if (states.includes("saving")) return "saving";
  if (states.includes("error")) return "error";
  if (states.includes("saved")) return "saved";
  return "idle";
}

export type VendorBusinessProfileView = {
  businessName: string;
  contactName: string;
  workEmail: string;
  workPhone: string;
  serviceArea: string;
  notifyNewOffers: boolean;
  notifyScheduleChanges: boolean;
  notifyPayments: boolean;
  licenseNumber: string;
  insuranceProvider: string;
  insurancePolicyNumber: string;
  /** ISO date (yyyy-mm-dd), or "" when none. */
  insuranceExpiresAt: string;
  /** Read-only here: the trades picker lives on Trades & service area. */
  trades?: string[];
  aiInfo?: VendorAiInfo;
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
  licenseNumber: "",
  insuranceProvider: "",
  insurancePolicyNumber: "",
  insuranceExpiresAt: "",
};

export function useVendorBusinessProfile(enabled: boolean) {
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

  /**
   * No toast on either path: every caller is an autosaving field that reports
   * its own outcome inline (Saving…/Saved/inline error) — a toast on top of
   * that would double up the feedback for a field the person already left.
   */
  const save = useCallback(async (patch: Partial<VendorBusinessProfileView>): Promise<{ ok: boolean; error?: string }> => {
    if (isDemoModeActive()) {
      // /demo never writes real rows — simulate the autosave outcome locally.
      setProfile((p) => ({ ...p, ...patch }));
      return { ok: true };
    }
    setSaving(true);
    try {
      const res = await fetch("/api/vendor/business-profile", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const body = (await res.json().catch(() => ({}))) as { profile?: VendorBusinessProfileView; error?: string };
      if (!res.ok || !body.profile) return { ok: false, error: body.error ?? "Could not save." };
      setProfile({ ...EMPTY, ...body.profile });
      return { ok: true };
    } catch {
      return { ok: false, error: "No connection. Your change is still here." };
    } finally {
      setSaving(false);
    }
  }, []);

  return { profile, workspaces, loading, saving, error, save, reload: load };
}

type Ctx = ReturnType<typeof useVendorBusinessProfile>;

/** Shared autosave-on-blur wiring for a text field backed by `useVendorBusinessProfile`. */
function useBusinessProfileAutosave<K extends keyof VendorBusinessProfileView>(ctx: Ctx, fields: readonly K[]) {
  const [draft, setDraft] = useState(ctx.profile);
  useEffect(() => setDraft(ctx.profile), [ctx.profile]);
  const savedRef = useRef(ctx.profile);
  useEffect(() => {
    savedRef.current = ctx.profile;
  }, [ctx.profile]);
  const [fieldState, setFieldState] = useState<Record<K, PortalSettingsSaveState>>(
    () => Object.fromEntries(fields.map((f) => [f, "idle"])) as Record<K, PortalSettingsSaveState>,
  );
  const [fieldError, setFieldError] = useState<Partial<Record<K, string>>>({});
  const timers = useRef<Partial<Record<K, ReturnType<typeof setTimeout>>>>({});
  useEffect(() => {
    const held = timers.current;
    return () => {
      for (const timer of Object.values(held)) if (timer) clearTimeout(timer as ReturnType<typeof setTimeout>);
    };
  }, []);

  const markSaved = useCallback((field: K) => {
    setFieldState((s) => ({ ...s, [field]: "saved" }));
    const existing = timers.current[field];
    if (existing) clearTimeout(existing);
    timers.current[field] = setTimeout(() => {
      setFieldState((s) => (s[field] === "saved" ? { ...s, [field]: "idle" } : s));
    }, 2000);
  }, []);

  const commit = useCallback(
    async (field: K) => {
      const value = draft[field];
      if (value === savedRef.current[field]) return;
      setFieldState((s) => ({ ...s, [field]: "saving" }));
      setFieldError((e) => ({ ...e, [field]: undefined }));
      const result = await ctx.save({ [field]: value } as Partial<VendorBusinessProfileView>);
      if (result.ok) {
        markSaved(field);
      } else {
        setFieldState((s) => ({ ...s, [field]: "error" }));
        setFieldError((e) => ({ ...e, [field]: result.error ?? "Could not save." }));
      }
    },
    [draft, ctx, markSaved],
  );

  const sectionState = worstSaveState(fields.map((f) => fieldState[f]));
  return { draft, setDraft, fieldState, fieldError, commit, sectionState };
}

const BUSINESS_PROFILE_FIELDS = ["businessName", "contactName"] as const;

export function VendorBusinessProfilePane({ ctx }: { ctx: Ctx }) {
  const { draft, setDraft, fieldState, fieldError, commit, sectionState } = useBusinessProfileAutosave(
    ctx,
    BUSINESS_PROFILE_FIELDS,
  );
  return (
    <PortalSettingsSection title="Business profile" action={<SectionSaveBadge state={sectionState} />}>
      <PortalSettingsGroup>
        {ctx.loading ? (
          <div className="px-4 py-4">
            <ListSkeleton rows={2} showLeading={false} />
          </div>
        ) : (
          <PortalSettingsFormBody className="space-y-0 divide-y divide-border/70 px-0 py-0">
            {ctx.error ? (
              <p role="alert" className="rounded-lg border px-3 py-2 text-sm portal-banner-danger">
                {ctx.error}{" "}
                <button type="button" className="font-semibold underline" onClick={() => void ctx.reload()}>
                  Retry
                </button>
              </p>
            ) : null}
            <PortalSettingsAutosaveField
              label="Business name"
              htmlFor="vendor-business-name"
              state={fieldState.businessName}
              error={fieldError.businessName}
              onRetry={() => void commit("businessName")}
            >
              <Input
                id="vendor-business-name"
                value={draft.businessName}
                maxLength={120}
                onChange={(e) => setDraft({ ...draft, businessName: e.target.value })}
                onBlur={() => void commit("businessName")}
                data-attr="vendor-business-name"
              />
            </PortalSettingsAutosaveField>
            <PortalSettingsAutosaveField
              label="Contact name"
              htmlFor="vendor-business-contact-name"
              state={fieldState.contactName}
              error={fieldError.contactName}
              onRetry={() => void commit("contactName")}
            >
              <Input
                id="vendor-business-contact-name"
                value={draft.contactName}
                maxLength={120}
                onChange={(e) => setDraft({ ...draft, contactName: e.target.value })}
                onBlur={() => void commit("contactName")}
                data-attr="vendor-business-contact-name"
              />
            </PortalSettingsAutosaveField>
          </PortalSettingsFormBody>
        )}
      </PortalSettingsGroup>
    </PortalSettingsSection>
  );
}

const SERVICE_AREA_FIELDS = ["serviceArea"] as const;

/**
 * Settings → Trades & service area: ONE card of two rows in the settings kit —
 * Service area (the existing free-text field, saved on blur) and Trades (a
 * multi-select dropdown with an Other entry, saved on pick through the same
 * `PATCH /api/vendor/profile { trades }`). No section subheads, no subtext.
 */
export function VendorTradesServiceAreaPane({
  ctx,
  trades,
  tradeOptions,
  onTradesChange,
  tradesState,
  loading,
}: {
  ctx: Ctx;
  trades: string[];
  tradeOptions: readonly string[];
  onTradesChange: (next: string[]) => void;
  tradesState: PortalSettingsSaveState;
  loading: boolean;
}) {
  const { draft, setDraft, fieldState, fieldError, commit } = useBusinessProfileAutosave(ctx, SERVICE_AREA_FIELDS);
  const areaState = fieldState.serviceArea;
  const status = (state: PortalSettingsSaveState, error?: string) =>
    state === "saving" ? (
      <span className="text-xs text-muted">Saving…</span>
    ) : state === "saved" ? (
      <span className="text-xs font-semibold text-[var(--status-confirmed-fg,#15803d)]">Saved</span>
    ) : state === "error" ? (
      <span className="text-xs font-semibold text-red-600" role="alert">
        {error ?? "Could not save."}
      </span>
    ) : null;
  return (
    <PortalSettingsGroup>
      {ctx.loading || loading ? (
        <div className="px-4 py-4">
          <ListSkeleton rows={2} showLeading={false} />
        </div>
      ) : (
        <>
          <PortalSettingsRow label="Service area">
            <div className="flex items-center justify-end gap-3">
              {status(areaState, fieldError.serviceArea)}
              <Input
                id="vendor-business-service-area"
                aria-label="Service area"
                className="w-64 max-w-full"
                value={draft.serviceArea}
                maxLength={200}
                placeholder="Seattle"
                onChange={(e) => setDraft({ ...draft, serviceArea: e.target.value })}
                onBlur={() => void commit("serviceArea")}
                data-attr="vendor-business-service-area"
              />
            </div>
          </PortalSettingsRow>
          <PortalSettingsRow label="Trades">
            <div className="flex items-center justify-end gap-3">
              {status(tradesState)}
              <div className="w-64 max-w-full text-left" data-vs-trades>
                <CheckboxMultiSelect
                  label="Trades"
                  hideLabel
                  options={tradeOptions.map((option) => ({ value: option, label: option }))}
                  selected={trades}
                  onChange={onTradesChange}
                  emptyLabel="Select trades"
                  dataAttr="vendor-trades-select"
                />
              </div>
            </div>
          </PortalSettingsRow>
        </>
      )}
    </PortalSettingsGroup>
  );
}

const LICENSE_FIELDS = ["licenseNumber"] as const;
const INSURANCE_FIELDS = ["insuranceProvider", "insurancePolicyNumber", "insuranceExpiresAt"] as const;

function useAutosavedTextField<F extends keyof VendorBusinessProfileView>(
  state: ReturnType<typeof useBusinessProfileAutosave<F>>,
) {
  const { draft, setDraft, fieldState, fieldError, commit } = state;
  // A named function declaration, not an anonymous arrow: this builds one row of
  // the settings form, so it needs a name for react/display-name to read.
  return function autosavedTextField(field: F, label: string, id: string, type: "text" | "date" = "text") {
    return (
      <PortalSettingsAutosaveField
        label={label}
        htmlFor={id}
        state={fieldState[field]}
        error={fieldError[field]}
        onRetry={() => void commit(field)}
      >
        <Input
          id={id}
          type={type}
          value={typeof draft[field] === "string" ? (draft[field] as string) : ""}
          maxLength={type === "date" ? undefined : 120}
          onChange={(e) => setDraft({ ...draft, [field]: e.target.value })}
          onBlur={() => void commit(field)}
          data-attr={id}
        />
      </PortalSettingsAutosaveField>
    );
  };
}

/** Documents > Business license: the vendor's own license number (the license and bond files upload beside it). */
export function VendorLicenseFields({ ctx }: { ctx: Ctx }) {
  const autosave = useBusinessProfileAutosave(ctx, LICENSE_FIELDS);
  const text = useAutosavedTextField<(typeof LICENSE_FIELDS)[number]>(autosave);
  return (
    <PortalSettingsSection title="License" action={<SectionSaveBadge state={autosave.sectionState} />}>
      <PortalSettingsGroup>
        {ctx.loading ? (
          <div className="px-4 py-4">
            <ListSkeleton rows={1} showLeading={false} />
          </div>
        ) : (
          <PortalSettingsFormBody className="space-y-0 divide-y divide-border/70 px-0 py-0">
            {text("licenseNumber", "License number", "vendor-license-number")}
          </PortalSettingsFormBody>
        )}
      </PortalSettingsGroup>
    </PortalSettingsSection>
  );
}

/** Documents > Insurance: provider, policy number and expiry (the certificate files upload beside it). */
export function VendorInsuranceFields({ ctx }: { ctx: Ctx }) {
  const autosave = useBusinessProfileAutosave(ctx, INSURANCE_FIELDS);
  const text = useAutosavedTextField<(typeof INSURANCE_FIELDS)[number]>(autosave);
  return (
    <PortalSettingsSection title="Coverage" action={<SectionSaveBadge state={autosave.sectionState} />}>
      <PortalSettingsGroup>
        {ctx.loading ? (
          <div className="px-4 py-4">
            <ListSkeleton rows={3} showLeading={false} />
          </div>
        ) : (
          <PortalSettingsFormBody className="space-y-0 divide-y divide-border/70 px-0 py-0">
            {text("insuranceProvider", "Provider", "vendor-insurance-provider")}
            {text("insurancePolicyNumber", "Policy number", "vendor-insurance-policy")}
            {text("insuranceExpiresAt", "Expires", "vendor-insurance-expires", "date")}
          </PortalSettingsFormBody>
        )}
      </PortalSettingsGroup>
    </PortalSettingsSection>
  );
}

/** Human status for one identity channel — the same blockedReason vocabulary the platform uses everywhere else. */
export function identityStatusLabel(value: VendorWorkIdentityResponse[keyof Pick<VendorWorkIdentityResponse, "email" | "sms">] | undefined): string {
  if (!value) return "Unavailable";
  if (value.blockedReason === "provider_disabled") return "Disabled";
  if (value.blockedReason === "provider_unconfigured") return "Unavailable";
  if (value.blockedReason === "platform_capacity_reached") return "Capacity reached";
  if (value.blockedReason === "subscription_required") return "Subscription needed";
  if (value.state === "provisioning" || value.state === "reconciling") return "Pending";
  if (value.state === "blocked" || value.state === "quarantined") return "Failed";
  if (value.state === "disabled" || value.state === "released") return "Disabled";
  if (value.sendReady && value.receiveReady) return "Ready";
  if (value.state === "ready") return value.sendReady ? "Send ready" : value.receiveReady ? "Receive ready" : "Failed";
  return "Not set up";
}

export function useVendorWorkIdentity() {
  const [identity, setIdentity] = useState<VendorWorkIdentityResponse | null>(null);
  const [load, setLoad] = useState<"loading" | "ready" | "failed">("loading");
  const reload = useCallback(async () => {
    setLoad("loading");
    try {
      const res = await fetch("/api/vendor/work-identity", { credentials: "include", cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.identity) throw new Error("unavailable");
      setIdentity(body.identity as VendorWorkIdentityResponse);
      setLoad("ready");
    } catch {
      setLoad("failed");
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { identity, setIdentity, load, reload };
}

/**
 * The real, free, PropLane-provisioned work email (VD05). Unlike the mock
 * plan's local-part picker, no `<business>.proplane.work` domain or
 * inbound-mail infrastructure exists today (see docs/agents/inbound-email-inbox.md
 * — real inbound mail lands at the root prop-lane.space domain, not a
 * subdomain) and the real provider always mints its own
 * `vendor-<uuid>@<domain>` address rather than accepting a chosen local part.
 * This claims that real address with one button rather than fabricating a
 * local-part-availability flow the backend cannot honor.
 */
function VendorWorkEmailClaim({
  identity,
  load,
  reload,
}: {
  identity: VendorWorkIdentityResponse | null;
  load: "loading" | "ready" | "failed";
  reload: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);
  const value = identity?.email;

  async function claimEmail() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/vendor/work-identity", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel: "email", idempotencyKey: crypto.randomUUID() }),
      });
      if (!res.ok) throw new Error("unavailable");
      reload();
    } catch {
      setError("Could not claim a work email. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (load === "loading") {
    return (
      <div className="px-4 py-4" role="status" aria-label="Loading work email">
        <ListSkeleton rows={1} showLeading={false} />
      </div>
    );
  }
  if (load === "failed") {
    return (
      <p className="px-4 py-4 text-sm text-danger" role="alert">
        Could not load{" "}
        <button type="button" className="font-semibold underline" onClick={reload}>
          Retry
        </button>
      </p>
    );
  }
  if (value?.value) {
    return (
      <div className="space-y-2 px-4 py-4" data-attr="vs-claimed-email">
        <div className="flex items-center justify-between gap-3">
          <span className="min-w-0 truncate text-[14.5px] font-bold text-foreground">{value.value}</span>
          <button
            type="button"
            className="grid size-9 shrink-0 place-items-center rounded-lg text-muted hover:bg-accent/40 hover:text-foreground"
            aria-label="Copy work email"
            onClick={() => void copyTextToClipboard(value.value ?? "").then((ok) => ok && setCopied(true))}
          >
            {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
          </button>
        </div>
        <p className="text-sm text-muted">{identityStatusLabel(value)}</p>
        <div className="flex items-center justify-between gap-3 text-sm">
          <span>Cost</span>
          <span className="font-medium">Free · covered by PropLane</span>
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-3 px-4 py-4" data-attr="vs-claimflow-email">
      <p className="text-[12.5px] text-muted">
        {value?.canSetup ? "Get a free PropLane-provided inbox for job email." : identityStatusLabel(value)}
      </p>
      {value?.canSetup ? (
        <Button variant="primary" disabled={busy} onClick={() => void claimEmail()} data-attr="vendor-work-email-claim">
          {busy ? "Claiming…" : "Claim work email"}
        </Button>
      ) : null}
      {error ? <p className="text-[12.5px] text-danger">{error}</p> : null}
    </div>
  );
}

const WORK_CONTACT_FIELDS = ["workPhone", "workEmail"] as const;

/**
 * Merged "Work contact & email" (VD04/VD05) — the vendor's own free-text
 * business phone/email (autosaving), plus the free PropLane-provisioned work
 * email claim. The PropLane text number, its forwarding toggle and the usage
 * line are the separate Settings > Work number & email page
 * (vendor-work-number-settings.tsx); a vendor claims one once their phone is
 * verified (Settings > Messaging, and onboarding).
 */
export function VendorWorkIdentitySection({ ctx }: { ctx: Ctx }) {
  const { draft, setDraft, fieldState, fieldError, commit, sectionState } = useBusinessProfileAutosave(
    ctx,
    WORK_CONTACT_FIELDS,
  );
  const { identity, load, reload } = useVendorWorkIdentity();
  return (
    <PortalSettingsSection title="Work contact & email" action={<SectionSaveBadge state={sectionState} />}>
      <PortalSettingsGroup>
        <div className="border-b border-border px-4 pb-1 pt-3 text-[11px] font-bold uppercase tracking-[0.08em] text-muted">
          Business contact info
        </div>
        {ctx.loading ? (
          <div className="px-4 py-4">
            <ListSkeleton rows={2} showLeading={false} />
          </div>
        ) : (
          <PortalSettingsFormBody className="space-y-0 divide-y divide-border/70 px-0 py-0">
            <PortalSettingsAutosaveField
              label="Business phone"
              htmlFor="vendor-work-phone"
              state={fieldState.workPhone}
              error={fieldError.workPhone}
              onRetry={() => void commit("workPhone")}
            >
              <Input
                id="vendor-work-phone"
                type="tel"
                value={draft.workPhone}
                placeholder="(206) 555-0142"
                onChange={(e) => setDraft({ ...draft, workPhone: e.target.value })}
                onBlur={() => void commit("workPhone")}
                data-attr="vendor-work-phone"
              />
            </PortalSettingsAutosaveField>
            <PortalSettingsAutosaveField
              label="Work email"
              htmlFor="vendor-work-email"
              state={fieldState.workEmail}
              error={fieldError.workEmail}
              onRetry={() => void commit("workEmail")}
            >
              <Input
                id="vendor-work-email"
                type="email"
                value={draft.workEmail}
                placeholder="office@yourbusiness.com"
                onChange={(e) => setDraft({ ...draft, workEmail: e.target.value })}
                onBlur={() => void commit("workEmail")}
                data-attr="vendor-work-email"
              />
            </PortalSettingsAutosaveField>
          </PortalSettingsFormBody>
        )}
        <div className="border-t border-border">
          <div className="flex items-center gap-1.5 px-4 pb-1 pt-3 text-[11px] font-bold uppercase tracking-[0.08em] text-muted">
            <Mail className="size-3.5" aria-hidden /> PropLane work email
          </div>
          <VendorWorkEmailClaim identity={identity} load={load} reload={reload} />
        </div>
      </PortalSettingsGroup>
    </PortalSettingsSection>
  );
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
          <div className="px-4 py-4">
            <ListSkeleton rows={2} showLeading={false} />
          </div>
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
