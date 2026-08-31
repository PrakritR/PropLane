"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Modal, MODAL_FIELD_LABEL_CLASS, ModalFooter } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { PortalFormSingleSelect } from "@/components/portal/filter-field-lists";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { PortalNotificationPreviewModal } from "@/components/portal/portal-notification-preview-modal";
import { RentalApplicationWizard } from "@/components/marketing/rental-application-wizard";
import { APPLICATION_STARTED_EMAIL_SUBJECT } from "@/lib/application-started-email";
import { applicationVisibleToPortalUser } from "@/lib/manager-portfolio-access";
import {
  MANAGER_APPLICATIONS_EVENT,
  readManagerApplicationRows,
  syncManagerApplicationsFromServer,
} from "@/lib/manager-applications-storage";
import { isCurrentResidentApplicationRow } from "@/lib/current-resident";
import {
  PROPERTY_PIPELINE_EVENT,
  readExtraListingsForUser,
  readPendingManagerPropertiesForUser,
  syncPropertyPipelineFromServer,
} from "@/lib/demo-property-pipeline";
import {
  clearRentalWizardDraft,
  saveRentalWizardDraft,
  saveRentalWizardDraftAxisId,
} from "@/lib/rental-application/drafts";
import {
  findInProgressRowForTarget,
  isInProgressApplicationRow,
  mintApplicationAxisId,
  syncInProgressApplicationRow,
} from "@/lib/rental-application/in-progress-application";
import { createInitialRentalWizardState } from "@/lib/rental-application/state";
import { PropertyResidentDocumentImportModal } from "@/components/portal/property-resident-document-import-modal";
import type { ParsedResidentDocument } from "@/lib/resident-document-import/types";
import {
  parseResidentDocumentPdfClient,
  parsedFieldsToRecord,
  readDataUrlFromFile,
} from "@/lib/resident-document-import.client";

const NEW_RESIDENT_ID = "__new_resident__";

function displayPropertyLabel(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  return trimmed
    .split(" · ")[0]!
    .replace(/\s*·\s*[^·]*::[^·]*$/i, "")
    .replace(/\s+[.-]\s+[^\s]+::[^\s]+$/i, "")
    .trim();
}

type PropertyOption = { propertyId: string; propertyLabel: string };

function buildManagerPropertyOptions(managerUserId: string | null): PropertyOption[] {
  if (!managerUserId) return [];
  const seen = new Map<string, PropertyOption>();
  for (const property of readExtraListingsForUser(managerUserId)) {
    const propertyId = property.id.trim();
    if (!propertyId || seen.has(propertyId)) continue;
    const propertyLabel = displayPropertyLabel((property.buildingName ?? "").trim() || property.title || "");
    if (!propertyLabel) continue;
    seen.set(propertyId, { propertyId, propertyLabel });
  }
  for (const property of readPendingManagerPropertiesForUser(managerUserId)) {
    const propertyId = property.id.trim();
    if (!propertyId || seen.has(propertyId)) continue;
    const propertyLabel = displayPropertyLabel((property.buildingName ?? "").trim() || "");
    if (!propertyLabel) continue;
    seen.set(propertyId, { propertyId, propertyLabel });
  }
  return [...seen.values()].sort((a, b) =>
    a.propertyLabel.localeCompare(b.propertyLabel, undefined, { sensitivity: "base" }),
  );
}

type ResidentOption = {
  id: string;
  residentName: string;
  residentEmail: string;
  propertyId: string;
  propertyLabel: string;
  hint?: string;
};

function residentBelongsToProperty(resident: ResidentOption, property: PropertyOption): boolean {
  if (resident.propertyId && resident.propertyId === property.propertyId) return true;
  return resident.propertyLabel.toLowerCase() === property.propertyLabel.toLowerCase();
}

function buildResidentOptions(managerUserId: string | null): ResidentOption[] {
  const seen = new Map<string, ResidentOption>();
  for (const row of readManagerApplicationRows()) {
    if (!applicationVisibleToPortalUser(row, managerUserId)) continue;
    if (!row.email?.trim().includes("@") || !row.name?.trim()) continue;
    if (!isCurrentResidentApplicationRow(row) && !isInProgressApplicationRow(row)) continue;

    const propertyLabel = displayPropertyLabel(row.property?.trim() || "");
    const propertyId =
      row.assignedPropertyId?.trim() ||
      row.propertyId?.trim() ||
      row.application?.propertyId?.trim() ||
      (propertyLabel ? `prop_mgr_${propertyLabel.toLowerCase().replace(/[^a-z0-9]+/g, "_")}` : "");
    const email = row.email.trim().toLowerCase();
    const key = `${propertyId}::${email}`;
    if (seen.has(key)) continue;
    seen.set(key, {
      id: row.id,
      residentName: row.name.trim(),
      residentEmail: email,
      propertyId,
      propertyLabel: propertyLabel || "Property",
      hint: isInProgressApplicationRow(row) ? "In progress" : undefined,
    });
  }
  return [...seen.values()].sort((a, b) => {
    const byProperty = a.propertyLabel.localeCompare(b.propertyLabel, undefined, { sensitivity: "base" });
    if (byProperty !== 0) return byProperty;
    return a.residentName.localeCompare(b.residentName, undefined, { sensitivity: "base" });
  });
}

