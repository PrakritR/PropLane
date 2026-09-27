"use client";

/**
 * Settings → Forms (C110/C113/C231/C232/C233, automation C228).
 *
 * The one net-new settings nav entry (`portal-profile-client.tsx`, Portfolio
 * group, next to Applications / Leases). It gives naming, the application
 * intake-question builder (long-term / short-term / co-signer variants,
 * reusing the SAME workspace template `manager-application-form-settings.tsx`
 * edits — `src/lib/rental-application/workspace-application-form.ts`), a
 * net-new lease clause template with `{variable}` chips and a live preview,
 * and (C228) an Automation block per form next to its "Used at" row.
 *
 * Scope:
 * - "Used at" lists which properties currently follow the workspace
 *   application form (not opted into their own custom one) — real, computed
 *   from each property's own `applicationFormSource`. Leases have no such
 *   per-property opt-out today, so their "Used at" is simply every property.
 * - Automation (auto-approve, fee + charge policy for Applications; signing
 *   cost, auto-generate/auto-send for Lease) moved OFF the property record
 *   page and onto the form itself — `ApplicationFormAutomationBlock` /
 *   `LeaseFormAutomationBlock` below. Storage is unchanged: one workspace
 *   rung the property's own Handling section can still override, same
 *   `/api/portal/manager-application-settings` route — a form variant has no
 *   id of its own to key a per-variant override on, so this edits the shared
 *   workspace value rather than inventing per-variant storage (see those
 *   components' own doc comment). A promo code stays on Settings →
 *   Applications, where a single property is actually selected — it is
 *   unique per property, never workspace-wide.
 * - "Compare and confirm PDF" import is reached here through the same
 *   per-property Form editor Applications/Lease settings already use
 *   (`ManagerPropertyApplicationFormEditor` / `ManagerPropertyLeaseFormEditor`)
 *   rather than a new workspace-level import route — the import route is
 *   property-scoped server-side and this reuses it exactly, never bypasses it.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Trash2, ChevronUp, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { useReportSettingsSaveStatus } from "@/components/portal/settings-save-status-context";
import { useSettingsPropertyScope } from "@/components/portal/settings-property-scope";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import {
  PortalSettingsDisclosureRow,
  PortalSettingsGroup,
  PortalSettingsRow,
  PortalSettingsScopeTag,
  PortalSettingsSection,
  PortalSettingsToggle,
} from "@/components/portal/portal-settings-ui";
import {
  DEFAULT_APPLICATION_AUTOMATION,
  normalizeApplicationAutomation,
  type ApplicationAutomationPreferences,
} from "@/lib/application-automation-preferences";
import {
  DEFAULT_MANAGER_APPLICATION_SETTINGS,
  normalizeManagerApplicationSettings,
  type ApplicationFeeChargePolicy,
  type ManagerApplicationSettings,
} from "@/lib/manager-application-settings";
import {
  DEFAULT_LEASING_PIPELINE,
  normalizeLeasingPipelinePreferences,
  type LeasingPipelinePreferences,
} from "@/lib/leasing-pipeline-preferences";
import { PORTAL_TOOLBAR_PILL_BUTTON, PORTAL_TOOLBAR_PILL_BUTTON_ACTIVE } from "@/components/portal/portal-metrics";
import { ApplicationFormBuilder } from "@/components/portal/application-form-builder";
import { sanitizeCustomApplicationFieldsForSave, validateField } from "@/components/portal/application-question-edit-modal";
import { ManagerPropertyApplicationFormEditor } from "@/components/portal/pro-edit-application-modal";
import { ManagerPropertyLeaseFormEditor } from "@/components/portal/pro-edit-leases-modal";
import { resolveManagerListingSubmissionForPropertyId } from "@/lib/manager-property-save-target";
import {
  emptyCustomApplicationField,
  normalizeCustomApplicationFieldsForEditor,
} from "@/lib/manager-listing-submission";
import {
  addListingApplicationField,
  canMoveCustomApplicationField,
  editorVisibleDisabledApplicationFields,
  moveCustomApplicationField,
  moveCustomApplicationFieldToSection,
  patchListingApplicationField,
  reenableListingApplicationField,
  removeListingApplicationField,
  resolveListingApplicationFields,
  type ApplicationConfigSlice,
  type ResolvedApplicationField,
} from "@/lib/rental-application/application-field-catalog";
import { DEFAULT_CUSTOM_FIELD_SECTION_ID } from "@/lib/rental-application/application-sections";
import {
  applyShareAcrossVariants,
  emptyWorkspaceApplicationFormTemplate,
  type WorkspaceApplicationFormTemplate,
} from "@/lib/rental-application/workspace-application-form";
import {
  applicationTerm,
  emptyFormsTerminology,
  leaseTerm,
  type FormsTerminology,
} from "@/lib/rental-application/forms-terminology";
import {
  emptyWorkspaceLeaseClauseTemplate,
  fillClauseSample,
  LEASE_TEMPLATE_VARIABLES,
  newLeaseClauseEntry,
  type LeaseClauseTemplateEntry,
  type WorkspaceLeaseClauseTemplate,
} from "@/lib/lease-templates/workspace-lease-clause-template";

type ApplicationVariant = "main" | "shortTerm" | "cosigner";

const APPLICATION_VARIANT_TABS: { id: ApplicationVariant; label: string }[] = [
  { id: "main", label: "Long-term" },
  { id: "shortTerm", label: "Short-term" },
  { id: "cosigner", label: "Co-signer" },
];

function variantSlice(template: WorkspaceApplicationFormTemplate, variant: ApplicationVariant): ApplicationConfigSlice {
  if (variant === "shortTerm") {
    return {
      disabledStandardApplicationKeys: template.shortTermDisabledStandardApplicationKeys,
      customApplicationFields: template.shortTermCustomApplicationFields,
      applicationConfigMode: template.shortTermApplicationConfigMode,
    };
  }
  if (variant === "cosigner") {
    return {
      disabledStandardApplicationKeys: template.cosignerDisabledStandardApplicationKeys,
      customApplicationFields: template.cosignerCustomApplicationFields,
      applicationConfigMode: template.cosignerApplicationConfigMode,
    };
  }
  return {
    disabledStandardApplicationKeys: template.disabledStandardApplicationKeys,
    customApplicationFields: template.customApplicationFields,
    applicationConfigMode: template.applicationConfigMode,
  };
}

function withVariantSlice(
  template: WorkspaceApplicationFormTemplate,
  variant: ApplicationVariant,
  slice: ApplicationConfigSlice,
): WorkspaceApplicationFormTemplate {
  if (variant === "shortTerm") {
    return {
      ...template,
      shortTermDisabledStandardApplicationKeys: slice.disabledStandardApplicationKeys,
      shortTermCustomApplicationFields: slice.customApplicationFields,
      shortTermApplicationConfigMode: slice.applicationConfigMode,
      // Editing a variant directly means it is no longer mirroring long-term.
      shareAcrossVariants: false,
    };
  }
  if (variant === "cosigner") {
    return {
      ...template,
      cosignerDisabledStandardApplicationKeys: slice.disabledStandardApplicationKeys,
      cosignerCustomApplicationFields: slice.customApplicationFields,
      cosignerApplicationConfigMode: slice.applicationConfigMode,
      shareAcrossVariants: false,
    };
  }
  // Editing long-term goes through the same mirror `manager-application-form-settings.tsx`
  // uses: when "share across variants" is on, long-term still drives short-term/cosigner.
  return applyShareAcrossVariants({
    ...template,
    disabledStandardApplicationKeys: slice.disabledStandardApplicationKeys,
    customApplicationFields: slice.customApplicationFields,
    applicationConfigMode: slice.applicationConfigMode,
  });
}

function ApplicationVariantEditor({
  template,
  variant,
  onSave,
  saving,
}: {
  template: WorkspaceApplicationFormTemplate;
  variant: ApplicationVariant;
  onSave: (next: WorkspaceApplicationFormTemplate) => void;
  saving: boolean;
}) {
  const [expandedQuestionIds, setExpandedQuestionIds] = useState<Set<string>>(() => new Set());
  const slice = useMemo(() => variantSlice(template, variant), [template, variant]);
  const applicationFields = useMemo<ResolvedApplicationField[]>(
    () => resolveListingApplicationFields(slice, normalizeCustomApplicationFieldsForEditor),
    [slice],
  );
  const disabledFields = useMemo<ResolvedApplicationField[]>(
    () => editorVisibleDisabledApplicationFields("standard", slice),
    [slice],
  );
  const fieldErrors = useMemo(() => {
    const usedKeys = new Set<string>();
    const errors = new Map<string, string>();
    for (const f of applicationFields) {
      const err = validateField(f, usedKeys);
      if (err) errors.set(f.id, err);
    }
    return errors;
  }, [applicationFields]);

  const applySlice = (nextSlice: ApplicationConfigSlice) => {
    onSave(withVariantSlice(template, variant, nextSlice));
  };

  return (
    <div className="space-y-3" data-attr={`forms-application-variant-${variant}`}>
      <ApplicationFormBuilder
        applicationFields={applicationFields}
        disabledFields={disabledFields}
        expandedQuestionIds={expandedQuestionIds}
        onToggleExpand={(id) =>
          setExpandedQuestionIds((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
          })
        }
        fieldErrors={fieldErrors}
        onAddQuestion={(sectionId) =>
          applySlice({ ...slice, ...addListingApplicationField(slice, emptyCustomApplicationField(sectionId)) })
        }
        onRemoveField={(field) => applySlice(removeListingApplicationField(slice, field))}
        onReenableField={(field) => field.standardKey && applySlice(reenableListingApplicationField(slice, field.standardKey))}
        onPatchField={(field, patch) => applySlice(patchListingApplicationField(slice, field, patch))}
        onMoveField={(field, direction) =>
          applySlice(moveCustomApplicationField(slice, field.id, direction, normalizeCustomApplicationFieldsForEditor))
        }
        onMoveFieldToSection={(field, sectionId) =>
          applySlice(moveCustomApplicationFieldToSection(slice, field.id, sectionId, normalizeCustomApplicationFieldsForEditor))
        }
        canMoveField={(field, direction) =>
          canMoveCustomApplicationField(slice, field.id, direction, normalizeCustomApplicationFieldsForEditor)
        }
      />
      <Button
        type="button"
        variant="outline"
        className="rounded-full"
        data-attr={`forms-application-add-question-${variant}`}
        disabled={saving}
        onClick={() =>
          applySlice({ ...slice, ...addListingApplicationField(slice, emptyCustomApplicationField(DEFAULT_CUSTOM_FIELD_SECTION_ID)) })
        }
      >
        <Plus className="mr-1.5 size-4" aria-hidden />
        Add question
      </Button>
    </div>
  );
}

function LeaseClauseEditor({
  template,
  onChange,
}: {
  template: WorkspaceLeaseClauseTemplate;
  onChange: (next: WorkspaceLeaseClauseTemplate) => void;
}) {
  const insertVariable = (clause: LeaseClauseTemplateEntry, key: string) => {
    onChange({
      ...template,
      clauses: template.clauses.map((c) => (c.id === clause.id ? { ...c, body: `${c.body}{${key}}` } : c)),
    });
  };
  const patchClause = (id: string, patch: Partial<LeaseClauseTemplateEntry>) => {
    onChange({ ...template, clauses: template.clauses.map((c) => (c.id === id ? { ...c, ...patch } : c)) });
  };
  const removeClause = (id: string) => {
    onChange({ ...template, clauses: template.clauses.filter((c) => c.id !== id) });
  };
  const moveClause = (index: number, direction: "up" | "down") => {
    const next = template.clauses.slice();
    const target = direction === "up" ? index - 1 : index + 1;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    onChange({ ...template, clauses: next });
  };

  return (
    <div className="space-y-4" data-attr="forms-lease-clause-editor">
      {template.clauses.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-3 py-3 text-sm text-muted">
          No clauses yet. Add one to start the lease template.
        </p>
      ) : null}
      {template.clauses.map((clause, index) => (
        <div key={clause.id} className="space-y-2 rounded-2xl border border-border bg-card p-3">
          <div className="flex items-center gap-2">
            <Input
              value={clause.title}
              onChange={(e) => patchClause(clause.id, { title: e.target.value })}
              placeholder="Clause title"
              className="flex-1"
              data-attr={`forms-lease-clause-title-${clause.id}`}
            />
            <PortalIconAction
              icon={ChevronUp}
              label="Move clause up"
              disabled={index === 0}
              onClick={() => moveClause(index, "up")}
              data-attr={`forms-lease-clause-move-up-${clause.id}`}
            />
            <PortalIconAction
              icon={ChevronDown}
              label="Move clause down"
              disabled={index === template.clauses.length - 1}
              onClick={() => moveClause(index, "down")}
              data-attr={`forms-lease-clause-move-down-${clause.id}`}
            />
            <PortalIconAction
              icon={Trash2}
              label="Delete clause"
              tone="danger"
              onClick={() => removeClause(clause.id)}
              data-attr={`forms-lease-clause-delete-${clause.id}`}
            />
          </div>
          <Textarea
            value={clause.body}
            onChange={(e) => patchClause(clause.id, { body: e.target.value })}
            rows={4}
            placeholder="Clause text — insert a variable below"
            data-attr={`forms-lease-clause-body-${clause.id}`}
          />
          <div className="flex flex-wrap gap-1.5">
            {LEASE_TEMPLATE_VARIABLES.map((variable) => (
              <button
                key={variable.key}
                type="button"
                className={PORTAL_TOOLBAR_PILL_BUTTON}
                data-attr={`forms-lease-clause-variable-${variable.key}`}
                onClick={() => insertVariable(clause, variable.key)}
              >
                {variable.label}
              </button>
            ))}
          </div>
          {clause.body ? (
            <div className="rounded-xl bg-accent/30 px-3 py-2 text-xs text-muted">
              <p className="mb-1 font-semibold text-foreground/70">Preview with sample data</p>
              <p className="whitespace-pre-wrap">{fillClauseSample(clause.body)}</p>
            </div>
          ) : null}
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        className="rounded-full"
        data-attr="forms-lease-clause-add"
        onClick={() => onChange({ ...template, clauses: [...template.clauses, newLeaseClauseEntry(`c_${Math.random().toString(36).slice(2, 10)}`)] })}
      >
        <Plus className="mr-1.5 size-4" aria-hidden />
        Add clause
      </Button>
    </div>
  );
}

/**
 * C228: the property record page's own lease/application automation block is
 * gone — a property now just shows which form it uses (link to here). This
 * is that automation's new home, one Automation block per form ("Used at"
 * sits right above it).
 *
 * Storage is unchanged (C228's own instruction): automation today is ONE set
 * per workspace, with per-property overrides resolved through the settings
 * scope resolver when edited from Settings → Applications/Lease. A form
 * variant (long-term/short-term/co-signer) has no id of its own to key a
 * per-variant override on — inventing one would mean a migration — so this
 * block edits the SAME workspace-level automation every variant already
 * shares, surfaced here rather than forked. A promo code is excluded: it is
 * unique per property (`manager-application-settings.ts`), never a
 * workspace-wide value, so it stays on Settings → Applications where a
 * property is actually selected.
 */
