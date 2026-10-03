"use client";

/**
 * Settings -> Workspace -> "Applications & leases" (C2-CP7, C2-CP8, C2-CP9).
 *
 * MOUNT: render `<WorkspaceApplicationsLeasesSettings />` inside the Workspace settings page
 * (the settings shell's "Workspace" section, next to the other workspace sections). It is
 * self-contained: it loads and saves its own data, needs no props and no provider (it reads the
 * optional settings scope context when one exists).
 *
 * What lives here, and where it is stored:
 * - Signing order, Roommates in a shared room sign: the workspace leasing pipeline record
 *   (`manager_automation_settings.row_data.leasingPipeline`, `leasing-pipeline-preferences.ts`).
 *   One value for every property; a house override can no longer carry its own order.
 * - Auto-send the lease: the workspace application automation (`autoSendLease`).
 * - Deposit accounting: the workspace lease automation (`lease-automation-settings.ts`).
 * - The application <-> lease mapping and the co-signer links: on each property's own templates
 *   (`application-lease-mapping.ts`), written through the property record, one property at a time.
 *
 * "Who signs first" used to be a second label for the signing order (the Lease tab's gear and the
 * application row's signature icon both read `pipelineOrder`), so it is the Signing order row.
 */
import { syncPropertyPipelineFromServer } from "@/lib/demo-property-pipeline";
import { PROPERTY_PIPELINE_EVENT } from "@/lib/property-pipeline-events";
import { WORKSPACE_SELECTION_EVENT } from "@/lib/workspaces/selection";
import { useCallback, useEffect, useMemo, useState } from "react";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import {
  PortalSettingsGroup,
  PortalSettingsRow,
  PortalSettingsSection,
} from "@/components/portal/portal-settings-ui";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { useReportSettingsSaveStatus } from "@/components/portal/settings-save-status-context";
import { useSettingsPropertyScope } from "@/components/portal/settings-property-scope";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import {
  DEFAULT_APPLICATION_AUTOMATION,
  normalizeApplicationAutomation,
  type ApplicationAutomationPreferences,
} from "@/lib/application-automation-preferences";
import {
  DEFAULT_LEASE_AUTOMATION_SETTINGS,
  DEPOSIT_ACCOUNTING_OPTIONS,
  normalizeLeaseAutomationSettings,
  type LeaseAutomationSettings,
} from "@/lib/lease-automation-settings";
import {
  DEFAULT_LEASING_PIPELINE,
  normalizeLeasingPipelinePreferences,
  type LeasingPipelinePreferences,
  type PipelineOrder,
  type SharedRoomLeaseDefault,
} from "@/lib/leasing-pipeline-preferences";
import { cacheLeasingPipelinePreferences } from "@/lib/leasing-pipeline-client-cache";
import {
  isCosignerApplicationTemplate,
  isAddendumLeaseTemplate,
  mappingRows,
  setMappingTarget,
} from "@/lib/application-lease-mapping";
import {
  persistManagerListingSubmissionOnServer,
  resolveManagerListingSubmissionForPropertyId,
  type ManagerPropertySaveTarget,
} from "@/lib/manager-property-save-target";
import { normalizeManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { readExtraListingsForUser, readPendingManagerPropertiesForUser } from "@/lib/demo-property-pipeline";
import { collectLinkedPropertyIdsForModule } from "@/lib/manager-portfolio-access";
import { syncPropertyLeaseTemplatesFromListing } from "@/lib/property-lease-template-sync";
import { syncPropertyApplicationTemplatesFromListing } from "@/lib/property-application-template-sync";
import {
  readPropertyApplicationTemplates,
  updatePropertyApplicationTemplate,
  withPropertyApplicationTemplatesExplicit,
  type PropertyApplicationTemplate,
} from "@/lib/property-application-templates";
import {
  readPropertyLeaseTemplates,
  syncLegacyLeaseFieldsFromTemplates,
  updatePropertyLeaseTemplate,
  type PropertyLeaseTemplate,
} from "@/lib/property-lease-templates";

const NONE = "__none__";

const SIGNING_ORDER_OPTIONS = [
  { value: "application_then_lease", label: "Application first, then lease" },
  { value: "lease_then_application", label: "Lease first, then application" },
];

const SHARED_ROOM_OPTIONS = [
  { value: "individual", label: "One lease per resident" },
  { value: "joint", label: "One joint lease for roommates" },
];

type PropertyEntry = {
  id: string;
  label: string;
  saveTarget: ManagerPropertySaveTarget;
  sub: ReturnType<typeof normalizeManagerListingSubmissionV1>;
  applications: PropertyApplicationTemplate[];
  leases: PropertyLeaseTemplate[];
};

function loadPropertyEntries(managerUserId: string): PropertyEntry[] {
  const ids = new Set<string>();
  for (const listing of readExtraListingsForUser(managerUserId)) ids.add(listing.id);
  for (const pending of readPendingManagerPropertiesForUser(managerUserId)) ids.add(pending.id);
  // A co-manager's linked homes live under the owner's id, never the viewer's.
  for (const id of collectLinkedPropertyIdsForModule(managerUserId, "leases")) ids.add(id);
  const out: PropertyEntry[] = [];
  for (const id of ids) {
    const hit = resolveManagerListingSubmissionForPropertyId(managerUserId, id);
    if (!hit) continue;
    const withLeases = syncPropertyLeaseTemplatesFromListing(hit.sub);
    const synced = hit.sub.propertyApplicationTemplatesExplicit
      ? withLeases
      : syncPropertyApplicationTemplatesFromListing(withLeases);
    out.push({
      id,
      label: hit.sub.buildingName?.trim() || hit.sub.address?.trim() || "Property",
      saveTarget: hit.saveTarget,
      sub: normalizeManagerListingSubmissionV1(synced),
      applications: readPropertyApplicationTemplates(synced),
      leases: readPropertyLeaseTemplates(synced),
    });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

export function WorkspaceApplicationsLeasesSettings() {
  const { showToast } = useAppUi();
  const demo = isDemoModeActive();
  const reportSaveStatus = useReportSettingsSaveStatus();
  const { workspaceId } = useSettingsPropertyScope();
  const { userId: managerUserId } = useManagerUserId();

  const [loaded, setLoaded] = useState(false);
  const [pipeline, setPipeline] = useState<LeasingPipelinePreferences>(DEFAULT_LEASING_PIPELINE);
  const [automation, setAutomation] = useState<ApplicationAutomationPreferences>(DEFAULT_APPLICATION_AUTOMATION);
  const [leaseAutomation, setLeaseAutomation] = useState<LeaseAutomationSettings>(DEFAULT_LEASE_AUTOMATION_SETTINGS);
  const [properties, setProperties] = useState<PropertyEntry[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (demo) {
        if (!cancelled) setLoaded(true);
        return;
      }
      try {
        const params = new URLSearchParams();
        if (workspaceId) params.set("workspaceId", workspaceId);
        const query = params.toString() ? `?${params.toString()}` : "";
        const [settingsRes, leaseRes] = await Promise.all([
          fetch(`/api/portal/manager-application-settings${query}`, { credentials: "include", cache: "no-store" }),
          fetch("/api/portal/lease-automation-settings", { credentials: "include", cache: "no-store" }),
        ]);
        const settings = (await settingsRes.json().catch(() => ({}))) as {
          leasingPipeline?: unknown;
          automation?: unknown;
          error?: string;
        };
        if (!settingsRes.ok) throw new Error(settings.error ?? "Could not load settings.");
        const lease = (await leaseRes.json().catch(() => ({}))) as { settings?: unknown };
        if (cancelled) return;
        setPipeline(cacheLeasingPipelinePreferences(settings.leasingPipeline));
        setAutomation(normalizeApplicationAutomation(settings.automation));
        if (leaseRes.ok) setLeaseAutomation(normalizeLeaseAutomationSettings(lease.settings));
      } catch (e) {
        showToast(e instanceof Error ? e.message : "Could not load settings.");
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [demo, showToast, workspaceId]);

  // The property store is filled by the portfolio sync; opening Settings directly
  // must not show an empty map, so pull it here and re-read on every change.
  useEffect(() => {
    if (!managerUserId) return;
    const reload = () => setProperties(loadPropertyEntries(managerUserId));
    reload();
    if (!demo) void syncPropertyPipelineFromServer().then(reload).catch(() => {});
    window.addEventListener(PROPERTY_PIPELINE_EVENT, reload);
    window.addEventListener(WORKSPACE_SELECTION_EVENT, reload);
    return () => {
      window.removeEventListener(PROPERTY_PIPELINE_EVENT, reload);
      window.removeEventListener(WORKSPACE_SELECTION_EVENT, reload);
    };
  }, [demo, managerUserId]);

  const withSaveStatus = useCallback(
    async (run: () => Promise<void>, failure: string) => {
      reportSaveStatus({ type: "start" });
      try {
        await run();
        reportSaveStatus({ type: "success" });
      } catch (e) {
        const message = e instanceof Error ? e.message : failure;
        showToast(message);
        reportSaveStatus({ type: "failure", reason: message });
      }
    },
    [reportSaveStatus, showToast],
  );

  const patchSettings = useCallback(
    async (body: { leasingPipeline?: LeasingPipelinePreferences; automation?: ApplicationAutomationPreferences }) => {
      const res = await fetch("/api/portal/manager-application-settings", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, ...(workspaceId ? { workspaceId } : {}) }),
        keepalive: true,
      });
      const data = (await res.json().catch(() => ({}))) as { leasingPipeline?: unknown; automation?: unknown; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Could not save.");
      return data;
    },
    [workspaceId],
  );

  const savePipeline = (patch: Partial<LeasingPipelinePreferences>) => {
    const previous = pipeline;
    const next = { ...pipeline, ...patch };
    setPipeline(next);
    if (demo) return;
    void withSaveStatus(async () => {
      try {
        const data = await patchSettings({ leasingPipeline: next });
        setPipeline(cacheLeasingPipelinePreferences(data.leasingPipeline ?? next));
      } catch (e) {
        setPipeline(previous);
        throw e;
      }
    }, "Could not save.");
  };

  const saveAutoSend = (autoSendLease: boolean) => {
    const previous = automation;
    const next = { ...automation, autoSendLease };
    setAutomation(next);
    if (demo) return;
    void withSaveStatus(async () => {
      try {
        await patchSettings({ automation: next });
      } catch (e) {
        setAutomation(previous);
        throw e;
      }
    }, "Could not save.");
  };

  const saveDepositDays = (depositAccountingDays: LeaseAutomationSettings["depositAccountingDays"]) => {
    const previous = leaseAutomation;
    setLeaseAutomation({ depositAccountingDays });
    if (demo) return;
    void withSaveStatus(async () => {
      try {
        const res = await fetch("/api/portal/lease-automation-settings", {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ depositAccountingDays }),
          keepalive: true,
        });
        const data = (await res.json().catch(() => ({}))) as { settings?: unknown; error?: string };
        if (!res.ok) throw new Error(data.error ?? "Could not save.");
        setLeaseAutomation(normalizeLeaseAutomationSettings(data.settings));
      } catch (e) {
        setLeaseAutomation(previous);
        throw e;
      }
    }, "Could not save.");
  };

  /** Write one property's templates through its listing record; the arrays are the whole truth for that property. */
  const persistTemplates = async (
    entry: PropertyEntry,
    applications: PropertyApplicationTemplate[],
    leases: PropertyLeaseTemplate[],
  ): Promise<boolean> => {
    if (!managerUserId) return false;
    const next = normalizeManagerListingSubmissionV1(
      withPropertyApplicationTemplatesExplicit(syncLegacyLeaseFieldsFromTemplates(entry.sub, leases), applications),
    );
    const ok = await persistManagerListingSubmissionOnServer(entry.saveTarget, managerUserId, next);
    if (!ok) return false;
    setProperties((rows) =>
      rows.map((row) =>
        row.id === entry.id
          ? {
              ...row,
              sub: next,
              applications: readPropertyApplicationTemplates(next),
              leases: readPropertyLeaseTemplates(next),
            }
          : row,
      ),
    );
    return true;
  };

  const changeMapping = (entry: PropertyEntry, dependentId: string, target: string) => {
    const result = setMappingTarget(
      pipeline.pipelineOrder,
      { applications: entry.applications, leases: entry.leases },
      dependentId,
      target === NONE ? null : target,
    );
    if (!result.ok) {
      showToast(result.error);
      return;
    }
    void withSaveStatus(async () => {
      if (!(await persistTemplates(entry, result.applications, result.leases))) throw new Error("Could not save.");
    }, "Could not save.");
  };

  const changeCosignerForm = (entry: PropertyEntry, applicationId: string, target: string) => {
    const applications = updatePropertyApplicationTemplate(entry.applications, applicationId, {
      linkedCosignerApplicationTemplateId: target === NONE ? null : target,
    });
    void withSaveStatus(async () => {
      if (!(await persistTemplates(entry, applications, entry.leases))) throw new Error("Could not save.");
    }, "Could not save.");
  };

  const changeAddendum = (entry: PropertyEntry, leaseId: string, target: string) => {
    const leases = updatePropertyLeaseTemplate(entry.leases, leaseId, {
      linkedGuarantorLeaseTemplateId: target === NONE ? null : target,
    });
    void withSaveStatus(async () => {
      if (!(await persistTemplates(entry, entry.applications, leases))) throw new Error("Could not save.");
    }, "Could not save.");
  };

  const multiProperty = properties.length > 1;
  const rowLabel = (entry: PropertyEntry, label: string) => (multiProperty ? `${entry.label} · ${label}` : label);
  const leaseFirst = pipeline.pipelineOrder === "lease_then_application";
  const disabled = !loaded;

  const mappingGroups = useMemo(
    () =>
      properties.map((entry) => ({
        entry,
        rows: mappingRows(pipeline.pipelineOrder, { applications: entry.applications, leases: entry.leases }),
      })),
    [properties, pipeline.pipelineOrder],
  );

  const mappingTitle = leaseFirst ? "Application for each lease" : "Lease for each application";
  const mappingRowsTotal = mappingGroups.reduce((n, group) => n + group.rows.length, 0);

  const cosignerGroups = properties
    .map((entry) => ({
      entry,
      applications: entry.applications.filter((application) => !isCosignerApplicationTemplate(application)),
      cosignerForms: entry.applications.filter((application) => isCosignerApplicationTemplate(application)),
      leases: entry.leases.filter((lease) => !isAddendumLeaseTemplate(lease)),
      addenda: entry.leases,
    }))
    .filter((group) => group.applications.length > 0 || group.leases.length > 0);

  return (
    <div className="space-y-6" data-attr="workspace-applications-leases-settings">
      <PortalSettingsSection title="Applications & leases">
        <PortalSettingsGroup>
          <PortalSettingsRow label="Signing order">
            <FieldSingleSelect
              hideLabel
              label="Signing order"
              variant="cell"
              wrapperClassName="w-64"
              options={SIGNING_ORDER_OPTIONS}
              value={pipeline.pipelineOrder}
              disabled={disabled}
              dataAttr="workspace-signing-order"
              onChange={(next) => savePipeline({ pipelineOrder: next as PipelineOrder })}
            />
          </PortalSettingsRow>
          <PortalSettingsRow label="Roommates in a shared room sign">
            <FieldSingleSelect
              hideLabel
              label="Roommates in a shared room sign"
              variant="cell"
              wrapperClassName="w-64"
              options={SHARED_ROOM_OPTIONS}
              value={pipeline.sharedRoomLease}
              disabled={disabled}
              dataAttr="workspace-shared-room-lease"
              onChange={(next) => savePipeline({ sharedRoomLease: next as SharedRoomLeaseDefault })}
            />
          </PortalSettingsRow>
          <PortalSettingsRow label="Deposit accounting">
            <FieldSingleSelect
              hideLabel
              label="Deposit accounting"
              variant="cell"
              wrapperClassName="w-64"
              options={DEPOSIT_ACCOUNTING_OPTIONS.map((option) => ({ value: String(option.value), label: option.label }))}
              value={String(leaseAutomation.depositAccountingDays)}
              disabled={disabled}
              dataAttr="workspace-deposit-accounting"
              onChange={(next) => saveDepositDays(Number(next) as LeaseAutomationSettings["depositAccountingDays"])}
            />
          </PortalSettingsRow>
          <PortalSettingsRow label="Auto-send the lease to the resident">
            <FieldSingleSelect
              hideLabel
              label="Auto-send the lease to the resident"
              variant="cell"
              wrapperClassName="w-64"
              options={[
                { value: "off", label: "Off" },
                { value: "on", label: "On" },
              ]}
              value={automation.autoSendLease ? "on" : "off"}
              disabled={disabled}
              dataAttr="workspace-auto-send-lease"
              onChange={(next) => saveAutoSend(next === "on")}
            />
          </PortalSettingsRow>
        </PortalSettingsGroup>
      </PortalSettingsSection>

      {mappingRowsTotal > 0 ? (
        <PortalSettingsSection title={mappingTitle}>
          <PortalSettingsGroup>
            {mappingGroups.flatMap(({ entry, rows }) =>
              rows.map((row) => (
                <PortalSettingsRow key={`${entry.id}:${row.dependentId}`} label={rowLabel(entry, row.dependentLabel)}>
                  <FieldSingleSelect
                    hideLabel
                    label={leaseFirst ? `Application for ${row.dependentLabel}` : `Lease for ${row.dependentLabel}`}
                    variant="cell"
                    wrapperClassName="w-64"
                    options={[{ value: NONE, label: "Not mapped" }, ...row.targetOptions]}
                    value={row.targetId ?? NONE}
                    disabled={disabled}
                    dataAttr={leaseFirst ? "workspace-lease-application" : "workspace-application-lease"}
                    onChange={(next) => changeMapping(entry, row.dependentId, next)}
                  />
                </PortalSettingsRow>
              )),
            )}
          </PortalSettingsGroup>
        </PortalSettingsSection>
      ) : null}

      {cosignerGroups.length > 0 ? (
        <PortalSettingsSection title="Co-signers">
          <PortalSettingsGroup>
            {cosignerGroups.flatMap(({ entry, applications, cosignerForms, leases, addenda }) => [
              ...applications.map((application) => (
                <PortalSettingsRow key={`${entry.id}:co:${application.id}`} label={rowLabel(entry, `${application.label} co-signer`)}>
                  <FieldSingleSelect
                    hideLabel
                    label={`Co-signer form for ${application.label}`}
                    variant="cell"
                    wrapperClassName="w-64"
                    options={[
                      { value: NONE, label: "Property default" },
                      ...cosignerForms.map((form) => ({ value: form.id, label: form.label })),
                    ]}
                    value={application.linkedCosignerApplicationTemplateId ?? NONE}
                    disabled={disabled}
                    dataAttr="workspace-cosigner-form"
                    onChange={(next) => changeCosignerForm(entry, application.id, next)}
                  />
                </PortalSettingsRow>
              )),
              ...leases.map((lease) => (
                <PortalSettingsRow key={`${entry.id}:ad:${lease.id}`} label={rowLabel(entry, `${lease.label} co-signer / guarantor addendum`)}>
                  <FieldSingleSelect
                    hideLabel
                    label={`Co-signer / guarantor addendum for ${lease.label}`}
                    variant="cell"
                    wrapperClassName="w-64"
                    options={[
                      { value: NONE, label: "None" },
                      ...addenda.filter((candidate) => candidate.id !== lease.id).map((candidate) => ({ value: candidate.id, label: candidate.label })),
                    ]}
                    value={lease.linkedGuarantorLeaseTemplateId ?? NONE}
                    disabled={disabled}
                    dataAttr="workspace-cosigner-addendum"
                    onChange={(next) => changeAddendum(entry, lease.id, next)}
                  />
                </PortalSettingsRow>
              )),
            ])}
          </PortalSettingsGroup>
        </PortalSettingsSection>
      ) : null}
    </div>
  );
}
