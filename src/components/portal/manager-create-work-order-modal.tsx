"use client";

import Image from "next/image";
import { useEffect, useMemo, useRef, useState } from "react";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/input";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { PreferredArrivalField } from "@/components/portal/preferred-arrival-field";
import type { DemoManagerWorkOrderRow, ManagerWorkOrderBucket } from "@/data/demo-portal";
import {
  HOUSEHOLD_CHARGE_DEMO_MANAGER_SCOPE,
  parseMoneyAmount,
  recordWorkOrderResidentCharge,
} from "@/lib/household-charges";
import { isCurrentResidentApplicationRow } from "@/lib/current-resident";
import {
  MANAGER_APPLICATIONS_EVENT,
  readManagerApplicationRows,
  syncManagerApplicationsFromServer,
} from "@/lib/manager-applications-storage";
import {
  applicationVisibleToPortalUser,
  collectLinkedPropertyIdsForModule,
  resolvePropertyLabelForId,
} from "@/lib/manager-portfolio-access";
import { getRoomChoiceLabel } from "@/lib/rental-application/data";
import {
  PROPERTY_PIPELINE_EVENT,
  readExtraListingsForUser,
  readPendingManagerPropertiesForUser,
  syncPropertyPipelineFromServer,
} from "@/lib/demo-property-pipeline";
import {
  readManagerWorkOrderRows,
  writeManagerWorkOrderRows,
} from "@/lib/manager-work-orders-storage";
import { deliverPortalInboxMessage } from "@/lib/portal-message-delivery";
import { formatPreferredArrival } from "@/lib/preferred-arrival";
import {
  type ResidentMaintenanceCategoryLabel,
  workOrderCategoryForResidentLabel,
} from "@/lib/work-order-taxonomy";
import type { ManagerServiceResidentOption } from "@/components/portal/manager-create-service-request-modal";

type WorkOrderCategory = "cleaning" | "plumbing" | "mold" | "electrical" | "hvac" | "general";
type CreateMode = "request" | "log";

type PropertyOption = { propertyId: string; propertyLabel: string };

type ResidentOption = ManagerServiceResidentOption & { assignedRoomChoice?: string };