function initManagerApplicationDraft(input: {
  propertyId: string;
  residentEmail?: string;
  residentName?: string;
  managerUserId: string | null;
}): string {
  const email = input.residentEmail?.trim().toLowerCase() ?? "";
  if (email.includes("@")) {
    const inProgress = readManagerApplicationRows().filter(
      (row) =>
        isInProgressApplicationRow(row) &&
        row.email?.trim().toLowerCase() === email,
    );
    const existing = findInProgressRowForTarget(inProgress, { propertyId: input.propertyId });

    if (existing?.application) {
      clearRentalWizardDraft();
      saveRentalWizardDraftAxisId(existing.id);
      const form = {
        ...createInitialRentalWizardState(),
        ...existing.application,
        propertyId: input.propertyId,
        email,
        fullLegalName: existing.application.fullLegalName?.trim() || existing.name?.trim() || input.residentName?.trim() || "",
      };
      saveRentalWizardDraft(form);
      return existing.id;
    }
  }

  clearRentalWizardDraft();
  const axisId = mintApplicationAxisId();
  saveRentalWizardDraftAxisId(axisId);
  const form = {
    ...createInitialRentalWizardState(),
    propertyId: input.propertyId,
    email,
    fullLegalName: input.residentName?.trim() || "",
  };
  saveRentalWizardDraft(form);
  if (email.includes("@")) {
    syncInProgressApplicationRow({
      axisId,
      form,
      residentEmail: email,
      wizardStep: 1,
      wizardMaxStepReached: 1,
    });
  }
  return axisId;
}

