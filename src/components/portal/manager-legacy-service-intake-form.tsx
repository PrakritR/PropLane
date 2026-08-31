"use client";

import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import { Input, Select } from "@/components/ui/input";
import { useAppUi } from "@/components/providers/app-ui-provider";
import {
  MANAGER_APPLICATIONS_EVENT,
  readManagerApplicationRows,
  syncManagerApplicationsFromServer,
} from "@/lib/manager-applications-storage";
import { applicationVisibleToPortalUser } from "@/lib/manager-portfolio-access";
import { getRoomChoiceLabel, getPropertyById } from "@/lib/rental-application/data";
import {
  PROPERTY_PIPELINE_EVENT,
  readExtraListingsForUser,
  readPendingManagerPropertiesForUser,
  syncPropertyPipelineFromServer,
} from "@/lib/demo-property-pipeline";
import {
  normalizeManagerListingSubmissionV1,
  resolveServiceOfferPricing,
  type ManagerListingServiceOption,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import { resolvePropertySaveTargetById } from "@/lib/manager-property-save-target";
import { createServiceRequest, CUSTOM_SERVICE_REQUEST_OFFER_ID } from "@/lib/service-requests-storage";
import { ServiceRequestCatalogModal } from "@/components/portal/service-request-catalog-modal";
import { WorkAssignmentPicker } from "@/components/portal/work-assignment-picker";
import { useWorkAssignmentDirectory } from "@/hooks/use-work-assignment-directory";
import {
  createScheduledWorkTask,
  scheduledTaskTitleForService,
} from "@/lib/manager-scheduled-work-tasks";
import type { ManagerComposePrefill } from "@/lib/manager-compose-prefill";
import type { WorkAssignee } from "@/lib/work-assignment";
import {
  isCurrentResidentApplicationRow,
} from "@/lib/current-resident";
import {
  MAINTENANCE_CATEGORY_OPTIONS,
  MAINTENANCE_SERVICE_OFFER_ID,
  isMaintenanceServiceOffer,
  resolveDefaultVendorForMaintenance,
  submitMaintenanceServiceIntake,
} from "@/lib/service-intake";
import { readOwnActiveManagerVendorRows, syncManagerVendorsFromServer, MANAGER_VENDORS_EVENT } from "@/lib/manager-vendors-storage";
import { PORTAL_MODAL_BODY_SCROLL_CLASS } from "@/components/ui/modal-styles";
import type { ResidentMaintenanceCategoryLabel } from "@/lib/work-order-taxonomy";

export type ManagerServiceResidentOption = {
  residentName: string;
  residentEmail: string;
  propertyId: string;
  propertyLabel: string;
  roomLabel: string;
};

type PropertyOption = { propertyId: string; propertyLabel: string };

function displayPropertyLabel(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  return trimmed
    .split(" · ")[0]!
    .replace(/\s*·\s*[^·]*::[^·]*$/i, "")
    .replace(/\s+[.-]\s+[^\s]+::[^\s]+$/i, "")
    .trim();
}

function buildPropertyOptions(managerUserId: string | null): PropertyOption[] {
  if (!managerUserId) return [];
  const seen = new Map<string, PropertyOption>();
  for (const property of readExtraListingsForUser(managerUserId)) {
    const propertyId = property.id.trim();
    if (!propertyId || seen.has(propertyId)) continue;
    const propertyLabel = displayPropertyLabel(property.buildingName.trim() || property.title);
    if (!propertyLabel) continue;
    seen.set(propertyId, { propertyId, propertyLabel });
  }
  for (const property of readPendingManagerPropertiesForUser(managerUserId)) {
    const propertyId = property.id.trim();
    if (!propertyId || seen.has(propertyId)) continue;
    const propertyLabel = displayPropertyLabel(property.buildingName.trim());
    if (!propertyLabel) continue;
    seen.set(propertyId, { propertyId, propertyLabel });
  }
  return [...seen.values()].sort((a, b) =>
    a.propertyLabel.localeCompare(b.propertyLabel, undefined, { sensitivity: "base" }),
  );
}

function buildResidentOptions(managerUserId: string | null): ManagerServiceResidentOption[] {
  return readManagerApplicationRows()
    .filter(
      (row) =>
        isCurrentResidentApplicationRow(row) &&
        applicationVisibleToPortalUser(row, managerUserId) &&
        row.name?.trim() &&
        row.email?.trim().includes("@"),
    )
    .map((row) => {
      const propertyLabel = displayPropertyLabel(row.property?.trim() || "");
      const propertyId =
        row.assignedPropertyId?.trim() ||
        row.propertyId?.trim() ||
        row.application?.propertyId?.trim() ||
        "";
      const roomLabel =
        getRoomChoiceLabel(row.assignedRoomChoice?.trim() || row.application?.roomChoice1?.trim() || "")
          .split(" · ")[0]
          ?.trim() ||
        row.manualResidentDetails?.roomNumber?.trim() ||
        "";
      return {
        residentName: row.name.trim(),
        residentEmail: row.email!.trim().toLowerCase(),
        propertyId,
        propertyLabel: propertyLabel || "Property",
        roomLabel,
      };
    })
    .sort((a, b) => {
      const byProperty = a.propertyLabel.localeCompare(b.propertyLabel, undefined, { sensitivity: "base" });
      if (byProperty !== 0) return byProperty;
      return a.residentName.localeCompare(b.residentName, undefined, { sensitivity: "base" });
    });
}

function residentMatchesProperty(resident: ManagerServiceResidentOption, property: PropertyOption): boolean {
  if (resident.propertyId && resident.propertyId === property.propertyId) return true;
  return resident.propertyLabel.toLowerCase() === property.propertyLabel.toLowerCase();
}

export type ServiceIntakeFooterState = {
  submit: () => void;
  canSubmit: boolean;
  saving: boolean;
  label: string;
};

export function ManagerLegacyServiceIntakeForm({
  open,
  managerUserId,
  defaultPropertyId,
  defaultResident,
  submitLabel = "Add service",
  onComplete,
  onRegisterFooter,
  onCatalogOpenChange,
}: {
  open: boolean;
  managerUserId: string | null;
  defaultPropertyId?: string;
  defaultResident?: ManagerServiceResidentOption | null;
  submitLabel?: string;
  onComplete?: (composePrefill?: ManagerComposePrefill | null) => void;
  onRegisterFooter?: (state: ServiceIntakeFooterState | null) => void;
  onCatalogOpenChange?: (open: boolean) => void;
}) {
  const { showToast } = useAppUi();
  const { teamMembers, vendors } = useWorkAssignmentDirectory({ managerUserId });
  const [tick, setTick] = useState(0);
  const [vendorTick, setVendorTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [assignee, setAssignee] = useState<WorkAssignee | null>(null);
  const [propertyId, setPropertyId] = useState("");
  const [residentEmail, setResidentEmail] = useState("");
  const [offerId, setOfferId] = useState("");
  const [notes, setNotes] = useState("");
  const [customTitle, setCustomTitle] = useState("");
  const [customPriceLimit, setCustomPriceLimit] = useState("");
  const [catalogModalOpen, setCatalogModalOpen] = useState(false);
  const [requestPrice, setRequestPrice] = useState("");
  const [requestDeposit, setRequestDeposit] = useState("");
  const [maintenanceTitle, setMaintenanceTitle] = useState("");
  const [maintenanceCategory, setMaintenanceCategory] = useState<ResidentMaintenanceCategoryLabel>("General");

  useEffect(() => {
    onCatalogOpenChange?.(catalogModalOpen);
  }, [catalogModalOpen, onCatalogOpenChange]);

  useEffect(() => {
    if (!open) return;
    void syncPropertyPipelineFromServer().then(() => setTick((t) => t + 1));
    void syncManagerApplicationsFromServer().then(() => setTick((t) => t + 1));
    void syncManagerVendorsFromServer();
    const onProps = () => setTick((t) => t + 1);
    const onApps = () => setTick((t) => t + 1);
    const onVendors = () => setVendorTick((t) => t + 1);
    window.addEventListener(PROPERTY_PIPELINE_EVENT, onProps);
    window.addEventListener(MANAGER_APPLICATIONS_EVENT, onApps);
    window.addEventListener(MANAGER_VENDORS_EVENT, onVendors);
    return () => {
      window.removeEventListener(PROPERTY_PIPELINE_EVENT, onProps);
      window.removeEventListener(MANAGER_APPLICATIONS_EVENT, onApps);
      window.removeEventListener(MANAGER_VENDORS_EVENT, onVendors);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    queueMicrotask(() => {
      if (defaultResident) {
        setPropertyId(defaultResident.propertyId.trim());
        setResidentEmail(defaultResident.residentEmail.trim().toLowerCase());
      } else {
        setPropertyId(defaultPropertyId?.trim() || "");
        setResidentEmail("");
      }
      setOfferId("");
      setNotes("");
      setCustomTitle("");
      setCustomPriceLimit("");
      setCatalogModalOpen(false);
      setRequestPrice("");
      setRequestDeposit("");
      setMaintenanceTitle("");
      setMaintenanceCategory("General");
      setAssignee(null);
    });
  }, [open, defaultPropertyId, defaultResident]);

  const propertyOptions = useMemo(() => {
    void tick;
    return buildPropertyOptions(managerUserId);
  }, [managerUserId, tick]);

  const residentOptions = useMemo(() => {
    void tick;
    return buildResidentOptions(managerUserId);
  }, [managerUserId, tick]);

  const activeVendors = useMemo(() => {
    void vendorTick;
    return readOwnActiveManagerVendorRows(managerUserId);
  }, [managerUserId, vendorTick]);

  const lockedResident = defaultResident ?? null;

  const effectiveResident = useMemo(() => {
    if (lockedResident) return lockedResident;
    return residentOptions.find((r) => r.residentEmail === residentEmail) ?? null;
  }, [lockedResident, residentEmail, residentOptions]);

  const effectiveProperty = useMemo(() => {
    if (lockedResident?.propertyId) {
      return (
        propertyOptions.find((p) => p.propertyId === lockedResident.propertyId) ?? {
          propertyId: lockedResident.propertyId,
          propertyLabel: lockedResident.propertyLabel,
        }
      );
    }
    return propertyOptions.find((p) => p.propertyId === propertyId) ?? null;
  }, [lockedResident, propertyId, propertyOptions]);

  const residentsForProperty = useMemo(() => {
    const property = propertyOptions.find((p) => p.propertyId === propertyId);
    if (!property) return residentOptions;
    return residentOptions.filter((r) => residentMatchesProperty(r, property));
  }, [propertyId, propertyOptions, residentOptions]);

  const selectedResident = effectiveResident;
  const selectedProperty = effectiveProperty;

  const propertySubmission = useMemo<ManagerListingSubmissionV1 | null>(() => {
    void tick;
    if (!propertyId) return null;
    const property = getPropertyById(propertyId);
    if (!property?.listingSubmission || property.listingSubmission.v !== 1) return null;
    return normalizeManagerListingSubmissionV1(property.listingSubmission);
  }, [propertyId, tick]);

  const offersForProperty = useMemo<ManagerListingServiceOption[]>(() => {
    const options = propertySubmission?.serviceRequestOptions ?? [];
    return options.filter((o) => {
      if (!o.available) return false;
      if (!o.residentEmails?.length) return true;
      if (!residentEmail) return true;
      return o.residentEmails.some((e) => e.trim().toLowerCase() === residentEmail);
    });
  }, [propertySubmission, residentEmail]);

  const selectedOffer = useMemo(
    () => offersForProperty.find((o) => o.id === offerId) ?? null,
    [offerId, offersForProperty],
  );

  useEffect(() => {
    if (!selectedOffer) {
      setRequestPrice("");
      setRequestDeposit("");
      return;
    }
    const defaults = resolveServiceOfferPricing(selectedOffer);
    setRequestPrice(defaults.price);
    setRequestDeposit(defaults.deposit);
  }, [selectedOffer]);

  const propertySaveTarget = useMemo(
    () => resolvePropertySaveTargetById(managerUserId, propertyId),
    [managerUserId, propertyId],
  );

  const isCustomOffer = offerId === CUSTOM_SERVICE_REQUEST_OFFER_ID;
  const isMaintenanceOffer = isMaintenanceServiceOffer(offerId);

  useEffect(() => {
    if (!isMaintenanceOffer || !managerUserId) return;
    const vendor = resolveDefaultVendorForMaintenance(
      managerUserId,
      maintenanceCategory,
      activeVendors,
    );
    if (vendor) {
      setAssignee({ type: "vendor", id: vendor.id, name: vendor.name });
    }
  }, [activeVendors, isMaintenanceOffer, maintenanceCategory, managerUserId]);

  const canSubmit = useMemo(() => {
    if (!propertyId || !residentEmail) return false;
    if (!offerId) return false;
    if (isCustomOffer) return Boolean(customTitle.trim());
    if (isMaintenanceOffer) return Boolean(maintenanceTitle.trim());
    return Boolean(selectedOffer);
  }, [
    customTitle,
    isCustomOffer,
    isMaintenanceOffer,
    maintenanceTitle,
    offerId,
    propertyId,
    residentEmail,
    selectedOffer,
  ]);

  const submit = useCallback(async () => {
    if (busy) return;
    if (!managerUserId) {
      showToast("Could not identify your manager account.");
      return;
    }
    if (!propertyId || !selectedProperty) {
      showToast("Choose a property.");
      return;
    }
    if (!residentEmail || !selectedResident) {
      showToast("Choose a resident.");
      return;
    }
    if (!offerId) {
      showToast("Choose a service type.");
      return;
    }

    setBusy(true);
    try {
      if (isMaintenanceOffer) {
        if (!maintenanceTitle.trim()) {
          showToast("Add a title for the maintenance request.");
          return;
        }
        const result = await submitMaintenanceServiceIntake({
          managerUserId,
          propertyId,
          propertyLabel: selectedProperty.propertyLabel,
          resident: selectedResident,
          title: maintenanceTitle.trim(),
          notes: notes.trim(),
          category: maintenanceCategory,
          assignee,
          vendors: activeVendors,
          roomLabel: selectedResident.roomLabel || undefined,
        });
        showToast(
          result.vendorName
            ? `Maintenance request created. ${result.vendorName} notified.`
            : "Maintenance request created.",
        );
        if (result.vendorNotifyError) {
          showToast("Request saved, but the vendor could not be notified.");
        }
        onComplete?.(result.composePrefill);
        return;
      }

      if (isCustomOffer) {
        if (!customTitle.trim()) {
          showToast("Add a title for the custom request.");
          return;
        }
        const limitRaw = customPriceLimit.trim();
        const { mirrored } = await createServiceRequest({
          offerId: CUSTOM_SERVICE_REQUEST_OFFER_ID,
          offerName: customTitle.trim(),
          offerDescription: notes.trim(),
          price: "",
          priceLimit: limitRaw || undefined,
          deposit: "",
          residentEmail: selectedResident.residentEmail,
          residentName: selectedResident.residentName,
          managerUserId,
          propertyId,
          returnByDate: "",
          notes: notes.trim(),
          assignee: assignee ?? undefined,
        });
        if (!mirrored.ok) {
          showToast(mirrored.error || "Could not save request. Try again.");
          return;
        }
        void createScheduledWorkTask(managerUserId, {
          title: scheduledTaskTitleForService(customTitle.trim(), selectedResident.residentName),
          propertyId,
          propertyTitle: selectedResident.propertyLabel,
          assignee: assignee ?? undefined,
          notes: notes.trim() || undefined,
          taskType: "work_order",
        });
        showToast(`${customTitle.trim()} request created for ${selectedResident.residentName}.`);
        onComplete?.(null);
        return;
      }

      if (!selectedOffer) {
        showToast("Choose a service type.");
        return;
      }
      const { mirrored } = await createServiceRequest({
        offerId: selectedOffer.id,
        offerName: selectedOffer.name,
        offerDescription: selectedOffer.description,
        price: requestPrice.trim(),
        deposit: requestDeposit.trim(),
        residentEmail: selectedResident.residentEmail,
        residentName: selectedResident.residentName,
        managerUserId,
        propertyId,
        returnByDate: "",
        notes: notes.trim(),
        assignee: assignee ?? undefined,
      });
      if (!mirrored.ok) {
        showToast(mirrored.error || "Could not save request. Try again.");
        return;
      }
      void createScheduledWorkTask(managerUserId, {
        title: scheduledTaskTitleForService(selectedOffer.name, selectedResident.residentName),
        propertyId,
        propertyTitle: selectedResident.propertyLabel,
        assignee: assignee ?? undefined,
        notes: notes.trim() || undefined,
        taskType: "work_order",
      });
      showToast(`${selectedOffer.name} request created for ${selectedResident.residentName}.`);
      onComplete?.(null);
    } finally {
      setBusy(false);
    }
  }, [
    activeVendors,
    assignee,
    busy,
    customPriceLimit,
    customTitle,
    isCustomOffer,
    isMaintenanceOffer,
    maintenanceCategory,
    maintenanceTitle,
    managerUserId,
    notes,
    offerId,
    onComplete,
    propertyId,
    requestDeposit,
    requestPrice,
    residentEmail,
    selectedOffer,
    selectedProperty,
    selectedResident,
    showToast,
  ]);

  // Always call the LATEST submit without making it a dependency. `submit` is a
  // useCallback over derived lookups (selectedOffer/-Property/-Resident), so its
  // identity changes on most renders; depending on it here re-ran this effect
  // every render, and the effect sets PARENT state — "Maximum update depth
  // exceeded" as soon as the modal opened on the service path.
  const submitRef = useRef(submit);
  useEffect(() => {
    submitRef.current = submit;
  }, [submit]);

  // Re-register only when the footer's VALUE changes. Sending a fresh object
  // every render is what fed the loop, since each one is a new parent state.
  const registeredFooterRef = useRef<{ canSubmit: boolean; saving: boolean; label: string } | null>(null);
  useEffect(() => {
    if (!open) {
      if (registeredFooterRef.current !== null) {
        registeredFooterRef.current = null;
        onRegisterFooter?.(null);
      }
      return;
    }
    const prev = registeredFooterRef.current;
    if (prev && prev.canSubmit === canSubmit && prev.saving === busy && prev.label === submitLabel) return;
    registeredFooterRef.current = { canSubmit, saving: busy, label: submitLabel };
    onRegisterFooter?.({
      submit: () => void submitRef.current(),
      canSubmit,
      saving: busy,
      label: submitLabel,
    });
  }, [busy, canSubmit, onRegisterFooter, open, submitLabel]);

  const onCatalogSaved = (nextOfferId?: string) => {
    setTick((t) => t + 1);
    if (nextOfferId) setOfferId(nextOfferId);
  };

  return (
    <>
      <div className={PORTAL_MODAL_BODY_SCROLL_CLASS}>
        <div className="space-y-4">
          {lockedResident ? (
            <div className="rounded-xl border border-border bg-accent/20 px-3 py-2.5 text-sm">
              <p className="font-semibold text-foreground">
                {lockedResident.residentName}
                {lockedResident.roomLabel ? ` · ${lockedResident.roomLabel}` : ""}
              </p>
              <p className="mt-0.5 text-xs text-muted">{lockedResident.propertyLabel}</p>
            </div>
          ) : (
            <>
              <label className="flex flex-col gap-1 text-xs font-medium text-muted">
                Property *
                <Select
                  value={propertyId}
                  onChange={(e) => {
                    setPropertyId(e.target.value);
                    setResidentEmail("");
                    setOfferId("");
                    setCatalogModalOpen(false);
                  }}
                  disabled={busy}
                >
                  <option value="">Select property</option>
                  {propertyOptions.map((p) => (
                    <option key={p.propertyId} value={p.propertyId}>
                      {p.propertyLabel}
                    </option>
                  ))}
                </Select>
              </label>

              <label className="flex flex-col gap-1 text-xs font-medium text-muted">
                Resident *
                <Select
                  value={residentEmail}
                  onChange={(e) => {
                    setResidentEmail(e.target.value);
                    setOfferId("");
                  }}
                  disabled={busy || !propertyId}
                >
                  <option value="">{propertyId ? "Select resident" : "Choose a property first"}</option>
                  {residentsForProperty.map((r) => (
                    <option key={r.residentEmail} value={r.residentEmail}>
                      {r.residentName}
                      {r.roomLabel ? ` · ${r.roomLabel}` : ""}
                    </option>
                  ))}
                </Select>
              </label>
            </>
          )}

          <label className="flex flex-col gap-1 text-xs font-medium text-muted">
            Service type *
            <Select
              value={offerId}
              onChange={(e) => {
                setOfferId(e.target.value);
                if (e.target.value !== CUSTOM_SERVICE_REQUEST_OFFER_ID) {
                  setCustomTitle("");
                  setCustomPriceLimit("");
                }
                if (!isMaintenanceServiceOffer(e.target.value)) {
                  setMaintenanceTitle("");
                  setMaintenanceCategory("General");
                }
              }}
              disabled={busy || !propertyId}
            >
              <option value="">
                {!propertyId ? "Choose a property first" : "Select a service type"}
              </option>
              <option value={MAINTENANCE_SERVICE_OFFER_ID}>Maintenance</option>
              {offersForProperty.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                  {o.price ? ` · ${o.price}` : ""}
                </option>
              ))}
              <option value={CUSTOM_SERVICE_REQUEST_OFFER_ID}>Custom</option>
            </Select>
            {propertyId && offersForProperty.length === 0 && !isMaintenanceOffer ? (
              <span className="text-[11px] font-normal normal-case text-muted">
                No catalog offerings yet. Choose Maintenance, Custom, or add a service type below.
              </span>
            ) : null}
          </label>

          {propertyId && propertySubmission && propertySaveTarget && managerUserId ? (
            <button
              type="button"
              className="flex w-full cursor-pointer items-center justify-center rounded-xl border border-dashed border-primary/30 bg-primary/[0.04] px-3 py-2.5 text-sm font-semibold text-primary transition hover:border-primary/50 hover:bg-primary/[0.07]"
              data-attr="service-request-manage-catalog"
              onClick={() => setCatalogModalOpen(true)}
              disabled={busy}
            >
              Manage service types for this property
            </button>
          ) : null}

          {isMaintenanceOffer ? (
            <>
              <label className="flex flex-col gap-1 text-xs font-medium text-muted">
                Category *
                <Select
                  value={maintenanceCategory}
                  onChange={(e) =>
                    setMaintenanceCategory(e.target.value as ResidentMaintenanceCategoryLabel)
                  }
                  disabled={busy}
                  data-attr="service-intake-maintenance-category"
                >
                  {MAINTENANCE_CATEGORY_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-muted">
                Issue title *
                <Input
                  value={maintenanceTitle}
                  onChange={(e) => setMaintenanceTitle(e.target.value)}
                  placeholder="Leaky faucet in kitchen"
                  disabled={busy}
                  data-attr="service-intake-maintenance-title"
                />
              </label>
            </>
          ) : null}

          {isCustomOffer ? (
            <>
              <label className="flex flex-col gap-1 text-xs font-medium text-muted">
                Request title *
                <Input
                  value={customTitle}
                  onChange={(e) => setCustomTitle(e.target.value)}
                  placeholder="e.g. Extra storage bin"
                  disabled={busy}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-muted">
                Price limit (optional)
                <Input
                  value={customPriceLimit}
                  onChange={(e) => setCustomPriceLimit(e.target.value)}
                  placeholder="e.g. $50"
                  disabled={busy}
                />
              </label>
            </>
          ) : null}

          {selectedOffer && !isMaintenanceOffer ? (
            <div className="grid grid-cols-2 gap-2">
              <label className="flex flex-col gap-1 text-xs font-medium text-muted">
                Payment amount
                <Input
                  value={requestPrice}
                  onChange={(e) => setRequestPrice(e.target.value)}
                  placeholder="e.g. $35.00"
                  disabled={busy}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-muted">
                Deposit
                <Input
                  value={requestDeposit}
                  onChange={(e) => setRequestDeposit(e.target.value)}
                  placeholder="e.g. $100.00"
                  disabled={busy}
                />
              </label>
            </div>
          ) : null}

          <WorkAssignmentPicker
            kind="service"
            value={assignee}
            teamMembers={teamMembers}
            vendors={vendors}
            disabled={busy}
            label={isMaintenanceOffer ? "Assignee (defaults to category vendor)" : "Assignee"}
            dataAttr="manager-service-request-assignee"
            onChange={setAssignee}
          />

          <label className="flex flex-col gap-1 text-xs font-medium text-muted">
            Notes (optional)
            <Input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Preferred timing, special instructions…"
              disabled={busy}
            />
          </label>
        </div>
      </div>

      {propertySubmission && propertySaveTarget && managerUserId ? (
        <ServiceRequestCatalogModal
          open={catalogModalOpen}
          sub={propertySubmission}
          saveTarget={propertySaveTarget}
          managerUserId={managerUserId}
          onClose={() => setCatalogModalOpen(false)}
          onUpdated={() => setTick((t) => t + 1)}
          onOfferSaved={(id) => onCatalogSaved(id)}
          showToast={showToast}
        />
      ) : null}
    </>
  );
}
