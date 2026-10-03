"use client";

import { useEffect, useState } from "react";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { SegmentedControl, ToggleRow } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import { PortalSettingsGroup, PortalSettingsRow, PortalSettingsToggle } from "@/components/portal/portal-settings-ui";
import { usePropertyFormSetupSettings } from "@/lib/property-form-setup-settings.client";
import { updatePropertyLeaseTemplate, type PropertyLeaseTemplate } from "@/lib/property-lease-templates";

export function PropertyLeaseCatalogSettingsModal({
  open,
  onClose,
  templates,
  propertyId,
  onSaveTemplates,
}: {
  open: boolean;
  onClose: () => void;
  templates: PropertyLeaseTemplate[];
  propertyId: string | null;
  onSaveTemplates: (next: PropertyLeaseTemplate[]) => Promise<boolean>;
}) {
  const formSetup = usePropertyFormSetupSettings(propertyId, { enabled: open && Boolean(propertyId) });
  const [localTemplates, setLocalTemplates] = useState(templates);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) setLocalTemplates(templates);
  }, [open, templates]);

  const patchOffered = (id: string, offered: boolean) => {
    setLocalTemplates((rows) => updatePropertyLeaseTemplate(rows, id, { offered }));
  };

  const commit = async () => {
    setSaving(true);
    try {
      const ok = await onSaveTemplates(localTemplates);
      if (ok) onClose();
    } finally {
      setSaving(false);
    }
  };

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
          <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.1em] text-muted">Allowed leases</p>
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
        {formSetup.loaded ? (
          <>
            <section>
              <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.1em] text-muted">Signing</p>
              <PortalSettingsGroup>
                <PortalSettingsRow label="Who signs first">
                  <SegmentedControl
                    ariaLabel="Who signs first"
                    value={formSetup.leasingPipeline.pipelineOrder}
                    dataAttrPrefix="property-lease-settings-pipeline"
                    options={[
                      { value: "application_then_lease", label: "Application" },
                      { value: "lease_then_application", label: "Lease" },
                    ]}
                    onChange={(next) =>
                      void formSetup.patch({
                        leasingPipeline: { ...formSetup.leasingPipeline, pipelineOrder: next },
                      })
                    }
                  />
                </PortalSettingsRow>
              </PortalSettingsGroup>
            </section>
            <section>
              <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.1em] text-muted">Options</p>
              <ToggleRow
                label="Roommates sign"
                checked={formSetup.leasingPipeline.requireLease}
                dataAttr="property-lease-settings-roommates"
                onChange={(next) =>
                  void formSetup.patch({
                    leasingPipeline: { ...formSetup.leasingPipeline, requireLease: next },
                  })
                }
              />
            </section>
          </>
        ) : (
          <p className="text-sm text-muted">Loading…</p>
        )}
      </div>
    </Modal>
  );
}