function ApplicationFormAutomationBlock() {
  const { showToast } = useAppUi();
  const demo = isDemoModeActive();
  const { workspaceId } = useSettingsPropertyScope();
  const reportSaveStatus = useReportSettingsSaveStatus();
  const [automation, setAutomation] = useState<ApplicationAutomationPreferences>(DEFAULT_APPLICATION_AUTOMATION);
  const [settings, setSettings] = useState<ManagerApplicationSettings>(DEFAULT_MANAGER_APPLICATION_SETTINGS);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (demo) {
        if (!cancelled) {
          setAutomation(DEFAULT_APPLICATION_AUTOMATION);
          setSettings(DEFAULT_MANAGER_APPLICATION_SETTINGS);
          setLoaded(true);
        }
        return;
      }
      try {
        const params = new URLSearchParams();
        if (workspaceId) params.set("workspaceId", workspaceId);
        const query = params.toString() ? `?${params.toString()}` : "";
        const res = await fetch(`/api/portal/manager-application-settings${query}`, { credentials: "include" });
        const body = (await res.json().catch(() => ({}))) as { automation?: unknown; settings?: unknown; error?: string };
        if (!res.ok) throw new Error(body.error ?? "Could not load application settings.");
        if (!cancelled) {
          setAutomation(normalizeApplicationAutomation(body.automation));
          setSettings(normalizeManagerApplicationSettings(body.settings));
          setLoaded(true);
        }
      } catch (e) {
        showToast(e instanceof Error ? e.message : "Could not load application settings.");
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [demo, showToast, workspaceId]);

  const patch = async (fields: { automation?: ApplicationAutomationPreferences; applicationFeeCents?: number | null; applicationFeeChargePolicy?: ApplicationFeeChargePolicy }) => {
    if (demo) return;
    reportSaveStatus({ type: "start" });
    try {
      const res = await fetch("/api/portal/manager-application-settings", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...fields, ...(workspaceId ? { workspaceId } : {}) }),
        keepalive: true,
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? "Could not save application settings.");
      reportSaveStatus({ type: "success" });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Could not save application settings.";
      showToast(message);
      reportSaveStatus({ type: "failure", reason: message });
    }
  };

  const disabled = !loaded;
  const feeDollars =
    settings.applicationFeeCents == null ? "" : (settings.applicationFeeCents / 100).toFixed(settings.applicationFeeCents % 100 === 0 ? 0 : 2);

  return (
    <PortalSettingsGroup className="mb-3">
      <PortalSettingsRow label="Auto-approve applications">
        <PortalSettingsToggle
          checked={automation.autoApproveApplications}
          onChange={(next) => {
            const nextAutomation = { ...automation, autoApproveApplications: next };
            setAutomation(nextAutomation);
            void patch({ automation: nextAutomation });
          }}
          label="Auto-approve applications"
          disabled={disabled}
          dataAttr="forms-application-auto-approve"
        />
      </PortalSettingsRow>
      <PortalSettingsRow label="Application cost">
        <Input
          aria-label="Application cost"
          className="w-28 text-right"
          value={feeDollars}
          disabled={disabled}
          placeholder="50"
          data-attr="forms-application-fee"
          onChange={(e) => {
            const raw = e.target.value.trim().replace(/[^0-9.]/g, "");
            const cents = raw === "" ? null : Math.round(Number(raw) * 100);
            setSettings((prev) => ({ ...prev, applicationFeeCents: Number.isFinite(cents) ? cents : null }));
          }}
          onBlur={() => void patch({ applicationFeeCents: settings.applicationFeeCents })}
        />
      </PortalSettingsRow>
      <PortalSettingsRow label="Charge policy">
        <FieldSingleSelect
          label="Charge policy"
          hideLabel
          variant="cell"
          value={settings.applicationFeeChargePolicy}
          disabled={disabled}
          options={[
            { value: "first_only", label: "First submission only" },
            { value: "every_time", label: "Every new application" },
          ]}
          onChange={(next) => {
            const policy = next as ApplicationFeeChargePolicy;
            setSettings((prev) => ({ ...prev, applicationFeeChargePolicy: policy }));
            void patch({ applicationFeeChargePolicy: policy });
          }}
          dataAttr="forms-application-charge-policy"
        />
      </PortalSettingsRow>
    </PortalSettingsGroup>
  );
}

