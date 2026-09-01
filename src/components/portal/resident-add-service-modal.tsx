"use client";

import Image from "next/image";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { useAppUi } from "@/components/providers/app-ui-provider";
import {
  createEmptyServiceIntakeFormState,
  ServiceIntakeFormFields,
  ServiceIntakePhotoPicker,
  type ServiceIntakeFormState,
} from "@/components/portal/service-intake-form-fields";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import type { ManagerListingServiceOption } from "@/lib/manager-listing-submission";
import { mergeResidentServiceCatalogOffers } from "@/lib/manager-listing-submission";
import { parseMoneyAmount } from "@/lib/household-charges";
import { getPropertyById } from "@/lib/rental-application/data";
import { track } from "@/lib/analytics/track-client";
import {
  buildServiceIntakeOptions,
  findServiceIntakeOption,
  serviceIntakeCategoryForOption,
  serviceIntakeIsCustomAddOn,
  serviceIntakeSuggestedTitle,
} from "@/lib/service-intake";
import { formatPreferredArrival } from "@/lib/preferred-arrival";
import {
  createServiceRequest,
  CUSTOM_SERVICE_REQUEST_OFFER_ID,
  hasDeposit,
  syncServiceRequestsFromServer,
} from "@/lib/service-requests-storage";
import {
  deleteManagerWorkOrderRow,
  readManagerWorkOrderRows,
  syncManagerWorkOrdersFromServer,
  updateManagerWorkOrder,
  upsertManagerWorkOrderToServer,
  writeManagerWorkOrderRows,
} from "@/lib/manager-work-orders-storage";
import type { ResidentMaintenanceCategoryLabel } from "@/lib/work-order-taxonomy";
export function ResidentAddServiceModal({
  open,
  onClose,
  residentEmail,
  residentName,
  availableOffers,
  servicesUnlocked,
  resolveFilingIds,
  getApplication,
  onSubmitted,
}: {
  open: boolean;
  onClose: () => void;
  residentEmail: string;
  residentName: string;
  availableOffers: readonly ManagerListingServiceOption[];
  servicesUnlocked: boolean;
  resolveFilingIds: () => { propertyId: string; managerUserId: string };
  getApplication: () => {
    name?: string;
    property?: string;
    assignedPropertyId?: string;
    assignedRoomChoice?: string;
    application?: { roomChoice1?: string };
  } | null;
  onSubmitted: () => void;
}) {
  const { showToast } = useAppUi();
  const catalogOffers = useMemo(
    () => mergeResidentServiceCatalogOffers(availableOffers),
    [availableOffers],
  );
  const intakeOptions = useMemo(() => buildServiceIntakeOptions(catalogOffers), [catalogOffers]);
  const [form, setForm] = useState<ServiceIntakeFormState>(() =>
    createEmptyServiceIntakeFormState(intakeOptions),
  );
  const [submitting, setSubmitting] = useState(false);
  const [photos, setPhotos] = useState<string[]>([]);

  useEffect(() => {
    if (!open) return;
    queueMicrotask(() => {
      setForm(createEmptyServiceIntakeFormState(intakeOptions));
      setPhotos([]);
    });
  }, [open, intakeOptions]);

  const patchForm = (patch: Partial<ServiceIntakeFormState>) => {
    setForm((current) => ({ ...current, ...patch }));
  };

  const openPhotoPicker = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.multiple = true;
    input.style.cssText = "position:fixed;left:-9999px;top:-9999px;opacity:0;width:0;height:0;";
    input.setAttribute("tabindex", "-1");
    input.setAttribute("aria-hidden", "true");
    const onChange = () => {
      void onPickPhotos(input.files);
      input.removeEventListener("change", onChange);
      input.remove();
    };
    input.addEventListener("change", onChange);
    document.body.appendChild(input);
    input.click();
  };

  const fileToDataUrl = (file: File) =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ""));
      reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
      reader.readAsDataURL(file);
    });

  const onPickPhotos = async (files: FileList | null) => {
    if (!files?.length) return;
    const remaining = 6 - photos.length;
    if (remaining <= 0) {
      showToast("Up to 6 photos.");
      return;
    }
    const next = [...photos];
    for (let i = 0; i < Math.min(files.length, remaining); i++) {
      const file = files[i];
      if (!file) continue;
      if (!file.type.startsWith("image/")) {
        showToast("Images only.");
        return;
      }
      next.push(await fileToDataUrl(file));
    }
    setPhotos(next);
  };

  const submit = async () => {
    if (submitting) return;
    if (!servicesUnlocked) {
      showToast("Services unlock after your lease is fully signed.");
      return;
    }
    if (!residentEmail) {
      showToast("Sign in to submit.");
      return;
    }

    const option = findServiceIntakeOption(intakeOptions, form.optionKey);
    if (!option) {
      showToast("Select a service type.");
      return;
    }

    const { propertyId, managerUserId } = resolveFilingIds();
    if (!propertyId || !managerUserId) {
      showToast("Could not find your property manager. Contact support.");
      return;
    }

    setSubmitting(true);
    try {
      if (option.kind === "repair") {
        const title = form.title.trim() || serviceIntakeSuggestedTitle(option, form.categoryLabel);
        if (!title) {
          showToast("Add a title first.");
          return;
        }
        if (!form.description.trim()) {
          showToast("Describe the issue first.");
          return;
        }
        const application = getApplication();
        const propertyLabel =
          application?.property ||
          getPropertyById(propertyId)?.address.split(",")[0]?.trim() ||
          "Assigned house";
        const propertyAddress = getPropertyById(propertyId)?.address.trim() || undefined;
        const row: DemoManagerWorkOrderRow & { requestType: string } = {
          id: `REQ-${Date.now()}`,
          requestType: "maintenance",
          propertyName: propertyLabel,
          propertyId,
          propertyAddress,
          assignedPropertyId: application?.assignedPropertyId,
          assignedRoomChoice: application?.assignedRoomChoice || application?.application?.roomChoice1,
          managerUserId,
          unit: application?.assignedRoomChoice || application?.application?.roomChoice1 || "—",
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
          residentName: application?.name || residentName,
          residentEmail,
          photoDataUrls: photos,
        };
        writeManagerWorkOrderRows([row, ...readManagerWorkOrderRows()], { mirror: false });
        const mirrored = await upsertManagerWorkOrderToServer(row);
        if (!mirrored.ok) {
          deleteManagerWorkOrderRow(row.id);
          showToast(mirrored.error || "Could not send service request to your manager. Try again.");
          return;
        }
        if (mirrored.row.id === row.id) {
          updateManagerWorkOrder(row.id, () => mirrored.row);
        }
        track("work_order_submitted", {
          category: row.category,
          priority: form.priority,
          emergency: form.priority === "Emergency",
          photo_count: photos.length,
          entry_permission: form.entryPermission,
        });
      } else {
        const isCustom = serviceIntakeIsCustomAddOn(option);
        if (isCustom) {
          if (!form.title.trim()) {
            showToast("Add a title for your request.");
            return;
          }
          const limitAmount = parseMoneyAmount(form.customPriceLimit.trim());
          if (!Number.isFinite(limitAmount) || limitAmount <= 0) {
            showToast("Enter a valid price limit.");
            return;
          }
        }

        let offerId: string;
        let offerName: string;
        let offerDescription: string;
        let price: string;
        let priceLimit: string | undefined;
        let deposit: string;

        if (isCustom) {
          const limitLabel = form.customPriceLimit.trim().startsWith("$")
            ? form.customPriceLimit.trim()
            : `$${parseMoneyAmount(form.customPriceLimit.trim())}`;
          offerId = CUSTOM_SERVICE_REQUEST_OFFER_ID;
          offerName = form.title.trim();
          offerDescription = form.description.trim();
          price = "";
          priceLimit = limitLabel;
          deposit = "";
        } else {
          const currentOffer = catalogOffers.find((offer) => offer.id === option.offerId) ?? null;
          if (!currentOffer) {
            showToast("That service is no longer available. Please choose another.");
            return;
          }
          offerId = currentOffer.id;
          offerName = currentOffer.name;
          offerDescription = form.description.trim() || currentOffer.description;
          price = currentOffer.price;
          deposit = currentOffer.deposit;
        }

        const application = getApplication();
        const { mirrored } = await createServiceRequest({
          offerId,
          offerName,
          offerDescription,
          price,
          priceLimit,
          deposit,
          residentEmail,
          residentName: application?.name || residentName || residentEmail,
          managerUserId,
          propertyId,
          returnByDate: "",
          notes: form.description.trim(),
        });
        if (!mirrored.ok) {
          showToast(mirrored.error || "Could not send request to your manager. Try again.");
          return;
        }
      }

      showToast("Service submitted.");
      onClose();
      onSubmitted();
      await Promise.all([
        syncManagerWorkOrdersFromServer({ force: true }),
        syncServiceRequestsFromServer({ force: true }),
      ]);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      title="Add service"
      onClose={onClose}
      panelClassName="max-w-lg"
      footer={
        <ModalFooter>
          <Button
            type="button"
            variant="primary"
            className="rounded-full"
            data-attr="resident-service-intake-submit"
            onClick={() => void submit()}
            disabled={submitting}
          >
            {submitting ? "Submitting…" : "Add service"}
          </Button>
        </ModalFooter>
      }
    >
      <p className="text-xs text-muted">
        Choose a property service or describe a repair. Your manager receives one service list for both.
      </p>
      <div className="mt-4">
        <ServiceIntakeFormFields
          catalogOffers={catalogOffers}
          form={form}
          onChange={patchForm}
          disabled={submitting || !servicesUnlocked}
          photoSlot={
            <>
              <ServiceIntakePhotoPicker onPick={openPhotoPicker} disabled={submitting} />
              {photos.length ? (
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {photos.map((src, i) => (
                    <div key={i} className="overflow-hidden rounded-xl border border-border bg-accent/30">
                      <Image
                        src={src}
                        alt={`Photo ${i + 1}`}
                        width={240}
                        height={180}
                        className="h-24 w-full object-cover"
                        unoptimized
                      />
                      <div className="flex justify-start p-2">
                        <Button
                          type="button"
                          variant="outline"
                          className="h-8 rounded-full px-3 text-[11px]"
                          onClick={() => setPhotos((current) => current.filter((_, j) => j !== i))}
                        >
                          Remove
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
            </>
          }
        />
      </div>
    </Modal>
  );
}
