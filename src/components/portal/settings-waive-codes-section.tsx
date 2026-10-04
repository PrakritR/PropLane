"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Ban, Check, X } from "lucide-react";
import { CheckboxMultiSelect, FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { Input } from "@/components/ui/input";
import { PortalIconAction, PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { PortalSettingsGroup, PortalSettingsSection } from "@/components/portal/portal-settings-ui";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import type { ApplicationFeeWaiverCode, WaiverCodeAppliesTo } from "@/lib/application-fee-waiver";

/**
 * Settings -> Leasing -> Waive codes. One list of the workspace's codes, whichever fee they waive.
 *
 * A code waives the application fee, the lease fee, or both (`appliesTo`); it works on every property or only
 * the ones picked (workspace-wide by default); it can carry a use cap and an expiry. Every row edits in place and
 * saves as it changes. Disabling a code is permanent (a retired code keeps its text and its use count), so it is
 * the one control that confirms. The server owns every rule (`/api/manager/application-fee-waivers`).
 */

const APPLIES_TO_OPTIONS: { value: WaiverCodeAppliesTo; label: string }[] = [
  { value: "application", label: "Application" },
  { value: "lease", label: "Lease" },
  { value: "both", label: "Both" },
];

type PropertyOption = { id: string; label: string };

type Draft = {
  code: string;
  appliesTo: WaiverCodeAppliesTo;
  maxUses: string;
  expires: string;
  propertyIds: string[];
};

function emptyDraft(appliesTo: WaiverCodeAppliesTo): Draft {
  return { code: "", appliesTo, maxUses: "", expires: "", propertyIds: [] };
}

/** `yyyy-mm-dd` in the viewer's own calendar for a stored instant. */
function dateInputValue(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The end of the chosen day, so "expires Dec 31" still works all day on Dec 31. */
function endOfDayIso(date: string): string | null {
  if (!date) return null;
  const d = new Date(`${date}T23:59:59`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function usesCapNumber(raw: string): number | null {
  const n = Math.round(Number(raw));
  return raw.trim() && Number.isFinite(n) && n > 0 ? n : null;
}

function CodeFields({
  draft,
  onChange,
  propertyOptions,
  disabled,
  idPrefix,
}: {
  draft: Draft;
  onChange: (patch: Partial<Draft>, commit: boolean) => void;
  propertyOptions: PropertyOption[];
  disabled?: boolean;
  idPrefix: string;
}) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <FieldSingleSelect
        label="Applies to"
        hideLabel
        variant="cell"
        className="min-w-[128px]"
        value={draft.appliesTo}
        disabled={disabled}
        options={APPLIES_TO_OPTIONS}
        dataAttr={`${idPrefix}-applies-to`}
        onChange={(next) => onChange({ appliesTo: next as WaiverCodeAppliesTo }, true)}
      />
      <Input
        type="number"
        min={1}
        inputMode="numeric"
        aria-label="Uses"
        placeholder="Unlimited"
        className="w-28"
        value={draft.maxUses}
        disabled={disabled}
        data-attr={`${idPrefix}-uses`}
        onChange={(e) => onChange({ maxUses: e.target.value }, false)}
        onBlur={() => onChange({}, true)}
      />
      <Input
        type="date"
        aria-label="Expires"
        className="w-40"
        value={draft.expires}
        disabled={disabled}
        data-attr={`${idPrefix}-expires`}
        onChange={(e) => onChange({ expires: e.target.value }, true)}
      />
      <CheckboxMultiSelect
        label="Properties"
        hideLabel
        variant="cell"
        className="min-w-[160px]"
        options={propertyOptions.map((p) => ({ value: p.id, label: p.label }))}
        selected={draft.propertyIds}
        emptyLabel="All properties"
        disabled={disabled}
        dataAttr={`${idPrefix}-properties`}
        onChange={(next) => onChange({ propertyIds: next }, true)}
      />
    </div>
  );
}

export function WaiveCodesSettingsSection({
  propertyOptions,
  defaultAppliesTo = "application",
}: {
  propertyOptions: PropertyOption[];
  /** What a new code applies to until the manager changes it: the Applications tab says application, the Lease tab lease. */
  defaultAppliesTo?: WaiverCodeAppliesTo;
}) {
  const { showToast } = useAppUi();
  const demo = isDemoModeActive();
  const [codes, setCodes] = useState<ApplicationFeeWaiverCode[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [adding, setAdding] = useState<Draft | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDisableId, setConfirmDisableId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/manager/application-fee-waivers", { credentials: "include" });
      const data = (await res.json().catch(() => ({}))) as { codes?: ApplicationFeeWaiverCode[]; error?: string };
      if (!res.ok) {
        showToast(data.error ?? "Could not load waive codes.");
        return;
      }
      const list = data.codes ?? [];
      setCodes(list);
      setDrafts(Object.fromEntries(list.map((c) => [c.id, draftOf(c)])));
    } catch {
      showToast("Could not load waive codes.");
    } finally {
      setLoaded(true);
    }
  }, [showToast]);

  useEffect(() => {
    // /demo never writes real rows, so it never reads them either.
    if (!demo) void load();
  }, [demo, load]);

  const active = useMemo(() => codes.filter((c) => c.status === "active"), [codes]);
  const disabledCodes = useMemo(() => codes.filter((c) => c.status !== "active"), [codes]);

  if (demo) return null;

  async function save(id: string, draft: Draft) {
    const current = codes.find((c) => c.id === id);
    if (!current) return;
    const maxUses = usesCapNumber(draft.maxUses);
    const patch = {
      action: "update",
      appliesTo: draft.appliesTo,
      propertyIds: draft.propertyIds,
      maxUses,
      expiresAt: endOfDayIso(draft.expires),
    };
    // Nothing changed (a blur on an untouched field): no request.
    const unchanged =
      current.appliesTo === draft.appliesTo &&
      sameSet(draftOf(current).propertyIds, draft.propertyIds) &&
      current.maxUses === maxUses &&
      dateInputValue(current.expiresAt) === draft.expires;
    if (unchanged) return;
    setBusyId(id);
    try {
      const res = await fetch(`/api/manager/application-fee-waivers/${id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = (await res.json().catch(() => ({}))) as { code?: ApplicationFeeWaiverCode; error?: string };
      if (!res.ok || !data.code) {
        showToast(data.error ?? "Could not save that code.");
        // Put the row back to what is stored, so the screen never shows a rule the server refused.
        setDrafts((prev) => ({ ...prev, [id]: draftOf(current) }));
        return;
      }
      const saved = data.code;
      setCodes((prev) => prev.map((c) => (c.id === id ? saved : c)));
      setDrafts((prev) => ({ ...prev, [id]: draftOf(saved) }));
    } catch {
      showToast("Could not save that code.");
      setDrafts((prev) => ({ ...prev, [id]: draftOf(current) }));
    } finally {
      setBusyId(null);
    }
  }

  async function disable(id: string) {
    setBusyId(id);
    try {
      const res = await fetch(`/api/manager/application-fee-waivers/${id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "revoke" }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        showToast(data.error ?? "Could not disable that code.");
        return;
      }
      setConfirmDisableId(null);
      showToast("Code disabled.");
      await load();
    } catch {
      showToast("Could not disable that code.");
    } finally {
      setBusyId(null);
    }
  }

  async function create(draft: Draft) {
    setBusyId("new");
    try {
      const res = await fetch("/api/manager/application-fee-waivers", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: draft.code.trim() || undefined,
          appliesTo: draft.appliesTo,
          propertyIds: draft.propertyIds,
          maxUses: usesCapNumber(draft.maxUses),
          expiresAt: endOfDayIso(draft.expires),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        showToast(data.error ?? "Could not create that code.");
        return;
      }
      setAdding(null);
      showToast("Waive code created.");
      await load();
    } catch {
      showToast("Could not create that code.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <PortalSettingsSection
      title="Waive codes"
      action={
        <PortalPrimaryIconAction
          label="Add waive code"
          data-attr="waive-codes-add"
          disabled={Boolean(adding)}
          onClick={() => setAdding(emptyDraft(defaultAppliesTo))}
        />
      }
    >
      <PortalSettingsGroup>
        {adding ? (
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3" data-attr="waive-codes-new-row">
            <Input
              aria-label="Code"
              placeholder="Code (blank to generate)"
              className="w-48 font-mono uppercase"
              value={adding.code}
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              data-attr="waive-codes-new-code"
              onChange={(e) => setAdding({ ...adding, code: e.target.value.toUpperCase() })}
            />
            <CodeFields
              idPrefix="waive-codes-new"
              draft={adding}
              propertyOptions={propertyOptions}
              disabled={busyId === "new"}
              onChange={(patch) => setAdding({ ...adding, ...patch })}
            />
            <div className="flex items-center gap-1">
              <PortalIconAction label="Create code" icon={Check} tone="primary" disabled={busyId === "new"} data-attr="waive-codes-new-save" onClick={() => create(adding)} />
              <PortalIconAction label="Cancel" icon={X} disabled={busyId === "new"} data-attr="waive-codes-new-cancel" onClick={() => setAdding(null)} />
            </div>
          </div>
        ) : null}
        {loaded && active.length === 0 && !adding ? (
          <div className="px-4 py-3 text-[15px] text-muted" data-attr="waive-codes-empty">
            No waive codes
          </div>
        ) : null}
        {active.map((code) => {
          const draft = drafts[code.id] ?? draftOf(code);
          const usedLabel = code.maxUses == null ? `${code.usedCount} used` : `${code.usedCount} of ${code.maxUses} used`;
          return (
            <div
              key={code.id}
              className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3 last:border-0"
              data-attr="waive-codes-row"
            >
              <div className="min-w-0">
                <p className="font-mono text-[15px] font-semibold tracking-tight text-foreground">{code.code}</p>
                <p className="text-[13px] tabular-nums text-muted">{usedLabel}</p>
              </div>
              <CodeFields
                idPrefix="waive-codes-row"
                draft={draft}
                propertyOptions={propertyOptions}
                disabled={busyId === code.id}
                onChange={(patch, commit) => {
                  const next = { ...draft, ...patch };
                  setDrafts((prev) => ({ ...prev, [code.id]: next }));
                  if (commit) void save(code.id, next);
                }}
              />
              {confirmDisableId === code.id ? (
                <div className="flex items-center gap-1">
                  <PortalIconAction label="Confirm disable" icon={Check} tone="danger" disabled={busyId === code.id} data-attr="waive-codes-disable-confirm" onClick={() => disable(code.id)} />
                  <PortalIconAction label="Keep code" icon={X} data-attr="waive-codes-disable-cancel" onClick={() => setConfirmDisableId(null)} />
                </div>
              ) : (
                <PortalIconAction label="Disable code" icon={Ban} tone="danger" data-attr="waive-codes-disable" onClick={() => setConfirmDisableId(code.id)} />
              )}
            </div>
          );
        })}
        {disabledCodes.map((code) => (
          <div key={code.id} className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5 last:border-0 opacity-60" data-attr="waive-codes-disabled-row">
            <p className="font-mono text-[15px] text-foreground line-through">{code.code}</p>
            <p className="text-[13px] tabular-nums text-muted">Disabled · {code.usedCount} used</p>
          </div>
        ))}
      </PortalSettingsGroup>
    </PortalSettingsSection>
  );
}

function draftOf(code: ApplicationFeeWaiverCode): Draft {
  return {
    code: code.code,
    appliesTo: code.appliesTo,
    maxUses: code.maxUses == null ? "" : String(code.maxUses),
    expires: dateInputValue(code.expiresAt),
    // A legacy code limited to one property reads as that property, so the picker never shows "All" over a limit.
    propertyIds: code.propertyIds.length > 0 ? code.propertyIds : code.propertyId ? [code.propertyId] : [],
  };
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}
