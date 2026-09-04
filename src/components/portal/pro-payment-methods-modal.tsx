"use client";

import { useEffect, useMemo, useState } from "react";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { useAppUi } from "@/components/providers/app-ui-provider";
import {
  normalizeManagerListingSubmissionV1,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import {
  acceptedPaymentMethodsForListing,
  RESIDENT_ACCEPTED_PAYMENT_METHODS,
  RESIDENT_ACCEPTED_PAYMENT_METHOD_LABELS,
  type ResidentAcceptedPaymentMethod,
} from "@/lib/payment-policy";
import {
  PROPERTY_PIPELINE_EVENT,
  readExtraListingsForUser,
  syncPropertyPipelineFromServer,
  updateExtraListingFromSubmissionOnServer,
} from "@/lib/demo-property-pipeline";
import {
  collectLinkedPropertyIdsForModule,
  readLinkedListingsForUser,
} from "@/lib/manager-portfolio-access";

/** Property name only — strips " · 9 rooms", unit labels, and legacy id suffixes. */
function displayPropertyLabel(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  return trimmed
    .split(" · ")[0]!
    .replace(/\s*·\s*[^·]*::[^·]*$/i, "")
    .replace(/\s+[.-]\s+[^\s]+::[^\s]+$/i, "")
    .trim();
}

type PropertyOption = { propertyId: string; propertyLabel: string; submission: ManagerListingSubmissionV1 | null };

function buildPropertyOptions(managerUserId: string | null): PropertyOption[] {
  if (!managerUserId) return [];
  const seen = new Map<string, PropertyOption>();
  for (const property of readExtraListingsForUser(managerUserId)) {
    const propertyId = property.id.trim();
    if (!propertyId || seen.has(propertyId)) continue;
    const propertyLabel = displayPropertyLabel(property.buildingName.trim() || property.title);
    if (!propertyLabel) continue;
    seen.set(propertyId, {
      propertyId,
      propertyLabel,
      submission: property.listingSubmission?.v === 1 ? property.listingSubmission : null,
    });
  }
  // A co-manager's linked listings live in the OWNER's bucket, so the loop above
  // sees none of them (AXI-156). This picker needs the RECORD, not just a label,
  // because each option carries the listing submission its payment settings are
  // read from — hence `readLinkedListingsForUser` rather than a label lookup.
  const linkedForPayments = collectLinkedPropertyIdsForModule(managerUserId, "payments");
  if (linkedForPayments.size > 0) {
    for (const { listing } of readLinkedListingsForUser(managerUserId)) {
      const propertyId = listing.id.trim();
      if (!propertyId || seen.has(propertyId) || !linkedForPayments.has(propertyId)) continue;
      const propertyLabel = displayPropertyLabel(listing.buildingName.trim() || listing.title);
      if (!propertyLabel) continue;
      seen.set(propertyId, {
        propertyId,
        propertyLabel,
        submission: listing.listingSubmission?.v === 1 ? listing.listingSubmission : null,
      });
    }
  }

  return [...seen.values()].sort((a, b) =>
    a.propertyLabel.localeCompare(b.propertyLabel, undefined, { sensitivity: "base" }),
  );
}

export function ManagerPaymentMethodsModal({
  open,
  onClose,
  managerUserId,
}: {
  open: boolean;
  onClose: () => void;
  managerUserId: string | null;
}) {
  const { showToast } = useAppUi();
  const [propertyTick, setPropertyTick] = useState(0);
  const [propertyId, setPropertyId] = useState("");
  const [selectedMethods, setSelectedMethods] = useState<Set<ResidentAcceptedPaymentMethod>>(
    () => new Set(RESIDENT_ACCEPTED_PAYMENT_METHODS),
  );
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onProperties = () => setPropertyTick((n) => n + 1);
    void syncPropertyPipelineFromServer({ force: true }).then(onProperties);
    window.addEventListener(PROPERTY_PIPELINE_EVENT, onProperties);
    return () => window.removeEventListener(PROPERTY_PIPELINE_EVENT, onProperties);
  }, [open]);

  const propertyOptions = useMemo(() => {
    void propertyTick;
    return buildPropertyOptions(managerUserId);
  }, [managerUserId, propertyTick]);

  const selectedProperty = useMemo(
    () => propertyOptions.find((row) => row.propertyId === propertyId) ?? null,
    [propertyId, propertyOptions],
  );

  useEffect(() => {
    if (!open) return;
    if (!propertyId && propertyOptions[0]) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- default to the first property once options load
      setPropertyId(propertyOptions[0].propertyId);
      return;
    }
    setSelectedMethods(new Set(acceptedPaymentMethodsForListing(selectedProperty?.submission)));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-derive only when the target property changes
  }, [open, propertyId, propertyOptions]);

  const toggleMethod = (method: ResidentAcceptedPaymentMethod) => {
    setSelectedMethods((prev) => {
      const next = new Set(prev);
      if (next.has(method)) next.delete(method);
      else next.add(method);
      return next;
    });
  };

  const handleClose = () => {
    setPropertyId("");
    onClose();
  };

  async function save() {
    if (!managerUserId || !selectedProperty) {
      showToast("Select a property first.");
      return;
    }
    if (!selectedProperty.submission) {
      showToast("Could not find this property's payment settings.");
      return;
    }
    if (selectedMethods.size === 0) {
      showToast("Select at least one payment method.");
      return;
    }
    setSaving(true);
    const nextSubmission = {
      ...normalizeManagerListingSubmissionV1(selectedProperty.submission),
      acceptedPaymentMethods: [...selectedMethods],
    };
    const ok = await updateExtraListingFromSubmissionOnServer(selectedProperty.propertyId, managerUserId, nextSubmission);
    setSaving(false);
    if (!ok) {
      showToast("Could not save payment methods. Try again.");
      return;
    }
    showToast("Accepted payment methods saved.");
    handleClose();
  }

  const noProperties = propertyOptions.length === 0;

  return (
    <Modal
      open={open}
      title="Set payment methods"
      onClose={handleClose}
      footer={
        <ModalFooter>
          <Button
            type="button"
            variant="primary"
            className="rounded-full"
            onClick={() => save()}
            disabled={saving || !propertyId}
            data-attr="manager-payment-methods-save"
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </ModalFooter>
      }
    >
      <div className="space-y-4 text-sm">
        <p className="text-muted">Choose which payment methods residents can select for this property.</p>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-muted">Property</span>
          <Select
            value={propertyId}
            onChange={(e) => setPropertyId(e.target.value)}
            disabled={noProperties}
            data-attr="manager-payment-methods-property-select"
          >
            <option value="">{noProperties ? "No properties in portfolio" : "Select property"}</option>
            {propertyOptions.map((option) => (
              <option key={option.propertyId} value={option.propertyId}>
                {option.propertyLabel}
              </option>
            ))}
          </Select>
        </label>
        <div className="space-y-2 rounded-xl border border-border bg-card p-4">
          {RESIDENT_ACCEPTED_PAYMENT_METHODS.map((method) => (
            <label key={method} className="flex cursor-pointer items-center gap-3">
              <input
                type="checkbox"
                className="h-4 w-4 shrink-0 rounded border-border"
                checked={selectedMethods.has(method)}
                onChange={() => toggleMethod(method)}
                disabled={!propertyId}
                data-attr={`manager-accepted-payment-method-${method}`}
              />
              <span className="text-sm font-medium text-foreground">{RESIDENT_ACCEPTED_PAYMENT_METHOD_LABELS[method]}</span>
            </label>
          ))}
        </div>
      </div>
    </Modal>
  );
}