/** Lease's Automation block (C228) — signing cost and the two send-lifecycle toggles, same workspace-level storage as Applications' block above. */
function LeaseFormAutomationBlock() {
  const { showToast } = useAppUi();
  const demo = isDemoModeActive();
  const { workspaceId } = useSettingsPropertyScope();
  const reportSaveStatus = useReportSettingsSaveStatus();
  const [automation, setAutomation] = useState<ApplicationAutomationPreferences>(DEFAULT_APPLICATION_AUTOMATION);
  const [leasingPipeline, setLeasingPipeline] = useState<LeasingPipelinePreferences>(DEFAULT_LEASING_PIPELINE);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (demo) {
        if (!cancelled) {
          setAutomation(DEFAULT_APPLICATION_AUTOMATION);
          setLeasingPipeline(DEFAULT_LEASING_PIPELINE);
          setLoaded(true);
        }
        return;
      }
      try {
        const params = new URLSearchParams();
        if (workspaceId) params.set("workspaceId", workspaceId);
        const query = params.toString() ? `?${params.toString()}` : "";
        const res = await fetch(`/api/portal/manager-application-settings${query}`, { credentials: "include" });
        const body = (await res.json().catch(() => ({}))) as { automation?: unknown; leasingPipeline?: unknown; error?: string };
        if (!res.ok) throw new Error(body.error ?? "Could not load lease settings.");
        if (!cancelled) {
          setAutomation(normalizeApplicationAutomation(body.automation));
          setLeasingPipeline(normalizeLeasingPipelinePreferences(body.leasingPipeline));
          setLoaded(true);
        }
      } catch (e) {
        showToast(e instanceof Error ? e.message : "Could not load lease settings.");
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [demo, showToast, workspaceId]);

  const patch = async (fields: { automation?: ApplicationAutomationPreferences; leasingPipeline?: LeasingPipelinePreferences }) => {
    if (demo) return;
    reportSaveStatus({ type: "start" });
    try {
      const res = await fetch("/api/portal/manager-application-settings", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...fields, ...(workspaceId ? { workspaceId } : {}) }),
        keepalive: true,
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? "Could not save lease settings.");
      reportSaveStatus({ type: "success" });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Could not save lease settings.";
      showToast(message);
      reportSaveStatus({ type: "failure", reason: message });
    }
  };

  const disabled = !loaded;
  const signingFeeDollars =
    leasingPipeline.leaseSigningFeeCents == null
      ? ""
      : (leasingPipeline.leaseSigningFeeCents / 100).toFixed(leasingPipeline.leaseSigningFeeCents % 100 === 0 ? 0 : 2);

  return (
    <PortalSettingsGroup className="mb-3">
      <PortalSettingsRow label="Lease signing cost">
        <Input
          aria-label="Lease signing cost"
          className="w-28 text-right"
          value={signingFeeDollars}
          disabled={disabled}
          placeholder="0"
          data-attr="forms-lease-signing-fee"
          onChange={(e) => {
            const raw = e.target.value.trim().replace(/[^0-9.]/g, "");
            const cents = raw === "" ? null : Math.round(Number(raw) * 100);
            setLeasingPipeline((prev) => ({ ...prev, leaseSigningFeeCents: Number.isFinite(cents) ? cents : null }));
          }}
          onBlur={() => void patch({ leasingPipeline })}
        />
      </PortalSettingsRow>
      <PortalSettingsRow label="Auto-generate the lease on approval">
        <PortalSettingsToggle
          checked={automation.autoGenerateLease}
          onChange={(next) => {
            const nextAutomation = { ...automation, autoGenerateLease: next };
            setAutomation(nextAutomation);
            void patch({ automation: nextAutomation });
          }}
          label="Auto-generate the lease on approval"
          disabled={disabled}
          dataAttr="forms-lease-auto-generate"
        />
      </PortalSettingsRow>
      <PortalSettingsRow label="Auto-send the lease to the resident">
        <PortalSettingsToggle
          checked={automation.autoSendLease}
          onChange={(next) => {
            const nextAutomation = { ...automation, autoSendLease: next };
            setAutomation(nextAutomation);
            void patch({ automation: nextAutomation });
          }}
          label="Auto-send the lease to the resident"
          disabled={disabled}
          dataAttr="forms-lease-auto-send"
        />
      </PortalSettingsRow>
    </PortalSettingsGroup>
  );
}

