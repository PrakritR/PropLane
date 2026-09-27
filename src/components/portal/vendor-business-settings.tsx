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
import { Building2, Check, Copy, Mail, Phone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ListSkeleton } from "@/components/ui/list-skeleton";
import { Badge } from "@/components/ui/badge";
import { copyTextToClipboard } from "@/lib/manager-property-links";
import { formatSmsPhoneLabel } from "@/lib/phone-e164";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import {
  PortalSettingsAutosaveField,
  PortalSettingsFormBody,
  PortalSettingsGroup,
  PortalSettingsSection,
  type PortalSettingsSaveState,
} from "@/components/portal/portal-settings-ui";
import type { VendorWorkIdentityResponse } from "@/lib/vendor-work-identity";

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

const BUSINESS_PROFILE_FIELDS = ["businessName", "contactName", "serviceArea"] as const;

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
            <PortalSettingsAutosaveField
              label="Service area"
              htmlFor="vendor-business-service-area"
              state={fieldState.serviceArea}
              error={fieldError.serviceArea}
              onRetry={() => void commit("serviceArea")}
            >
              <Input
                id="vendor-business-service-area"
                value={draft.serviceArea}
                maxLength={200}
                placeholder="Seattle · Plumbing and property maintenance"
                onChange={(e) => setDraft({ ...draft, serviceArea: e.target.value })}
                onBlur={() => void commit("serviceArea")}
                data-attr="vendor-business-service-area"
              />
            </PortalSettingsAutosaveField>
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

type SmsCandidate = { phoneNumber: string; claimToken: string };
type SmsClaimState = {
  step: "code" | "pick";
  areaCode: string;
  candidates: SmsCandidate[];
  selected: SmsCandidate | null;
  busy: boolean;
  error: string | null;
};
const SMS_CLAIM_IDLE: SmsClaimState = { step: "code", areaCode: "", candidates: [], selected: null, busy: false, error: null };

/**
 * The real, free, PropLane-provisioned work number — area code -> pick one of
 * 3 -> claim (VD04). Distinct from the free-text "Business contact info"
 * phone above: this is a platform-owned Twilio line, never purchased in a
 * test (the search/claim calls are the only Twilio-touching paths, and both
 * are mocked at the server-module boundary in tests).
 */
