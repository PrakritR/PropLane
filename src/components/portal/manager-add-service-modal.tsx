"use client";

import { useEffect, useMemo, useState } from "react";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { useAppUi } from "@/components/providers/app-ui-provider";
import type { ManagerServiceResidentOption } from "@/components/portal/manager-create-service-request-modal";
import {
  createEmptyServiceIntakeFormState,
  ServiceIntakeFormFields,
  ServiceIntakePhotoPicker,
  type ServiceIntakeFormState,
} from "@/components/portal/service-intake-form-fields";
import { WorkAssignmentPicker } from "@/components/portal/work-assignment-picker";
import { useWorkAssignmentDirectory } from "@/hooks/use-work-assignment-directory";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { isCurrentResidentApplicationRow } from "@/lib/current-resident";
import {
  MANAGER_APPLICATIONS_EVENT,
  readManagerApplicationRows,
  syncManagerApplicationsFromServer,
} from "@/lib/manager-applications-storage";
import { applicationVisibleToPortalUser } from "@/lib/manager-portfolio-access";
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
import { getPropertyById, getRoomChoiceLabel } from "@/lib/rental-application/data";
import { deliverPortalInboxMessage } from "@/lib/portal-message-delivery";
import { formatPreferredArrival } from "@/lib/preferred-arrival";
import {
  buildServiceIntakeOptions,
  findServiceIntakeOption,
  serviceIntakeCategoryForOption,
  serviceIntakeIsCustomAddOn,
  serviceIntakeSuggestedTitle,
} from "@/lib/service-intake";
import {
  createServiceRequest,
  CUSTOM_SERVICE_REQUEST_OFFER_ID,
} from "@/lib/service-requests-storage";
import {
  createScheduledWorkTask,
  scheduledTaskTitleForService,
} from "@/lib/manager-scheduled-work-tasks";
import {
  readManagerWorkOrderRows,
  writeManagerWorkOrderRows,
} from "@/lib/manager-work-orders-storage";
import type { WorkAssignee } from "@/lib/work-assignment";
import type { ManagerWorkOrderBucket } from "@/data/demo-portal";

type PropertyOption = { propertyId: string; propertyLabel: string };
type ResidentOption = ManagerServiceResidentOption & { assignedRoomChoice?: string };

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
        assignedRoomChoice: row.assignedRoomChoice?.trim() || row.application?.roomChoice1?.trim(),
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

