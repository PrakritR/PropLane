"use client";

import { useEffect, useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { AddWorkspace, type AddWorkspaceStep } from "@/components/portal/add-workspace";
import { PreviewPanel, WizardField, WizardSelect } from "@/components/portal/add-workspace/parts";
import { StepColumn, StepHeading } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import { useAppUi } from "@/components/providers/app-ui-provider";
import type { ManagerServiceResidentOption } from "@/components/portal/pro-create-service-request-modal";
import {
  createEmptyServiceIntakeFormState,
  ServiceIntakeFormFields,
  ServiceIntakePhotoPicker,
  type ServiceIntakeFormState,
} from "@/components/portal/service-intake-form-fields";
import { useWorkAssignmentDirectory } from "@/hooks/use-work-assignment-directory";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { isCurrentResidentApplicationRow } from "@/lib/current-resident";
import {
  MANAGER_APPLICATIONS_EVENT,
  readManagerApplicationRows,
  syncManagerApplicationsFromServer,
} from "@/lib/manager-applications-storage";
import {
  applicationVisibleToPortalUser,
  buildManagerPropertyFilterOptions,
} from "@/lib/manager-portfolio-access";
import {
  PROPERTY_PIPELINE_EVENT,
  syncPropertyPipelineFromServer,
} from "@/lib/demo-property-pipeline";
import { WORKSPACE_SELECTION_EVENT } from "@/lib/workspaces/selection";
import {
  normalizeManagerListingSubmissionV1,
  resolveServiceOfferPricing,
  type ManagerListingServiceOption,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import { getPropertyById, getRoomChoiceLabel } from "@/lib/rental-application/data";
import { emptyRoomsForManagerService, roomLabelForManagerService } from "@/lib/manager-add-service-where";
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
import { ServiceTasksField } from "@/components/portal/service-tasks-field";
import { buildServiceAssignmentMessage } from "@/lib/service-assignment-message";
import { parseResidentChargeCents } from "@/lib/service-tasks";
import { createManagerCharge } from "@/lib/household-charges";

/** Who the assignment message goes to, resolved from the directory the picker used. */
type AssigneeContact = { name: string; email: string; phone?: string };

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
  return buildManagerPropertyFilterOptions(managerUserId)
    .map((option) => {
      const propertyLabel = displayPropertyLabel(option.label);
      return propertyLabel ? { propertyId: option.id, propertyLabel } : null;
    })
    .filter((row): row is PropertyOption => row !== null);
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
  const [roomChoice, setRoomChoice] = useState("");
  const [residentEmail, setResidentEmail] = useState("");
  const [addTask, setAddTask] = useState(false);
  const [assignee, setAssignee] = useState<WorkAssignee | null>(null);
  const [requestPrice, setRequestPrice] = useState("");
  const [requestDeposit, setRequestDeposit] = useState("");
  const [photos, setPhotos] = useState<string[]>([]);
  const [residentCharge, setResidentCharge] = useState("");
  const [stepIdx, setStepIdx] = useState(0);
  const [stepError, setStepError] = useState<string | null>(null);
  const [form, setForm] = useState<ServiceIntakeFormState>({
    optionKey: "repair:General",
    title: "",
    description: "",
    categoryLabel: "General",
    priority: "Medium",
    customPriceLimit: "",
    arrivalPreset: "Anytime",
    arrivalCustom: "",
    // The manager is logging this, not the resident — vendors are never told
    // to "call me first" on the resident's behalf.
    entryPermission: "allowed",
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
    window.addEventListener(WORKSPACE_SELECTION_EVENT, onProps);
    return () => {
      window.removeEventListener(PROPERTY_PIPELINE_EVENT, onProps);
      window.removeEventListener(MANAGER_APPLICATIONS_EVENT, onApps);
      window.removeEventListener(WORKSPACE_SELECTION_EVENT, onProps);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    queueMicrotask(() => {
      if (defaultResident) {
        setPropertyId(defaultResident.propertyId.trim());
        setResidentEmail(defaultResident.residentEmail.trim().toLowerCase());
        setRoomChoice(defaultResident.assignedRoomChoice?.trim() || "");
      } else {
        setPropertyId(defaultPropertyId?.trim() || "");
        setResidentEmail("");
        setRoomChoice("");
      }
      setAddTask(false);
      setAssignee(null);
      setRequestPrice("");
      setRequestDeposit("");
      setPhotos([]);
      setResidentCharge("");
      setForm({ ...createEmptyServiceIntakeFormState([]), entryPermission: "allowed" });
      setStepIdx(0);
      setStepError(null);
    });
  }, [open, defaultPropertyId, defaultResident]);

  /**
   * The assignment message goes to a vendor, or a teammate who is not the
   * manager logging the service. Assigning yourself sends nothing.
   */
  const assigneeContact = (next: WorkAssignee | null): AssigneeContact | null => {
    if (!next) return null;
    if (next.type === "team") {
      if (next.id === managerUserId) return null;
      const member = teamMembers.find((row) => row.userId === next.id);
      const email = member?.email?.trim() ?? "";
      return email.includes("@") ? { name: member?.name?.trim() || next.name, email } : null;
    }
    const vendor = (vendors as ReadonlyArray<{ id: string; name?: string | null; email?: string | null; phone?: string | null }>).find(
      (row) => row.id === next.id,
    );
    const email = vendor?.email?.trim() ?? "";
    if (!email.includes("@")) return null;
    return { name: vendor?.name?.trim() || next.name, email, phone: vendor?.phone?.trim() || undefined };
  };

  /**
   * After the service is saved: message the assignee immediately. Assigning
   * yourself still sends nothing. Unchecked Add task or Unassigned skips this.
   */
  const finishWithAssignment = async (ctx: {
    kind: "maintenance" | "add-on";
    title: string;
    description: string;
    priority?: string | null;
    residentName?: string | null;
    roomLabel?: string | null;
    assigned: WorkAssignee | null;
  }) => {
    const contact = assigneeContact(ctx.assigned);
    onClose();
    if (!contact || !selectedProperty) return;
    const managerName =
      teamMembers.find((row) => row.userId === managerUserId)?.name?.trim() || "Your property manager";
    const message = buildServiceAssignmentMessage({
      assigneeName: contact.name,
      managerName,
      kind: ctx.kind,
      title: ctx.title,
      description: ctx.description,
      propertyLabel: selectedProperty.propertyLabel,
      roomLabel: ctx.roomLabel,
      priority: ctx.priority,
      residentName: ctx.residentName,
    });
    const sent = await deliverPortalInboxMessage({
      eventCategory: "maintenance",
      fromName: managerName,
      toEmails: [contact.email],
      subject: message.subject,
      text: message.body,
      deliverViaEmail: true,
      deliverViaSms: Boolean(contact.phone),
    });
    showToast(sent.ok ? `Sent to ${contact.name}.` : `Service saved, but the message to ${contact.name} could not be sent.`);
  };

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

  // Plain derivation — the React Compiler memoizes it; a manual useMemo here
  // listed `lockedResident` while reading `lockedResident?.propertyId`, which
  // the compiler refuses to preserve.
  const selectedProperty: PropertyOption | null = lockedResident?.propertyId
    ? propertyOptions.find((p) => p.propertyId === lockedResident.propertyId) ?? {
        propertyId: lockedResident.propertyId,
        propertyLabel: lockedResident.propertyLabel,
      }
    : propertyOptions.find((p) => p.propertyId === propertyId) ?? null;

  const residentsForProperty = useMemo(() => {
    const property = propertyOptions.find((p) => p.propertyId === propertyId);
    if (!property) return residentOptions;
    return residentOptions.filter((r) => residentMatchesProperty(r, property));
  }, [propertyId, propertyOptions, residentOptions]);

  const roomOptions = useMemo(() => {
    void tick;
    if (!propertyId) return [];
    return emptyRoomsForManagerService(propertyId, roomChoice || selectedResident?.assignedRoomChoice);
  }, [propertyId, roomChoice, selectedResident?.assignedRoomChoice, tick]);

  const roomLabel = roomLabelForManagerService(roomChoice) || selectedResident?.roomLabel || "";
  const activeAssignee = addTask ? assignee : null;

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
  const selectedIntakeKind = findServiceIntakeOption(intakeOptions, form.optionKey)?.kind ?? "repair";

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

    const option = findServiceIntakeOption(intakeOptions, form.optionKey);
    if (!option) {
      showToast("Choose a service type.");
      return;
    }

    setBusy(true);
    try {
      const assigned = addTask ? assignee : null;
      const assignedRoom = roomChoice || selectedResident?.assignedRoomChoice;
      if (option.kind === "repair") {
        const title = serviceIntakeSuggestedTitle(option, form.categoryLabel);
        if (!title) {
          showToast("Choose a maintenance category.");
          return;
        }
        if (!form.description.trim()) {
          showToast("Add a description.");
          return;
        }
        const chargeCents = parseResidentChargeCents(residentCharge);
        if (residentCharge.trim() && chargeCents === null) {
          showToast("Resident charge must be an amount like $80.");
          return;
        }
        if (chargeCents !== null && !selectedResident) {
          showToast("Choose a resident to add a charge.");
          return;
        }
        const id = `REQ-${Date.now()}`;
        // A resident charge is a real household charge, created through the
        // same helper the Payments tab uses, and remembered on the service.
        const charge =
          chargeCents !== null && selectedResident
            ? createManagerCharge({
                residentEmail: selectedResident.residentEmail,
                residentName: selectedResident.residentName,
                propertyId,
                propertyLabel: selectedProperty.propertyLabel,
                managerUserId,
                title: `Service: ${title}`,
                amount: chargeCents / 100,
              })
            : null;
        if (chargeCents !== null && !charge) {
          showToast("Could not add the resident charge. Check the amount.");
          return;
        }
        const row: DemoManagerWorkOrderRow = {
          id,
          propertyName: selectedProperty.propertyLabel,
          propertyId,
          assignedPropertyId: propertyId,
          assignedRoomChoice: assignedRoom,
          managerUserId,
          unit: roomLabel || "—",
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
          residentName: selectedResident?.residentName,
          residentEmail: selectedResident?.residentEmail,
          photoDataUrls: photos.length > 0 ? photos : undefined,
          managerInitiated: true,
          assignee: assigned ?? undefined,
          // The legacy dispatch pair is written beside `assignee` so the vendor
          // portal keeps reading what it always read (see the row type's note).
          ...(assigned?.type === "vendor"
            ? { vendorId: assigned.id, vendorName: assigned.name, vendorAssignedAt: new Date().toISOString(), selfAssigned: false }
            : assigned?.type === "team" && assigned.id === managerUserId
              ? { selfAssigned: true }
              : {}),
          residentChargeCents: chargeCents ?? undefined,
          residentChargeId: charge?.id,
        };
        writeManagerWorkOrderRows([row, ...readManagerWorkOrderRows()]);
        if (assigned) {
          void createScheduledWorkTask(managerUserId, {
            title: scheduledTaskTitleForService(title, selectedResident?.residentName),
            propertyId,
            propertyTitle: selectedProperty.propertyLabel,
            roomLabel: roomLabel || undefined,
            assignee: assigned,
            notes: form.description.trim() || undefined,
          });
        }
        if (selectedResident) {
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
            form.description.trim() ? `Details: ${form.description.trim()}` : "",
            chargeCents !== null ? `Charge: $${(chargeCents / 100).toFixed(2)} — see Payments.` : "",
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
        }
        if (!selectedResident) showToast("Service logged.");
        onSubmitted("open");
        await finishWithAssignment({
          kind: "maintenance",
          title,
          description: form.description.trim(),
          priority: form.priority,
          residentName: selectedResident?.residentName,
          roomLabel,
          assigned,
        });
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

      const customChargeCents = isCustom ? parseResidentChargeCents(residentCharge) : null;
      if (isCustom && residentCharge.trim() && customChargeCents === null) {
        showToast("Resident charge must be an amount like $80.");
        return;
      }
      if (isCustom && customChargeCents !== null && !selectedResident) {
        showToast("Choose a resident to add a charge.");
        return;
      }
      const { mirrored } = await createServiceRequest({
        offerId: isCustom ? CUSTOM_SERVICE_REQUEST_OFFER_ID : selectedOffer!.id,
        offerName: isCustom ? form.title.trim() : selectedOffer!.name,
        offerDescription: isCustom ? form.description.trim() : selectedOffer!.description,
        // A custom request the manager prices on the spot carries that price
        // like a catalog service does; its pending charge follows the same path.
        price: isCustom ? (customChargeCents !== null ? `$${(customChargeCents / 100).toFixed(2)}` : "") : requestPrice.trim(),
        deposit: isCustom ? "" : requestDeposit.trim(),
        residentEmail: selectedResident?.residentEmail ?? "",
        residentName: selectedResident?.residentName ?? "",
        managerUserId,
        propertyId,
        returnByDate: "",
        notes: form.description.trim(),
        assignee: assigned ?? undefined,
      });
      if (!mirrored.ok) {
        showToast(mirrored.error || "Could not save service. Try again.");
        return;
      }
      const taskTitle = isCustom ? form.title.trim() : selectedOffer!.name;
      if (assigned) {
        void createScheduledWorkTask(managerUserId, {
          title: scheduledTaskTitleForService(taskTitle, selectedResident?.residentName),
          propertyId,
          propertyTitle: selectedProperty.propertyLabel,
          roomLabel: roomLabel || undefined,
          assignee: assigned,
          notes: form.description.trim() || undefined,
        });
      }
      showToast(selectedResident ? `${taskTitle} created for ${selectedResident.residentName}.` : `${taskTitle} created.`);
      onSubmitted();
      await finishWithAssignment({
        kind: "add-on",
        title: taskTitle,
        description: form.description.trim(),
        residentName: selectedResident?.residentName,
        roomLabel,
        assigned,
      });
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  const serviceTitle =
    form.title.trim() ||
    selectedOffer?.name ||
    (selectedIntakeKind === "repair" ? serviceIntakeSuggestedTitle(findServiceIntakeOption(intakeOptions, form.optionKey), form.categoryLabel) : "") ||
    "Service";
  const whereIncomplete = !selectedProperty;
  const whatIncomplete = !form.optionKey;
  const steps: AddWorkspaceStep[] = [
    {
      id: "where",
      label: "Where",
      summary: whereIncomplete
        ? "Property"
        : [selectedProperty?.propertyLabel, roomLabel, selectedResident?.residentName].filter(Boolean).join(" · "),
      incomplete: whereIncomplete,
    },
    {
      id: "what",
      label: "What",
      summary: whatIncomplete ? "Service" : serviceTitle,
      incomplete: whatIncomplete,
    },
    { id: "review", label: "Review", summary: "Ready" },
  ];
  const current = Math.min(stepIdx, steps.length - 1);
  const stepId = steps[current]!.id;

  return (
    <AddWorkspace
      title="Add service"
      steps={steps}
      current={current}
      onJump={(index) => {
        setStepError(null);
        setStepIdx(index);
      }}
      onClose={onClose}
      dirty={Boolean(propertyId || roomChoice || residentEmail || addTask || form.description.trim() || photos.length)}
      discardTitle="Discard this service?"
      assistantContext="Log a service. Assignment messages send when you assign someone."
      assistantScopeKey="Add service"
      sidePanel={
        <PreviewPanel
          title="Service"
          name={serviceTitle}
          facts={[
            { label: "Property", value: selectedProperty?.propertyLabel ?? "—", warn: !selectedProperty },
            { label: "Room", value: roomLabel || "—" },
            { label: "Resident", value: selectedResident?.residentName ?? "—" },
            { label: "Priority", value: form.priority },
          ]}
          creates={[
            { tone: "yes", text: selectedResident ? `Logged service for ${selectedResident.residentName}` : "Logged service" },
            activeAssignee
              ? { tone: "yes", text: `Assignment message to ${activeAssignee.name}` }
              : { tone: "no", text: "No assignment message until you assign" },
          ]}
        />
      }
      lastLabel={busy ? "Saving…" : "Add service"}
      lastDisabled={busy || whereIncomplete}
      nextDisabled={(stepId === "where" && whereIncomplete) || (stepId === "what" && whatIncomplete)}
      onBeforeNext={() => {
        if (stepId === "where" && whereIncomplete) {
          setStepError(propertyOptions.length === 0 ? "Add a property first." : "Select a property.");
          return false;
        }
        if (stepId === "what" && whatIncomplete) {
          setStepError("Choose a service type.");
          return false;
        }
        setStepError(null);
        return true;
      }}
      busy={busy}
      onFinish={() => void submit()}
      dataAttrPrefix="manager-add-service"
      finishDataAttr="manager-add-service-save"
      footerNote={stepError ? <span className="text-sm text-rose-600">{stepError}</span> : null}
    >
      {stepId === "where" ? (
        <StepColumn>
          <StepHeading title="Where" />
          {propertyOptions.length === 0 ? (
            <div className="flex min-h-40 flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border px-4 py-8">
              <p className="text-[16px] font-bold">No properties</p>
            </div>
          ) : lockedResident ? (
            <>
              <div className="rounded-2xl border border-border bg-card px-4 py-3">
                <p className="text-[15px] font-bold text-foreground">
                  {lockedResident.residentName}
                  {lockedResident.roomLabel ? ` · ${lockedResident.roomLabel}` : ""}
                </p>
                <p className="mt-1 text-[13px] font-semibold text-foreground">{lockedResident.propertyLabel}</p>
              </div>
              <WizardSelect
                label="Room"
                value={roomChoice}
                onChange={setRoomChoice}
                options={[{ value: "", label: "None" }, ...roomOptions]}
                placeholder={roomOptions.length === 0 ? "No empty rooms" : "Optional"}
                disabled={busy}
                dataAttr="manager-service-intake-room"
              />
            </>
          ) : (
            <>
              <WizardSelect
                label="Property"
                value={propertyId}
                onChange={(value) => {
                  setPropertyId(value);
                  setResidentEmail("");
                  setRoomChoice("");
                }}
                options={propertyOptions.map((property) => ({
                  value: property.propertyId,
                  label: property.propertyLabel,
                }))}
                placeholder="Select property"
                dataAttr="manager-service-intake-property"
                disabled={busy}
              />
              <WizardSelect
                label="Room"
                value={roomChoice}
                onChange={setRoomChoice}
                options={[{ value: "", label: "None" }, ...roomOptions]}
                placeholder={!propertyId ? "Select property first" : roomOptions.length === 0 ? "No empty rooms" : "Optional"}
                disabled={busy || !propertyId}
                dataAttr="manager-service-intake-room"
              />
              <WizardSelect
                label="Resident"
                value={residentEmail}
                onChange={(value) => {
                  setResidentEmail(value);
                  const resident = residentsForProperty.find((row) => row.residentEmail === value);
                  if (resident?.assignedRoomChoice && !roomChoice) {
                    setRoomChoice(resident.assignedRoomChoice);
                  }
                }}
                options={[
                  { value: "", label: "None" },
                  ...residentsForProperty.map((resident) => ({
                    value: resident.residentEmail,
                    label: resident.roomLabel ? `${resident.residentName} · ${resident.roomLabel}` : resident.residentName,
                  })),
                ]}
                placeholder={!propertyId ? "Select property first" : residentsForProperty.length === 0 ? "No residents at this property" : "Optional"}
                disabled={busy || !propertyId}
                dataAttr="manager-service-intake-resident"
              />
            </>
          )}
        </StepColumn>
      ) : null}
      {stepId === "what" ? (
        <StepColumn>
          <StepHeading title="Service" />
          <ServiceIntakeFormFields
            catalogOffers={offersForProperty}
            form={form}
            onChange={(patch) => setForm((current) => ({ ...current, ...patch }))}
            disabled={busy}
            voice="manager"
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
          <ServiceTasksField
            enabled={addTask}
            onEnabledChange={setAddTask}
            assignee={assignee}
            onAssigneeChange={setAssignee}
            teamMembers={teamMembers}
            vendors={vendors}
            disabled={busy}
            dataAttr="manager-add-service-task"
          />
          {selectedOffer ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <WizardField label="Price">
                <Input value={requestPrice} onChange={(e) => setRequestPrice(e.target.value)} className="bg-card" />
              </WizardField>
              <WizardField label="Deposit">
                <Input value={requestDeposit} onChange={(e) => setRequestDeposit(e.target.value)} className="bg-card" />
              </WizardField>
            </div>
          ) : (
            <WizardField label="Resident charge">
              <Input
                value={residentCharge}
                onChange={(e) => setResidentCharge(e.target.value)}
                inputMode="decimal"
                className="bg-card"
                disabled={busy}
                data-attr="manager-add-service-resident-charge"
              />
            </WizardField>
          )}
        </StepColumn>
      ) : null}
      {stepId === "review" ? (
        <StepColumn>
          <StepHeading title="Review" />
          <PreviewPanel
            title="Service"
            name={serviceTitle}
            facts={[
              { label: "Property", value: selectedProperty?.propertyLabel ?? "—" },
              { label: "Room", value: roomLabel || "—" },
              { label: "Resident", value: selectedResident?.residentName ?? "—" },
              { label: "Priority", value: form.priority },
              { label: "Assignee", value: activeAssignee?.name ?? "—" },
            ]}
            creates={[{ tone: "yes", text: "Logs a manager-initiated service" }]}
          />
        </StepColumn>
      ) : null}
    </AddWorkspace>
  );
}