function VendorWorkNumberClaim({
  identity,
  load,
  reload,
}: {
  identity: VendorWorkIdentityResponse | null;
  load: "loading" | "ready" | "failed";
  reload: () => void;
}) {
  const [claim, setClaim] = useState<SmsClaimState>(SMS_CLAIM_IDLE);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);
  const value = identity?.sms;

  async function searchNumbers() {
    const digits = claim.areaCode.replace(/\D/g, "").slice(0, 3);
    if (!/^[2-9]\d{2}$/.test(digits)) {
      setClaim((c) => ({ ...c, error: "Enter a valid 3-digit area code." }));
      return;
    }
    setClaim((c) => ({ ...c, busy: true, error: null }));
    try {
      const res = await fetch("/api/vendor/work-identity/candidates", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ areaCode: digits }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; candidates?: SmsCandidate[]; error?: string };
      if (!res.ok || !body.candidates?.length) {
        setClaim((c) => ({ ...c, busy: false, error: body.error ?? "No numbers available in that area code — try another." }));
        return;
      }
      setClaim({ step: "pick", areaCode: digits, candidates: body.candidates, selected: body.candidates[0] ?? null, busy: false, error: null });
    } catch {
      setClaim((c) => ({ ...c, busy: false, error: "Could not search numbers right now." }));
    }
  }

  async function claimNumber() {
    if (!claim.selected) return;
    setClaim((c) => ({ ...c, busy: true, error: null }));
    try {
      const res = await fetch("/api/vendor/work-identity", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel: "sms",
          idempotencyKey: crypto.randomUUID(),
          phoneNumber: claim.selected.phoneNumber,
          claimToken: claim.selected.claimToken,
        }),
      });
      if (!res.ok) throw new Error("unavailable");
      setClaim(SMS_CLAIM_IDLE);
      reload();
    } catch {
      setClaim((c) => ({ ...c, busy: false, error: "Could not claim that number. Try again." }));
    }
  }

  if (load === "loading") {
    return (
      <div className="px-4 py-4" role="status" aria-label="Loading work number">
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
    const display = formatSmsPhoneLabel(value.value) || value.value;
    return (
      <div className="space-y-2 px-4 py-4" data-attr="vs-claimed-number">
        <div className="flex items-center justify-between gap-3">
          <span className="text-[15px] font-bold text-foreground">{display}</span>
          <button
            type="button"
            className="grid size-9 place-items-center rounded-lg text-muted hover:bg-accent/40 hover:text-foreground"
            aria-label="Copy work number"
            onClick={() => void copyTextToClipboard(display).then((ok) => ok && setCopied(true))}
          >
            {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
          </button>
        </div>
        <p className="text-sm text-muted">{value.sendReady && value.receiveReady ? "Calls & texts on" : `${identityStatusLabel(value)} · calls and texts turn on once carrier registration completes`}</p>
        <div className="flex items-center justify-between gap-3 text-sm">
          <span>Cost</span>
          <span className="font-medium">Free · covered by PropLane</span>
        </div>
      </div>
    );
  }
  if (!value?.canSetup) {
    return (
      <p className="px-4 py-4 text-sm text-muted" data-attr="vs-work-number-blocked">
        {identityStatusLabel(value)}
      </p>
    );
  }
  if (claim.step === "code") {
    return (
      <div className="space-y-3 px-4 py-4" data-attr="vs-claimflow-number">
        <p className="text-[12.5px] text-muted">Choose an area code for your free PropLane work number.</p>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-[11.5px] font-medium text-muted">
            Area code
            <Input
              className="w-[110px]"
              inputMode="numeric"
              maxLength={3}
              placeholder="206"
              value={claim.areaCode}
              onChange={(e) => setClaim((c) => ({ ...c, areaCode: e.target.value.replace(/\D/g, "").slice(0, 3) }))}
              data-attr="vendor-work-number-area-code"
            />
          </label>
          <Button variant="primary" disabled={claim.busy} onClick={() => void searchNumbers()} data-attr="vendor-work-number-see-numbers">
            {claim.busy ? "Searching…" : "See numbers"}
          </Button>
        </div>
        {claim.error ? <p className="text-[12.5px] text-danger">{claim.error}</p> : null}
      </div>
    );
  }
  return (
    <div className="space-y-3 px-4 py-4" data-attr="vs-numcards">
      <p className="text-[12.5px] text-muted">Pick a number in the {claim.areaCode} area code.</p>
      <div className="flex flex-col gap-2">
        {claim.candidates.map((candidate) => {
          const active = candidate.phoneNumber === claim.selected?.phoneNumber;
          return (
            <button
              key={candidate.phoneNumber}
              type="button"
              onClick={() => setClaim((c) => ({ ...c, selected: candidate }))}
              data-attr="vendor-work-number-candidate"
              aria-pressed={active}
              className={`flex items-center justify-between rounded-lg border px-3.5 py-3 text-left text-sm font-bold ${active ? "border-primary bg-primary/10 text-primary" : "border-border bg-card text-foreground"}`}
            >
              <span>{formatSmsPhoneLabel(candidate.phoneNumber) || candidate.phoneNumber}</span>
              {active ? <Check className="size-4" /> : null}
            </button>
          );
        })}
      </div>
      <div className="flex flex-wrap gap-3">
        <Button variant="outline" disabled={claim.busy} onClick={() => setClaim(SMS_CLAIM_IDLE)} data-attr="vendor-work-number-change-area-code">
          Different area code
        </Button>
        <Button variant="primary" disabled={claim.busy || !claim.selected} onClick={() => void claimNumber()} data-attr="vendor-work-number-claim">
          {claim.busy ? "Claiming…" : `Claim ${claim.selected ? formatSmsPhoneLabel(claim.selected.phoneNumber) || claim.selected.phoneNumber : "number"}`}
        </Button>
      </div>
      {claim.error ? <p className="text-[12.5px] text-danger">{claim.error}</p> : null}
    </div>
  );
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

/**
 * Read-only "your PropLane work number" line for the Messaging tab (VD69) —
 * states plainly that it is free, with no claim UI of its own (that lives in
 * the Work number & email section). Real data only: no SMS-credit/upsell copy
 * exists to remove here because none was ever added for the sponsored vendor
 * number (only the manager-side messaging panel has plan-gated copy).
 */
export function VendorWorkNumberStatusNote() {
  const { identity, load } = useVendorWorkIdentity();
  if (load === "loading") return null;
  const value = identity?.sms;
  return (
    <PortalSettingsSection title="Work number">
      <PortalSettingsGroup>
        <div className="flex items-center justify-between gap-3 px-4 py-3.5">
          <span className="text-sm font-medium text-foreground">
            {value?.value ? formatSmsPhoneLabel(value.value) || value.value : identityStatusLabel(value)}
          </span>
          <span className="text-sm text-muted">Free · covered by PropLane</span>
        </div>
      </PortalSettingsGroup>
    </PortalSettingsSection>
  );
}

const WORK_CONTACT_FIELDS = ["workPhone", "workEmail"] as const;

/**
 * Merged "Work number & email" (VD04/VD05) — every field the old Work
 * contacts / Work number / Work email trio had, in one section: the vendor's
 * own free-text business phone/email (autosaving), plus the real, free
 * PropLane-provisioned number and email claim flows. Forward-to-personal
 * toggles from the studio plan are deliberately NOT built here — no
 * forward_to_phone/forward_to_email column or delivery path exists on
 * vendor_work_identities today, and a toggle with nothing behind it would be
 * a fabricated control.
 */
export function VendorWorkIdentitySection({ ctx }: { ctx: Ctx }) {
  const { draft, setDraft, fieldState, fieldError, commit, sectionState } = useBusinessProfileAutosave(
    ctx,
    WORK_CONTACT_FIELDS,
  );
  const { identity, load, reload } = useVendorWorkIdentity();
  return (
    <PortalSettingsSection title="Work number & email" action={<SectionSaveBadge state={sectionState} />}>
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
              label="Work number"
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
        <div className="grid gap-0 border-t border-border sm:grid-cols-2 sm:divide-x sm:divide-border">
          <div>
            <div className="flex items-center gap-1.5 px-4 pb-1 pt-3 text-[11px] font-bold uppercase tracking-[0.08em] text-muted">
              <Phone className="size-3.5" aria-hidden /> PropLane work number
            </div>
            <VendorWorkNumberClaim identity={identity} load={load} reload={reload} />
          </div>
          <div>
            <div className="flex items-center gap-1.5 border-t border-border px-4 pb-1 pt-3 text-[11px] font-bold uppercase tracking-[0.08em] text-muted sm:border-t-0">
              <Mail className="size-3.5" aria-hidden /> PropLane work email
            </div>
            <VendorWorkEmailClaim identity={identity} load={load} reload={reload} />
          </div>
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