export function ManagerApplicationOnBehalfModal({
  open,
  onClose,
  onSubmitted,
  managerUserId,
  basePath = "/portal",
}: {
  open: boolean;
  onClose: () => void;
  onSubmitted: () => void;
  managerUserId: string | null;
  basePath?: string;
}) {
  const { showToast } = useAppUi();
  const [applicationTick, setApplicationTick] = useState(0);
  const [propertyTick, setPropertyTick] = useState(0);
  const [phase, setPhase] = useState<"pick" | "wizard" | "send">("pick");
  const [propertyId, setPropertyId] = useState("");
  const [residentId, setResidentId] = useState("");
  const [activeAxisId, setActiveAxisId] = useState<string | null>(null);
  const [activeEmail, setActiveEmail] = useState("");
  const [activeName, setActiveName] = useState("");
  const [sendPreview, setSendPreview] = useState<{ to: string; subject: string; text: string } | null>(null);
  const [sendBusy, setSendBusy] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [importPdfOpen, setImportPdfOpen] = useState(false);
  const [importPdfBootstrap, setImportPdfBootstrap] = useState<{
    parse: ParsedResidentDocument;
    file: File;
    dataUrl: string;
  } | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);

  const reset = useCallback(() => {
    setPhase("pick");
    setPropertyId("");
    setResidentId("");
    setActiveAxisId(null);
    setActiveEmail("");
    setActiveName("");
    setSendPreview(null);
    setSendBusy(false);
    setPreviewBusy(false);
    setUploadBusy(false);
    setImportPdfOpen(false);
    setImportPdfBootstrap(null);
    clearRentalWizardDraft();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onApplications = () => setApplicationTick((n) => n + 1);
    const onProperties = () => setPropertyTick((n) => n + 1);
    void syncManagerApplicationsFromServer({ force: true, managerUserId: managerUserId ?? undefined }).then(onApplications);
    void syncPropertyPipelineFromServer({ force: true }).then(onProperties);
    window.addEventListener(MANAGER_APPLICATIONS_EVENT, onApplications);
    window.addEventListener(PROPERTY_PIPELINE_EVENT, onProperties);
    return () => {
      window.removeEventListener(MANAGER_APPLICATIONS_EVENT, onApplications);
      window.removeEventListener(PROPERTY_PIPELINE_EVENT, onProperties);
    };
  }, [open, managerUserId]);

  useEffect(() => {
    if (!open) reset();
  }, [open, reset]);

  const propertyOptions = useMemo(() => {
    void propertyTick;
    return buildManagerPropertyOptions(managerUserId);
  }, [managerUserId, propertyTick]);

  const residentOptions = useMemo(() => {
    void applicationTick;
    return buildResidentOptions(managerUserId);
  }, [applicationTick, managerUserId]);

  const selectedProperty = useMemo(
    () => propertyOptions.find((row) => row.propertyId === propertyId) ?? null,
    [propertyId, propertyOptions],
  );

  const residentsForProperty = useMemo(() => {
    if (!selectedProperty) return [];
    return residentOptions.filter((row) => residentBelongsToProperty(row, selectedProperty));
  }, [residentOptions, selectedProperty]);

  const selectedResident = useMemo(
    () => residentsForProperty.find((row) => row.id === residentId) ?? null,
    [residentId, residentsForProperty],
  );

  const resolvedEmail = selectedResident?.residentEmail ?? "";
  const resolvedName = selectedResident?.residentName ?? "";

  const canStartWizard = Boolean(propertyId && residentId);
  const canUploadPdf = Boolean(propertyId);
  const forcedExistingApplicationId =
    residentId && residentId !== NEW_RESIDENT_ID ? residentId : undefined;

  const handleClose = () => {
    reset();
    onClose();
  };

  async function handleApplicationPdfChosen(file: File) {
    if (!propertyId) {
      showToast("Select a property first.");
      return;
    }
    if (file.type !== "application/pdf") {
      showToast("Please choose a PDF file.");
      return;
    }
    if (file.size > 3.5 * 1024 * 1024) {
      showToast("PDF too large (max 3.5 MB).");
      return;
    }
    setUploadBusy(true);
    try {
      const dataUrl = await readDataUrlFromFile(file);
      const parsed = await parseResidentDocumentPdfClient({
        dataUrl,
        fileName: file.name,
        kind: "application",
        propertyId,
      });
      const fields = parsedFieldsToRecord(parsed.fields);
      if (selectedResident && residentId !== NEW_RESIDENT_ID) {
        if (!fields.tenantName?.trim()) fields.tenantName = selectedResident.residentName;
        if (!fields.tenantEmail?.trim()) fields.tenantEmail = selectedResident.residentEmail;
        parsed.fields = Object.entries(fields).map(([key, value]) => {
          const existing = parsed.fields.find((field) => field.key === key);
          return existing
            ? { ...existing, value }
            : { key, label: key, value, confidence: "high" as const, source: "deterministic" as const };
        });
      }
      setImportPdfBootstrap({ parse: parsed, file, dataUrl });
      setImportPdfOpen(true);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Could not read application PDF.");
    } finally {
      setUploadBusy(false);
      if (uploadRef.current) uploadRef.current.value = "";
    }
  }

  const startWizard = () => {
    if (!canStartWizard) {
      showToast("Select a property and resident.");
      return;
    }
    const axisId = initManagerApplicationDraft({
      propertyId,
      residentEmail: resolvedEmail,
      residentName: resolvedName,
      managerUserId,
    });
    setActiveAxisId(axisId);
    setActiveEmail(resolvedEmail);
    setActiveName(resolvedName);
    setPhase("wizard");
    onSubmitted();
  };

  const openSendPreview = async (axisId: string) => {
    setPreviewBusy(true);
    try {
      const res = await fetch("/api/portal/send-manager-application-started", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ applicationId: axisId, preview: true }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        preview?: { to?: string; subject?: string; text?: string };
      };
      if (!res.ok || !data.ok || !data.preview) {
        showToast(data.error ?? "Could not load the email preview.");
        return;
      }
      setSendPreview({
        to: data.preview.to ?? resolvedEmail,
        subject: data.preview.subject ?? APPLICATION_STARTED_EMAIL_SUBJECT,
        text: data.preview.text ?? "",
      });
      setActiveAxisId(axisId);
      setPhase("send");
    } catch {
      showToast("Could not load the email preview.");
    } finally {
      setPreviewBusy(false);
    }
  };

  const sendToResident = async () => {
    if (!activeAxisId) return;
    setSendBusy(true);
    try {
      const res = await fetch("/api/portal/send-manager-application-started", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ applicationId: activeAxisId }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; skipped?: boolean };
      if (!res.ok || !data.ok) {
        showToast(data.error ?? "Could not send the application email.");
        return;
      }
      showToast(data.skipped ? "Sandbox account — email skipped." : "Application email sent to resident.");
      onSubmitted();
      handleClose();
    } catch {
      showToast("Could not send the application email.");
    } finally {
      setSendBusy(false);
    }
  };

  const noProperties = propertyOptions.length === 0;

  const propertySelectOptions = useMemo(
    () => propertyOptions.map((option) => ({ value: option.propertyId, label: option.propertyLabel })),
    [propertyOptions],
  );

  const residentSelectOptions = useMemo(() => {
    const rows = residentsForProperty.map((row) => ({
      value: row.id,
      label: row.hint ? `${row.residentName} · ${row.hint}` : row.residentName,
    }));
    return [{ value: NEW_RESIDENT_ID, label: "New resident…" }, ...rows];
  }, [residentsForProperty]);

  return (
    <>
      <Modal
        open={open && phase === "pick"}
        onClose={handleClose}
        title="Add application"
        description="Choose a property and resident, then upload an application PDF or fill one out manually."
        dataAttr="manager-add-application-modal"
        footer={
          <ModalFooter>
            <Button
              type="button"
              variant="outline"
              data-attr="add-application-manual"
              disabled={!canStartWizard || uploadBusy}
              onClick={startWizard}
            >
              Fill out manually
            </Button>
            <Button
              type="button"
              variant="primary"
              data-attr="add-application-upload"
              disabled={!canUploadPdf || uploadBusy}
              onClick={() => uploadRef.current?.click()}
            >
              {uploadBusy ? "Reading PDF…" : "Upload application PDF"}
            </Button>
          </ModalFooter>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <PortalFormSingleSelect
              label="Property"
              labelClassName={MODAL_FIELD_LABEL_CLASS}
              value={propertyId}
              onChange={(next) => {
                setPropertyId(next);
                setResidentId("");
              }}
              options={propertySelectOptions}
              placeholder={noProperties ? "No properties in portfolio" : "Select property"}
              disabled={noProperties}
              dataAttr="add-application-property"
            />
          </div>
          <div className="sm:col-span-2">
            <PortalFormSingleSelect
              label="Resident"
              labelClassName={MODAL_FIELD_LABEL_CLASS}
              value={residentId}
              onChange={setResidentId}
              options={residentSelectOptions}
              placeholder={
                !propertyId ? "Select property first" : "Select resident"
              }
              disabled={!propertyId}
              dataAttr="add-application-resident"
            />
          </div>
        </div>
      </Modal>

      <input
        ref={uploadRef}
        type="file"
        accept="application/pdf"
        className="sr-only"
        aria-hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void handleApplicationPdfChosen(file);
        }}
      />

      {importPdfOpen && selectedProperty ? (
        <PropertyResidentDocumentImportModal
          open
          kind="application"
          propertyId={propertyId}
          propertyLabel={selectedProperty.propertyLabel}
          managerUserId={managerUserId}
          initialPdf={importPdfBootstrap}
          forcedExistingApplicationId={forcedExistingApplicationId}
          showToast={showToast}
          onClose={() => {
            setImportPdfOpen(false);
            setImportPdfBootstrap(null);
          }}
          onImported={() => {
            onSubmitted();
            handleClose();
          }}
        />
      ) : null}

      <Modal
        open={open && phase === "wizard"}
        onClose={handleClose}
        title={activeName ? `Application for ${activeName}` : "Application"}
        description="Complete the application, then send it to the resident to review and finish."
        panelClassName="flex max-h-[min(90vh,56rem)] w-full max-w-5xl flex-col max-lg:!h-[100dvh] max-lg:!max-h-[100dvh]"
        dataAttr="manager-application-on-behalf-wizard"
      >
        {phase === "wizard" && activeAxisId ? (
          <RentalApplicationWizard
            showToast={showToast}
            mode="manager"
            layout="embedded"
            linkedPropertyId={propertyId}
            sessionEmail={activeEmail}
            exitPath={`${basePath}/applications/incomplete`}
            onManagerSendToResident={({ axisId }) => {
              void openSendPreview(axisId);
            }}
            onManagerCancel={handleClose}
            managerActionBusy={previewBusy}
          />
        ) : null}
      </Modal>

      <PortalNotificationPreviewModal
        open={phase === "send" && sendPreview !== null}
        title="Send application to resident"
        onClose={() => {
          setSendPreview(null);
          setPhase("wizard");
        }}
        recipient={sendPreview?.to ?? ""}
        subject={sendPreview?.subject ?? APPLICATION_STARTED_EMAIL_SUBJECT}
        body={sendPreview?.text ?? ""}
        intro="The resident can continue the application and create their PropLane account from this email."
        showSkipMessage={false}
        confirmLabel="Send email"
        confirmBusy={sendBusy}
        confirmBusyLabel="Sending…"
        onConfirm={() => void sendToResident()}
      />
    </>
  );
}