const RESIDENT_CATEGORY_OPTIONS: ResidentMaintenanceCategoryLabel[] = [
  "Plumbing",
  "Electrical",
  "HVAC",
  "Appliance",
  "Access / Locks",
  "General",
];

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
  // A co-manager's linked listings live in the OWNER's bucket of the property
  // pipeline store, never this viewer's, so the two loops above see none of them
  // and the picker reads as an empty portfolio for a co-manager who can plainly
  // see the same homes on the Properties tab (AXI-156).
  for (const propertyId of collectLinkedPropertyIdsForModule(managerUserId, "services")) {
    if (!propertyId || seen.has(propertyId)) continue;
    const propertyLabel = displayPropertyLabel(resolvePropertyLabelForId(propertyId));
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

const LOG_CATEGORY_LABELS: Record<WorkOrderCategory, string> = {
  cleaning: "Cleaning",
  plumbing: "Plumbing",
  mold: "Mold remediation",
  electrical: "Electrical",
  hvac: "HVAC",
  general: "General maintenance",
};

export function ManagerCreateWorkOrderModal({
  open,
  onClose,
  onSubmitted,
  onWorkOrderCreated,
  managerUserId,
  defaultPropertyId,
  defaultResident,
  defaultTitle,
  defaultDescription,
}: {
  open: boolean;
  onClose: () => void;
  onSubmitted: (bucket: ManagerWorkOrderBucket) => void;
  /** When set (e.g. Tasks add flow), creates a linked task list row. */
  onWorkOrderCreated?: (workOrder: {
    id: string;
    title: string;
    propertyId: string;
    propertyTitle: string;
    roomLabel?: string;
  }) => void;
  managerUserId: string | null;
  defaultPropertyId?: string;
  /** When set, the work order is created for this resident (property + resident fields locked). */
  defaultResident?: (ManagerServiceResidentOption & { assignedRoomChoice?: string }) | null;
  defaultTitle?: string;
  defaultDescription?: string;
}) {
  const { showToast } = useAppUi();
  const photoInputRef = useRef<HTMLInputElement>(null);
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<CreateMode>("request");

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [categoryLabel, setCategoryLabel] = useState<ResidentMaintenanceCategoryLabel>("General");
  const [logCategory, setLogCategory] = useState<WorkOrderCategory>("general");
  const [priority, setPriority] = useState("Medium");
  const [arrivalPreset, setArrivalPreset] = useState("Anytime");
  const [arrivalCustom, setArrivalCustom] = useState("");
  const [photos, setPhotos] = useState<string[]>([]);
  const [propertyId, setPropertyId] = useState("");
  const [residentEmail, setResidentEmail] = useState("");
  const [cost, setCost] = useState("");
  const [paymentStatus, setPaymentStatus] = useState<"none" | "pending" | "paid">("paid");

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
      setMode("request");
      setTitle(defaultTitle?.trim() ?? "");
      setDescription(defaultDescription?.trim() ?? "");
      setCategoryLabel("General");
      setLogCategory("general");
      setPriority("Medium");
      setArrivalPreset("Anytime");
      setArrivalCustom("");
      setPhotos([]);
      if (defaultResident) {
        setPropertyId(defaultResident.propertyId.trim());
        setResidentEmail(defaultResident.residentEmail.trim().toLowerCase());
      } else {
        setPropertyId(defaultPropertyId?.trim() || "");
        setResidentEmail("");
      }
      setCost("");
      setPaymentStatus("paid");
      if (photoInputRef.current) photoInputRef.current.value = "";
    });
  }, [open, defaultPropertyId, defaultResident, defaultTitle, defaultDescription]);

  const propertyOptions = useMemo(() => {
    void tick;
    return buildPropertyOptions(managerUserId);
  }, [managerUserId, tick]);

  const residentOptions = useMemo(() => {
    void tick;
    return buildResidentOptions(managerUserId);
  }, [managerUserId, tick]);

  const lockedResident = defaultResident ?? null;

  const residentsForProperty = useMemo(() => {
    const property = propertyOptions.find((p) => p.propertyId === propertyId);
    if (!property) return residentOptions;
    return residentOptions.filter((r) => residentMatchesProperty(r, property));
  }, [propertyId, propertyOptions, residentOptions]);

  const selectedResident = useMemo(() => {
    if (lockedResident) {
      const match = residentOptions.find((r) => r.residentEmail === lockedResident.residentEmail);
      return {
        ...lockedResident,
        assignedRoomChoice: lockedResident.assignedRoomChoice ?? match?.assignedRoomChoice,
      };
    }
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

  const submitRequest = async () => {
    if (!title.trim()) {
      showToast("Add a title for the work order.");
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

    setBusy(true);
    try {
      const id = `REQ-${Date.now()}`;
      const preferredArrival = formatPreferredArrival(arrivalPreset, arrivalCustom);
      const details =
        description.trim() ||
        `${categoryLabel}: Maintenance request logged by your property manager.`;
      const row: DemoManagerWorkOrderRow = {
        id,
        propertyName: selectedProperty.propertyLabel,
        propertyId,
        assignedPropertyId: propertyId,
        assignedRoomChoice: selectedResident.assignedRoomChoice,
        managerUserId,
        unit: selectedResident.roomLabel || "—",
        title: title.trim(),
        priority,
        status: "Submitted",
        bucket: "open",
        category: workOrderCategoryForResidentLabel(categoryLabel),
        description: details,
        scheduled: "—",
        cost: "—",
        preferredArrival,
        residentName: selectedResident.residentName,
        residentEmail: selectedResident.residentEmail,
        photoDataUrls: photos.length > 0 ? photos : undefined,
        managerInitiated: true,
      };

      writeManagerWorkOrderRows([row, ...readManagerWorkOrderRows()]);

      onWorkOrderCreated?.({
        id,
        title: title.trim(),
        propertyId,
        propertyTitle: selectedProperty.propertyLabel,
        roomLabel: selectedResident.roomLabel || undefined,
      });

      const notify = await deliverPortalInboxMessage({
        eventCategory: "maintenance",
        fromName: "Property Manager",
        toEmails: [selectedResident.residentEmail],
        subject: `Maintenance request opened: ${title.trim()}`,
        text: [
          `Hi ${selectedResident.residentName || "there"},`,
          "",
          "Your property manager logged a maintenance request on your behalf:",
          "",
          `Title: ${title.trim()}`,
          `Category: ${categoryLabel}`,
          `Priority: ${priority}`,
          `Preferred arrival: ${preferredArrival}`,
          details ? `Details: ${details}` : "",
          photos.length > 0 ? `Photos attached: ${photos.length}` : "",
          "",
          "Sign in to your PropLane resident portal to view updates under Services → Work orders.",
        ]
          .filter(Boolean)
          .join("\n"),
        deliverViaEmail: true,
        deliverViaSms: true,
      });

      showToast("Work order created.");
      if (!notify.ok) {
        showToast("Work order saved, but resident notification could not be sent.");
      }
      onSubmitted("open");
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const submitLog = () => {
    if (!title.trim()) {
      showToast("Add a title for the work order.");
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
    const amt = cost.trim() ? parseMoneyAmount(cost) : 0;
    if (cost.trim() && (!Number.isFinite(amt) || amt <= 0)) {
      showToast("Enter a valid cost or leave it blank.");
      return;
    }
    if (amt > 0 && paymentStatus === "none") {
      showToast("Choose whether the resident payment is pending or already paid.");
      return;
    }

    setBusy(true);
    try {
      const now = new Date();
      const id = `MGR-WO-${now.getTime()}`;
      const costLabel = amt > 0 ? `$${amt.toFixed(2)}` : "—";
      const row: DemoManagerWorkOrderRow = {
        id,
        propertyName: selectedProperty.propertyLabel,
        propertyId,
        assignedPropertyId: propertyId,
        assignedRoomChoice: selectedResident.assignedRoomChoice,
        managerUserId,
        unit: selectedResident.roomLabel || "—",
        title: title.trim(),
        priority,
        status: "Completed",
        bucket: "completed",
        description:
          description.trim() ||
          `${LOG_CATEGORY_LABELS[logCategory]}, logged by manager.${amt > 0 ? ` Cost: ${costLabel}.` : ""}`,
        scheduled: "—",
        cost: costLabel,
        residentName: selectedResident.residentName,
        residentEmail: selectedResident.residentEmail,
        category: logCategory,
        managerInitiated: true,
        completedAt: now.toISOString(),
        workDoneSummary: title.trim(),
      };

      if (amt > 0 && paymentStatus !== "none") {
        const effectiveManagerId = managerUserId ?? HOUSEHOLD_CHARGE_DEMO_MANAGER_SCOPE;
        const charge = recordWorkOrderResidentCharge({
          managerUserId: effectiveManagerId,
          workOrderId: id,
          propertyId,
          propertyLabel: selectedProperty.propertyLabel,
          unit: selectedResident.roomLabel || "—",
          workOrderTitle: title.trim(),
          amountInput: cost,
          residentEmail: selectedResident.residentEmail,
          residentName: selectedResident.residentName,
          initialStatus: paymentStatus === "paid" ? "paid" : "pending",
        });
        if (!charge) {
          showToast("Could not create the payment line. The work order was not saved.");
          return;
        }
      }

      writeManagerWorkOrderRows([row, ...readManagerWorkOrderRows()]);

      onWorkOrderCreated?.({
        id,
        title: title.trim(),
        propertyId,
        propertyTitle: selectedProperty.propertyLabel,
        roomLabel: selectedResident.roomLabel || undefined,
      });

      showToast(
        amt > 0 && paymentStatus === "paid"
          ? "Work order logged and payment recorded as paid."
          : amt > 0
            ? "Work order logged with a pending payment line."
            : "Work order logged.",
      );
      onSubmitted("completed");
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const submit = () => {
    if (busy) return;
    if (mode === "request") {
      void submitRequest();
      return;
    }
    submitLog();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Create work order"
      panelClassName="max-w-lg"
      assistantContext="Create work order"
      footer={
        <ModalFooter>
          <Button
            type="button"
            variant="primary"
            onClick={submit}
            disabled={busy}
            data-attr="manager-work-order-submit"
          >
            {busy ? "Saving…" : mode === "request" ? "Create work order" : "Save work order"}
          </Button>
        </ModalFooter>
      }
    >
      <div className="space-y-5">
        <label className="flex flex-col gap-1.5 text-xs font-medium text-muted">
          Status
          <Select
            value={mode}
            onChange={(e) => setMode(e.target.value as CreateMode)}
            disabled={busy}
            data-attr="manager-work-order-status"
          >
            <option value="request">Open request</option>
            <option value="log">Completed</option>
          </Select>
        </label>

        <p className="text-sm text-muted">
          {lockedResident
            ? mode === "request"
              ? "Create a maintenance request for this resident. It appears in their portal under Services → Work orders."
              : "Record completed work for this resident. Optional cost updates their Payments tab."
            : mode === "request"
              ? "Create a maintenance request on behalf of a resident. It appears in Pending until you schedule or complete it."
              : "Record work you already performed (e.g. lockout assistance) with optional cost and payment status for Finances."}
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
          <Select value={residentEmail} onChange={(e) => setResidentEmail(e.target.value)} disabled={busy || !propertyId}>
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
          Title *
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={mode === "request" ? "Short summary of the issue" : "e.g. Lockout assistance"}
            disabled={busy}
          />
        </label>

        <label className="flex flex-col gap-1 text-xs font-medium text-muted">
          Details
          <Textarea
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={
              mode === "request"
                ? "Describe the issue, access notes, or context from the resident…"
                : "What was done, when, any notes for your records…"
            }
            disabled={busy}
          />
        </label>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-xs font-medium text-muted">
            Category
            {mode === "request" ? (
              <Select
                value={categoryLabel}
                onChange={(e) => setCategoryLabel(e.target.value as ResidentMaintenanceCategoryLabel)}
                disabled={busy}
              >
                {RESIDENT_CATEGORY_OPTIONS.map((key) => (
                  <option key={key} value={key}>
                    {key}
                  </option>
                ))}
              </Select>
            ) : (
              <Select value={logCategory} onChange={(e) => setLogCategory(e.target.value as WorkOrderCategory)} disabled={busy}>
                {(Object.keys(LOG_CATEGORY_LABELS) as WorkOrderCategory[]).map((key) => (
                  <option key={key} value={key}>
                    {LOG_CATEGORY_LABELS[key]}
                  </option>
                ))}
              </Select>
            )}
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-muted">
            Priority
            <Select value={priority} onChange={(e) => setPriority(e.target.value)} disabled={busy}>
              <option value="Low">Low</option>
              <option value="Medium">Medium</option>
              <option value="High">High</option>
            </Select>
          </label>
        </div>

        {mode === "request" ? (
          <>
            <PreferredArrivalField
              preset={arrivalPreset}
              custom={arrivalCustom}
              onPresetChange={setArrivalPreset}
              onCustomChange={setArrivalCustom}
            />
            <div>
              <p className="mb-1 text-[11px] font-medium text-muted">Photos (up to 6)</p>
              <input
                ref={photoInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => {
                  void onPickPhotos(e.target.files);
                }}
              />
              <Button
                type="button"
                variant="outline"
                className="w-fit rounded-full text-xs"
                onClick={() => photoInputRef.current?.click()}
                disabled={busy}
              >
                Attach photos
              </Button>
              {photos.length > 0 ? (
                <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {photos.map((src, i) => (
                    <div key={i} className="overflow-hidden rounded-xl border border-border bg-accent/30">
                      <Image src={src} alt={`Photo ${i + 1}`} width={240} height={180} className="h-24 w-full object-cover" unoptimized />
                      <div className="flex justify-start p-2">
                        <Button
                          type="button"
                          variant="outline"
                          className="h-8 rounded-full px-3 text-[11px]"
                          onClick={() => setPhotos((p) => p.filter((_, j) => j !== i))}
                          disabled={busy}
                        >
                          Remove
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          </>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-xs font-medium text-muted">
                Cost (USD)
                <Input
                  type="text"
                  inputMode="decimal"
                  value={cost}
                  onChange={(e) => {
                    const next = e.target.value;
                    setCost(next);
                    if (!next.trim()) setPaymentStatus("none");
                    else if (paymentStatus === "none") setPaymentStatus("paid");
                  }}
                  placeholder="e.g. 25"
                  disabled={busy}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-muted">
                Status
                {cost.trim() ? (
                  <Select
                    value={paymentStatus === "pending" ? "completed_pending" : "completed_paid"}
                    onChange={(e) =>
                      setPaymentStatus(e.target.value === "completed_pending" ? "pending" : "paid")
                    }
                    disabled={busy}
                  >
                    <option value="completed_paid">Completed work · paid</option>
                    <option value="completed_pending">Completed work · payment pending</option>
                  </Select>
                ) : (
                  <div className="flex h-10 items-center rounded-xl border border-border bg-accent/20 px-3 text-sm text-foreground">
                    Completed work
                  </div>
                )}
              </label>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