export function ManagerFormsSettingsPanel({ propertyOptions }: { propertyOptions: { id: string; label: string }[] }) {
  const { showToast } = useAppUi();
  const { userId: managerUserId } = useManagerUserId();

  // --- Naming --------------------------------------------------------------
  const [terminology, setTerminology] = useState<FormsTerminology>(emptyFormsTerminology());
  const [terminologyLoaded, setTerminologyLoaded] = useState(false);
  const [applicationLabelDraft, setApplicationLabelDraft] = useState("");
  const [leaseLabelDraft, setLeaseLabelDraft] = useState("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/portal/forms-terminology");
        const body = (await res.json().catch(() => ({}))) as { terminology?: unknown };
        if (cancelled || !res.ok) return;
        const next = (body.terminology as FormsTerminology) ?? emptyFormsTerminology();
        setTerminology(next);
        setApplicationLabelDraft(next.applicationLabel ?? "");
        setLeaseLabelDraft(next.leaseLabel ?? "");
      } finally {
        if (!cancelled) setTerminologyLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const saveTerminology = useCallback(
    async (next: FormsTerminology) => {
      setTerminology(next);
      try {
        const res = await fetch("/api/portal/forms-terminology", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ terminology: next }),
        });
        if (!res.ok) throw new Error("Could not save naming.");
      } catch {
        showToast("Could not save naming. Try again.");
      }
    },
    [showToast],
  );

  const applicationLabel = applicationTerm(terminology);
  const leaseLabel = leaseTerm(terminology);

  // --- Application intake form ----------------------------------------------
  const [appTemplate, setAppTemplate] = useState<WorkspaceApplicationFormTemplate | null>(null);
  const [appVariant, setAppVariant] = useState<ApplicationVariant>("main");
  const [appSaving, setAppSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/portal/application-form");
        const body = (await res.json().catch(() => ({}))) as { template?: WorkspaceApplicationFormTemplate };
        if (!cancelled) setAppTemplate(body.template ?? emptyWorkspaceApplicationFormTemplate());
      } catch {
        if (!cancelled) setAppTemplate(emptyWorkspaceApplicationFormTemplate());
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const saveAppTemplate = useCallback(
    async (next: WorkspaceApplicationFormTemplate) => {
      setAppTemplate(next);
      setAppSaving(true);
      try {
        const sanitized: WorkspaceApplicationFormTemplate = {
          ...next,
          customApplicationFields: sanitizeCustomApplicationFieldsForSave(next.customApplicationFields),
          shortTermCustomApplicationFields: sanitizeCustomApplicationFieldsForSave(next.shortTermCustomApplicationFields),
          cosignerCustomApplicationFields: sanitizeCustomApplicationFieldsForSave(next.cosignerCustomApplicationFields),
        };
        const res = await fetch("/api/portal/application-form", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ template: sanitized }),
        });
        const body = (await res.json().catch(() => ({}))) as { template?: WorkspaceApplicationFormTemplate; error?: string };
        if (!res.ok) throw new Error(body.error ?? "Could not save the application form.");
        setAppTemplate(body.template ?? sanitized);
      } catch (e) {
        showToast(e instanceof Error ? e.message : "Could not save the application form.");
      } finally {
        setAppSaving(false);
      }
    },
    [showToast],
  );

  // "Used at": properties that follow the workspace form rather than their
  // own custom override (`applicationFormSource !== "custom"`).
  const applicationUsedAt = useMemo(() => {
    if (!managerUserId) return { count: 0, total: propertyOptions.length, labels: [] as string[] };
    const labels: string[] = [];
    for (const option of propertyOptions) {
      const hit = resolveManagerListingSubmissionForPropertyId(managerUserId, option.id);
      const source = (hit?.sub as { applicationFormSource?: "workspace" | "custom" } | undefined)?.applicationFormSource;
      if (source !== "custom") labels.push(option.label);
    }
    return { count: labels.length, total: propertyOptions.length, labels };
  }, [managerUserId, propertyOptions]);

  // --- Lease clause template -------------------------------------------------
  const [leaseTemplate, setLeaseTemplate] = useState<WorkspaceLeaseClauseTemplate>(emptyWorkspaceLeaseClauseTemplate());
  const [leaseSaving, setLeaseSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/portal/lease-clause-template");
        const body = (await res.json().catch(() => ({}))) as { template?: WorkspaceLeaseClauseTemplate };
        if (!cancelled) setLeaseTemplate(body.template ?? emptyWorkspaceLeaseClauseTemplate());
      } catch {
        if (!cancelled) setLeaseTemplate(emptyWorkspaceLeaseClauseTemplate());
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const saveLeaseTemplate = useCallback(
    async (next: WorkspaceLeaseClauseTemplate) => {
      setLeaseTemplate(next);
      setLeaseSaving(true);
      try {
        const res = await fetch("/api/portal/lease-clause-template", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ template: next }),
        });
        const body = (await res.json().catch(() => ({}))) as { template?: WorkspaceLeaseClauseTemplate; error?: string };
        if (!res.ok) throw new Error(body.error ?? "Could not save the lease template.");
        setLeaseTemplate(body.template ?? next);
      } catch (e) {
        showToast(e instanceof Error ? e.message : "Could not save the lease template.");
      } finally {
        setLeaseSaving(false);
      }
    },
    [showToast],
  );

  // Import (C232/C233): reuse the exact per-property Form editor + its
  // existing "Compare and confirm PDF" import flow rather than a new route.
  // The editor itself already defaults to (and lets a manager change) one
  // property, so this only needs to hand it a starting point.
  const importPropertyId = propertyOptions[0]?.id;

  return (
    <>
      <PortalSettingsSection title="Naming">
        <PortalSettingsGroup>
          <PortalSettingsRow label="Call applications">
            <Input
              value={applicationLabelDraft}
              onChange={(e) => setApplicationLabelDraft(e.target.value)}
              onBlur={() => void saveTerminology({ ...terminology, applicationLabel: applicationLabelDraft.trim() || null })}
              placeholder="Application"
              className="w-44"
              disabled={!terminologyLoaded}
              data-attr="forms-term-application"
            />
          </PortalSettingsRow>
          <PortalSettingsRow label="Call leases">
            <Input
              value={leaseLabelDraft}
              onChange={(e) => setLeaseLabelDraft(e.target.value)}
              onBlur={() => void saveTerminology({ ...terminology, leaseLabel: leaseLabelDraft.trim() || null })}
              placeholder="Lease"
              className="w-44"
              disabled={!terminologyLoaded}
              data-attr="forms-term-lease"
            />
          </PortalSettingsRow>
        </PortalSettingsGroup>
      </PortalSettingsSection>

      <PortalSettingsSection title={applicationLabel}>
        <div className="mb-3 flex flex-wrap gap-1.5">
          {APPLICATION_VARIANT_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={appVariant === tab.id ? PORTAL_TOOLBAR_PILL_BUTTON_ACTIVE : PORTAL_TOOLBAR_PILL_BUTTON}
              data-attr={`forms-application-tab-${tab.id}`}
              onClick={() => setAppVariant(tab.id)}
            >
              {tab.label} {applicationLabel.toLowerCase()}
            </button>
          ))}
        </div>
        <PortalSettingsGroup className="mb-3">
          <PortalSettingsRow label="Used at">
            <PortalSettingsScopeTag variant="muted">
              {applicationUsedAt.total === 0
                ? "No properties yet"
                : `${applicationUsedAt.count} of ${applicationUsedAt.total} properties`}
            </PortalSettingsScopeTag>
          </PortalSettingsRow>
        </PortalSettingsGroup>
        {/* C228: automation moved off the property record page onto the form it belongs to. */}
        <p className="mb-2 text-[13px] font-semibold text-muted">Automation</p>
        <ApplicationFormAutomationBlock />
        {appTemplate ? (
          <ApplicationVariantEditor
            key={appVariant}
            template={appTemplate}
            variant={appVariant}
            onSave={(next) => void saveAppTemplate(next)}
            saving={appSaving}
          />
        ) : (
          <p className="text-sm text-muted">Loading…</p>
        )}
        <PortalSettingsGroup className="mt-4">
          <PortalSettingsDisclosureRow label="Import from an existing PDF" dataAttr="forms-application-import-disclosure">
            {propertyOptions.length === 0 ? (
              <p className="text-sm text-muted">Add a property to import a PDF application into.</p>
            ) : (
              <ManagerPropertyApplicationFormEditor
                active
                propertyOptions={propertyOptions}
                initialPropertyId={importPropertyId}
                managerUserId={managerUserId}
                onSaved={() => showToast("Saved.")}
                showToast={showToast}
                onBulkActionsChange={() => {}}
              />
            )}
          </PortalSettingsDisclosureRow>
        </PortalSettingsGroup>
      </PortalSettingsSection>

      <PortalSettingsSection title={leaseLabel}>
        <PortalSettingsGroup className="mb-3">
          <PortalSettingsRow label="Used at">
            <PortalSettingsScopeTag variant="muted">
              {propertyOptions.length === 0 ? "No properties yet" : "All properties"}
            </PortalSettingsScopeTag>
          </PortalSettingsRow>
        </PortalSettingsGroup>
        {/* C228: automation moved off the property record page onto the form it belongs to. */}
        <p className="mb-2 text-[13px] font-semibold text-muted">Automation</p>
        <LeaseFormAutomationBlock />
        <LeaseClauseEditor template={leaseTemplate} onChange={(next) => void saveLeaseTemplate(next)} />
        {leaseSaving ? <p className="mt-2 text-xs text-muted">Saving…</p> : null}
        <PortalSettingsGroup className="mt-4">
          <PortalSettingsDisclosureRow label="Import from an existing PDF" dataAttr="forms-lease-import-disclosure">
            {propertyOptions.length === 0 ? (
              <p className="text-sm text-muted">Add a property to import a PDF lease into.</p>
            ) : (
              <ManagerPropertyLeaseFormEditor
                active
                propertyOptions={propertyOptions}
                initialPropertyId={importPropertyId}
                managerUserId={managerUserId}
                onSaved={() => showToast("Saved.")}
                showToast={showToast}
                onBulkActionsChange={() => {}}
              />
            )}
          </PortalSettingsDisclosureRow>
        </PortalSettingsGroup>
      </PortalSettingsSection>
    </>
  );
}
