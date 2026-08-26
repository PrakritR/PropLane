"use client";

import { useEffect, useMemo, useState } from "react";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { isCurrentResidentApplicationRow } from "@/lib/current-resident";
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
import { ServiceOfferingEditModal } from "@/components/portal/service-offering-edit-modal";
import { ServiceRequestCatalogModal } from "@/components/portal/service-request-catalog-modal";

type PropertyOption = { propertyId: string; propertyLabel: string };

type ResidentOption = {
  residentName: string;
  residentEmail: string;
  propertyId: string;
  propertyLabel: string;
  roomLabel: string;
};

export type ManagerServiceResidentOption = ResidentOption;

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

function buildResidentOptions(managerUserId: string | null): ResidentOption[] {
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

function residentMatchesProperty(resident: ResidentOption, property: PropertyOption): boolean {
  if (resident.propertyId && resident.propertyId === property.propertyId) return true;
  return resident.propertyLabel.toLowerCase() === property.propertyLabel.toLowerCase();
}

export function ManagerCreateServiceRequestModal({
  open,
  onClose,
  onSubmitted,
  managerUserId,
  defaultPropertyId,
  defaultResident,
}: {
  open: boolean;
  onClose: () => void;
  onSubmitted: () => void;
  managerUserId: string | null;
  defaultPropertyId?: string;
  /** When set, the request is created for this resident (property + resident fields locked). */
  defaultResident?: ManagerServiceResidentOption | null;
}) {
  const { showToast } = useAppUi();
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [propertyId, setPropertyId] = useState("");
  const [residentEmail, setResidentEmail] = useState("");
  const [offerId, setOfferId] = useState("");
  const [notes, setNotes] = useState("");
  const [customTitle, setCustomTitle] = useState("");
  const [customPriceLimit, setCustomPriceLimit] = useState("");
  const [catalogModalOpen, setCatalogModalOpen] = useState(false);
  const [requestPrice, setRequestPrice] = useState("");
  const [requestDeposit, setRequestDeposit] = useState("");

  useEffect(() => {
    if (!open) return;
    void syncPropertyPipelineFromServer().then(() => setTick((t) => t + 1));
    void syncManagerApplicationsFromServer().then(() => setTick((t) => t + 1));
    const onProps = () => setTick((t) => t + 1);
    const onApps = () => setTick((t) => t + 1);
    window.addEventListener(PROPERTY_PIPELINE_EVENT, onProps);
    window.addEventListener(MANAGER_APPLICATIONS_EVENT, onApps);
    return () => {
      window.removeEventListener(PROPERTY_PIPELINE_EVENT, onProps);
      window.removeEventListener(MANAGER_APPLICATIONS_EVENT, onApps);
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

  const onCatalogSaved = (offerId?: string) => {
    setTick((t) => t + 1);
    if (offerId) setOfferId(offerId);
  };

  const isCustomOffer = offerId === CUSTOM_SERVICE_REQUEST_OFFER_ID;

  const submit = async () => {
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
    if (isCustomOffer) {
      if (!customTitle.trim()) {
        showToast("Add a title for the custom request.");
        return;
      }
    } else if (!selectedOffer) {
      showToast("Choose a service type.");
      return;
    }
    setBusy(true);
    try {
      if (isCustomOffer) {
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
        });
        if (!mirrored.ok) {
          showToast(mirrored.error || "Could not save request. Try again.");
          return;
        }
        showToast(`${customTitle.trim()} request created for ${selectedResident.residentName}.`);
      } else {
        const { mirrored } = await createServiceRequest({
          offerId: selectedOffer!.id,
          offerName: selectedOffer!.name,
          offerDescription: selectedOffer!.description,
          price: requestPrice.trim(),
          deposit: requestDeposit.trim(),
          residentEmail: selectedResident.residentEmail,
          residentName: selectedResident.residentName,
          managerUserId,
          propertyId,
          returnByDate: "",
          notes: notes.trim(),
        });
        if (!mirrored.ok) {
          showToast(mirrored.error || "Could not save request. Try again.");
          return;
        }
        showToast(`${selectedOffer!.name} request created for ${selectedResident.residentName}.`);
      }
      onSubmitted();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
    <Modal
      open={open}
      onClose={onClose}
      dismissBlocked={catalogModalOpen}
      title="Add service"
      footer={
        <ModalFooter>
          <Button
            type="button"
            variant="primary"
            onClick={submit}
            disabled={
              busy ||
              !offerId ||
              (isCustomOffer ? !customTitle.trim() : !selectedOffer)
            }
          >
            {busy ? "Saving…" : "Add service"}
          </Button>
        </ModalFooter>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-muted">
          {lockedResident
            ? "Log a service request for this resident. It appears in their portal under Services → Requests."
            : "Log a service on behalf of a resident. Only offerings the property makes available appear below."}
        </p>

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
            }}
            disabled={busy || !propertyId}
          >
            <option value="">
              {!propertyId
                ? "Choose a property first"
                : "Select a service type"}
            </option>
            {offersForProperty.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
                {o.price ? ` · ${o.price}` : ""}
              </option>
            ))}
            <option value={CUSTOM_SERVICE_REQUEST_OFFER_ID}>Custom</option>
          </Select>
          {propertyId && offersForProperty.length === 0 ? (
            <span className="text-[11px] font-normal normal-case text-muted">
              No catalog offerings yet. Choose Custom or add a service type below.
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

        {selectedOffer ? (
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
    </Modal>

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
