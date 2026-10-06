"use client";

import { useEffect, useMemo, useState } from "react";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { PortalSettingsGroup, PortalSettingsRow, PortalSettingsToggle } from "@/components/portal/portal-settings-ui";
import { usePropertyFormSetupSettings } from "@/lib/property-form-setup-settings.client";
import { updatePropertyLeaseTemplate, type PropertyLeaseTemplate } from "@/lib/property-lease-templates";
import { resolveAllowedLeaseTerms, type ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { CUSTOM_LEASE_TERM } from "@/lib/rental-application/lease-terms";

const MONTH_TO_MONTH_TERM = "Month-to-Month";

/**
 * The Lease tab's settings gear. Property-scoped switches only (C2-CP8): which leases this
 * property offers, month-to-month, custom start dates, the property's default lease and whether a
 * lease is required. Workspace-wide choices (signing order, co-signer, deposit accounting, ...)
 * live in Settings -> Automations.
 */
export function PropertyLeaseCatalogSettingsModal({
  open,
  onClose,
  templates,
  propertyId,
  onSaveTemplates,
  sub,
}: {
  open: boolean;
  onClose: () => void;
  templates: PropertyLeaseTemplate[];
  propertyId: string | null;
  /** `extra` carries the term switches into the SAME write, so one save can never undo the other. */
  onSaveTemplates: (
    next: PropertyLeaseTemplate[],
    extra?: Partial<Pick<ManagerListingSubmissionV1, "allowedLeaseTerms">>,
  ) => Promise<boolean>;
  /** This property's listing record, for the term switches. Omitted in a bulk edit, where they would be ambiguous. */
  sub?: ManagerListingSubmissionV1;
}) {
  const formSetup = usePropertyFormSetupSettings(propertyId, { enabled: open && Boolean(propertyId) });
  const [localTemplates, setLocalTemplates] = useState(templates);
  const [saving, setSaving] = useState(false);

  const savedTerms = useMemo(() => (sub ? resolveAllowedLeaseTerms(sub) : []), [sub]);
  const [allowM2m, setAllowM2m] = useState(false);
  const [allowCustomStart, setAllowCustomStart] = useState(false);
  const termsEditable = Boolean(sub);

  useEffect(() => {
    if (!open) return;
    setLocalTemplates(templates);
    setAllowM2m(savedTerms.includes(MONTH_TO_MONTH_TERM));
    setAllowCustomStart(savedTerms.includes(CUSTOM_LEASE_TERM));
  }, [open, templates, savedTerms]);

  const patchOffered = (id: string, offered: boolean) => {
    setLocalTemplates((rows) => updatePropertyLeaseTemplate(rows, id, { offered }));
  };

  const commit = async () => {
    setSaving(true);
    try {
      let extra: Partial<Pick<ManagerListingSubmissionV1, "allowedLeaseTerms">> | undefined;
      if (termsEditable) {
        const changed =
          allowM2m !== savedTerms.includes(MONTH_TO_MONTH_TERM) ||
          allowCustomStart !== savedTerms.includes(CUSTOM_LEASE_TERM);
        if (changed) {
          extra = {
            allowedLeaseTerms: [
              ...savedTerms.filter((term) => term !== MONTH_TO_MONTH_TERM && term !== CUSTOM_LEASE_TERM),
              ...(allowM2m ? [MONTH_TO_MONTH_TERM] : []),
              ...(allowCustomStart ? [CUSTOM_LEASE_TERM] : []),
            ],
          };
        }
      }
      if (await onSaveTemplates(localTemplates, extra)) onClose();
    } finally {
      setSaving(false);
    }
  };

  const defaultLeaseId = formSetup.leasingPipeline.defaultLeaseTemplateId ?? "__none__";

  return (
    <Modal
      open={open}
      title="Lease settings"
      onClose={onClose}
      presentation="dialog"
      dense
      panelClassName="max-w-lg"
      footer={
        <ModalFooter>
          <Button type="button" variant="outline" className="rounded-full" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" variant="primary" className="rounded-full" disabled={saving} onClick={() => void commit()}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </ModalFooter>
      }
    >
      <div className="space-y-6" data-attr="property-lease-catalog-settings">
        <section>
          <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.1em] text-muted">Offered at this property</p>
          <PortalSettingsGroup>
            {localTemplates.map((lease) => (
              <PortalSettingsRow key={lease.id} label={lease.label}>
                <PortalSettingsToggle
                  checked={lease.offered !== false}
                  onChange={(next) => patchOffered(lease.id, next)}
                  label={`Offer ${lease.label}`}
                  dataAttr={`property-lease-offered-${lease.id}`}
                />
              </PortalSettingsRow>
            ))}
          </PortalSettingsGroup>
        </section>
        {termsEditable ? (
          <section>
            <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.1em] text-muted">Terms</p>
            <PortalSettingsGroup>
              <PortalSettingsRow label="Allow month-to-month">
                <PortalSettingsToggle
                  checked={allowM2m}
                  onChange={setAllowM2m}
                  label="Allow month-to-month"
                  dataAttr="property-lease-settings-month-to-month"
                />
              </PortalSettingsRow>
              <PortalSettingsRow label="Allow custom start dates">
                <PortalSettingsToggle
                  checked={allowCustomStart}
                  onChange={setAllowCustomStart}
                  label="Allow custom start dates"
                  dataAttr="property-lease-settings-custom-start"
                />
              </PortalSettingsRow>
            </PortalSettingsGroup>
          </section>
        ) : null}
        {formSetup.loaded ? (
          <section>
            <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.1em] text-muted">Review</p>
            <PortalSettingsGroup>
              <PortalSettingsRow label="Default lease for the property">
                <FieldSingleSelect
                  hideLabel
                  label="Default lease for the property"
                  variant="cell"
                  wrapperClassName="w-52"
                  value={defaultLeaseId}
                  dataAttr="property-lease-settings-default"
                  options={[
                    { value: "__none__", label: "None" },
                    ...localTemplates.map((lease) => ({ value: lease.id, label: lease.label })),
                  ]}
                  onChange={(next) =>
                    void formSetup.patch({
                      leasingPipeline: {
                        ...formSetup.leasingPipeline,
                        defaultLeaseTemplateId: next === "__none__" ? null : next,
                      },
                    })
                  }
                />
              </PortalSettingsRow>
              <PortalSettingsRow label="Lease required">
                <PortalSettingsToggle
                  checked={formSetup.leasingPipeline.requireLease}
                  onChange={(next) =>
                    void formSetup.patch({
                      leasingPipeline: { ...formSetup.leasingPipeline, requireLease: next },
                    })
                  }
                  label="Lease required"
                  dataAttr="property-lease-settings-require-lease"
                />
              </PortalSettingsRow>
            </PortalSettingsGroup>
          </section>
        ) : (
          <p className="text-sm text-muted">Loading…</p>
        )}
      </div>
    </Modal>
  );
}