export function ManagerAddServiceModal({
  open,
  onClose,
  onSubmitted,
  managerUserId,
  defaultPropertyId,
  defaultResident,
}: {
  open: boolean;
  onClose: () => void;
  onSubmitted: (bucket?: ManagerWorkOrderBucket) => void;
  managerUserId: string | null;
  defaultPropertyId?: string;
  defaultResident?: ResidentOption | null;
}) {
  const { showToast } = useAppUi();
  const { teamMembers, vendors } = useWorkAssignmentDirectory({ managerUserId });
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [propertyId, setPropertyId] = useState("");
  const [residentEmail, setResidentEmail] = useState("");
  const [assignee, setAssignee] = useState<WorkAssignee | null>(null);
  const [requestPrice, setRequestPrice] = useState("");
  const [requestDeposit, setRequestDeposit] = useState("");
  const [photos, setPhotos] = useState<string[]>([]);
  const [form, setForm] = useState<ServiceIntakeFormState>({
    optionKey: "repair:General",
    title: "",
    description: "",
    categoryLabel: "General",
    priority: "Medium",
    customPriceLimit: "",
    arrivalPreset: "Anytime",
    arrivalCustom: "",
    entryPermission: "call_first",
    entryNotes: "",
  });

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
      setAssignee(null);
      setRequestPrice("");
      setRequestDeposit("");
      setPhotos([]);
      setForm(createEmptyServiceIntakeFormState([]));
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
  const selectedResident = useMemo(() => {
    if (lockedResident) return lockedResident;
    return residentOptions.find((r) => r.residentEmail === residentEmail) ?? null;
  }, [lockedResident, residentEmail, residentOptions]);

  const selectedProperty = useMemo(() => {
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

  const intakeOptions = useMemo(() => buildServiceIntakeOptions(offersForProperty), [offersForProperty]);

  useEffect(() => {
    if (!open) return;
    setForm((current) => {
      const nextKey = intakeOptions.some((option) => option.key === current.optionKey)
        ? current.optionKey
        : createEmptyServiceIntakeFormState(intakeOptions).optionKey;
      return { ...current, optionKey: nextKey };
    });
  }, [open, intakeOptions]);

  const selectedOffer = useMemo(() => {
    const option = findServiceIntakeOption(intakeOptions, form.optionKey);
    if (!option?.offerId || serviceIntakeIsCustomAddOn(option)) return null;
    return offersForProperty.find((offer) => offer.id === option.offerId) ?? null;
  }, [form.optionKey, intakeOptions, offersForProperty]);

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

    const option = findServiceIntakeOption(intakeOptions, form.optionKey);
    if (!option) {
      showToast("Choose a service type.");
      return;
    }

    setBusy(true);
    try {
      if (option.kind === "repair") {
        const title = form.title.trim() || serviceIntakeSuggestedTitle(option, form.categoryLabel);
        if (!title) {
          showToast("Add a title for the service.");
          return;
        }
        if (!form.description.trim()) {
          showToast("Add a description.");
          return;
        }
        const id = `REQ-${Date.now()}`;
        const row: DemoManagerWorkOrderRow = {
          id,
          propertyName: selectedProperty.propertyLabel,
          propertyId,
          assignedPropertyId: propertyId,
          assignedRoomChoice: selectedResident.assignedRoomChoice,
          managerUserId,
          unit: selectedResident.roomLabel || "—",
          title,
          priority: form.priority,
          status: "Submitted",
          bucket: "open",
          category: serviceIntakeCategoryForOption(option, form.categoryLabel),
          description: form.description.trim(),
          scheduled: "—",
          cost: "—",
          preferredArrival: formatPreferredArrival(form.arrivalPreset, form.arrivalCustom),
          entryPermission: form.entryPermission,
          entryNotes: form.entryNotes.trim() || undefined,
          residentName: selectedResident.residentName,
          residentEmail: selectedResident.residentEmail,
          photoDataUrls: photos.length > 0 ? photos : undefined,
          managerInitiated: true,
        };
        writeManagerWorkOrderRows([row, ...readManagerWorkOrderRows()]);
        const preferredArrival = formatPreferredArrival(form.arrivalPreset, form.arrivalCustom);
        const notify = await deliverPortalInboxMessage({
          eventCategory: "maintenance",
          fromName: "Property Manager",
          toEmails: [selectedResident.residentEmail],
          subject: `Service request: ${title}`,
          text: [
            `Hi ${selectedResident.residentName || "there"},`,
            "",
            "Your property manager logged a service request on your behalf:",
            "",
            `Title: ${title}`,
            `Category: ${form.categoryLabel}`,
            `Priority: ${form.priority}`,
            `Preferred arrival: ${preferredArrival}`,
            form.description.trim() ? `Details: ${form.description.trim()}` : "",
            photos.length > 0 ? `Photos attached: ${photos.length}` : "",
            "",
            "Sign in to your PropLane resident portal to view updates under Services.",
          ]
            .filter(Boolean)
            .join("\n"),
          deliverViaEmail: true,
          deliverViaSms: true,
        });
        showToast(`Service logged for ${selectedResident.residentName}.`);
        if (!notify.ok) {
          showToast("Service saved, but resident notification could not be sent.");
        }
        onSubmitted("open");
        onClose();
        return;
      }

      const isCustom = serviceIntakeIsCustomAddOn(option);
      if (isCustom && !form.title.trim()) {
        showToast("Add a title for the custom request.");
        return;
      }
      if (!isCustom && !selectedOffer) {
        showToast("Choose a service type.");
        return;
      }

      const { mirrored } = await createServiceRequest({
        offerId: isCustom ? CUSTOM_SERVICE_REQUEST_OFFER_ID : selectedOffer!.id,
        offerName: isCustom ? form.title.trim() : selectedOffer!.name,
        offerDescription: isCustom ? form.description.trim() : selectedOffer!.description,
        price: isCustom ? "" : requestPrice.trim(),
        priceLimit: isCustom ? form.customPriceLimit.trim() || undefined : undefined,
        deposit: isCustom ? "" : requestDeposit.trim(),
        residentEmail: selectedResident.residentEmail,
        residentName: selectedResident.residentName,
        managerUserId,
        propertyId,
        returnByDate: "",
        notes: form.description.trim(),
        assignee: assignee ?? undefined,
      });
      if (!mirrored.ok) {
        showToast(mirrored.error || "Could not save service. Try again.");
        return;
      }
      const taskTitle = isCustom ? form.title.trim() : selectedOffer!.name;
      void createScheduledWorkTask(managerUserId, {
        title: scheduledTaskTitleForService(taskTitle, selectedResident.residentName),
        propertyId,
        propertyTitle: selectedResident.propertyLabel,
        assignee: assignee ?? undefined,
        notes: form.description.trim() || undefined,
      });
      showToast(`${taskTitle} created for ${selectedResident.residentName}.`);
      onSubmitted();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add service"
      footer={
        <ModalFooter>
          <Button type="button" variant="primary" onClick={() => void submit()} disabled={busy}>
            {busy ? "Saving…" : "Add service"}
          </Button>
        </ModalFooter>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-muted">
          Log a service for a resident — property offerings, repairs, or a custom add-on all land in one Services list.
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
                }}
                className="bg-card"
                data-attr="manager-service-intake-property"
              >
                <option value="">Select property</option>
                {propertyOptions.map((property) => (
                  <option key={property.propertyId} value={property.propertyId}>
                    {property.propertyLabel}
                  </option>
                ))}
              </Select>
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-muted">
              Resident *
              <Select
                value={residentEmail}
                onChange={(e) => setResidentEmail(e.target.value)}
                className="bg-card"
                disabled={!propertyId}
                data-attr="manager-service-intake-resident"
              >
                <option value="">Select resident</option>
                {residentsForProperty.map((resident) => (
                  <option key={resident.residentEmail} value={resident.residentEmail}>
                    {resident.residentName}
                    {resident.roomLabel ? ` · ${resident.roomLabel}` : ""}
                  </option>
                ))}
              </Select>
            </label>
          </>
        )}

        <ServiceIntakeFormFields
          catalogOffers={offersForProperty}
          form={form}
          onChange={(patch) => setForm((current) => ({ ...current, ...patch }))}
          disabled={busy}
          photoSlot={
            <ServiceIntakePhotoPicker
              onPick={() => {
                const input = document.createElement("input");
                input.type = "file";
                input.accept = "image/*";
                input.multiple = true;
                input.style.cssText = "position:fixed;left:-9999px;top:-9999px;opacity:0;width:0;height:0;";
                input.setAttribute("tabindex", "-1");
                input.setAttribute("aria-hidden", "true");
                input.addEventListener("change", () => {
                  void (async () => {
                    const files = input.files;
                    if (!files?.length) return;
                    const remaining = 6 - photos.length;
                    if (remaining <= 0) {
                      showToast("Up to 6 photos.");
                      return;
                    }
                    const next = [...photos];
                    for (let i = 0; i < Math.min(files.length, remaining); i++) {
                      const file = files[i];
                      if (!file?.type.startsWith("image/")) {
                        showToast("Images only.");
                        return;
                      }
                      next.push(
                        await new Promise<string>((resolve, reject) => {
                          const reader = new FileReader();
                          reader.onload = () => resolve(String(reader.result ?? ""));
                          reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
                          reader.readAsDataURL(file);
                        }),
                      );
                    }
                    setPhotos(next);
                  })();
                  input.remove();
                });
                document.body.appendChild(input);
                input.click();
              }}
              disabled={busy}
            />
          }
        />

        {findServiceIntakeOption(intakeOptions, form.optionKey)?.kind === "add-on" ? (
          <WorkAssignmentPicker
            kind="service"
            teamMembers={teamMembers}
            vendors={vendors}
            value={assignee}
            onChange={setAssignee}
            disabled={busy}
            dataAttr="manager-add-service-assignee"
          />
        ) : null}

        {selectedOffer ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-xs font-medium text-muted">
              Price
              <Input value={requestPrice} onChange={(e) => setRequestPrice(e.target.value)} className="bg-card" />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-muted">
              Deposit
              <Input value={requestDeposit} onChange={(e) => setRequestDeposit(e.target.value)} className="bg-card" />
            </label>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
