"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { AddWorkspace, type AddWorkspaceStep } from "@/components/portal/add-workspace";
import { PreviewPanel, WizardSelect } from "@/components/portal/add-workspace/parts";
import { StepColumn, StepHeading } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { LeaseGenerateModal } from "@/components/portal/lease-generate-modal";
import { UploadedLeaseReviewModal } from "@/components/portal/uploaded-lease-review-modal";
import {
  applicationVisibleToPortalUser,
  collectLinkedPropertyIdsForModule,
  resolvePropertyLabelForId,
  syncManagerPortfolioFromServer,
} from "@/lib/manager-portfolio-access";
import {
  MANAGER_APPLICATIONS_EVENT,
  readManagerApplicationRows,
  syncManagerApplicationsFromServer,
} from "@/lib/manager-applications-storage";
import {
  confirmUploadedLeaseParse,
  ensureManagerReviewLeaseForApplication,
  leaseAllowsManagerDocumentEdits,
  leaseGenerationSupportedForRow,
  readLeasePipeline,
  syncLeasePipelineFromServer,
  UPLOADED_LEASE_REVIEW_REQUIRED_MESSAGE,
} from "@/lib/lease-pipeline-storage";
import { retryUploadedLeaseParse, uploadAndParseLeasePdf } from "@/lib/uploaded-lease-parse.client";
import { getRoomChoiceLabel } from "@/lib/rental-application/data";
import type { UploadedLeaseFieldKey } from "@/lib/uploaded-lease-extraction";
import {
  PROPERTY_PIPELINE_EVENT,
  readExtraListingsForUser,
  readPendingManagerPropertiesForUser,
} from "@/lib/demo-property-pipeline";
import { PropertyResidentDocumentImportModal } from "@/components/portal/property-resident-document-import-modal";
import type { ParsedResidentDocument } from "@/lib/resident-document-import/types";
import {
  parseResidentDocumentPdfClient,
  readDataUrlFromFile,
} from "@/lib/resident-document-import.client";

const NEW_RESIDENT_ID = "__new_resident__";

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

type PropertyLeaseOption = {
  propertyId: string;
  propertyLabel: string;
};

function buildManagerPropertyOptions(managerUserId: string | null): PropertyLeaseOption[] {
  if (!managerUserId) return [];
  const seen = new Map<string, PropertyLeaseOption>();

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

  for (const propertyId of collectLinkedPropertyIdsForModule(managerUserId, "leases")) {
    if (!propertyId || seen.has(propertyId)) continue;
    const propertyLabel = displayPropertyLabel(resolvePropertyLabelForId(propertyId));
    if (!propertyLabel) continue;
    seen.set(propertyId, { propertyId, propertyLabel });
  }

  return [...seen.values()].sort((a, b) =>
    a.propertyLabel.localeCompare(b.propertyLabel, undefined, { sensitivity: "base" }),
  );
}

type ApprovedResidentOption = {
  applicationId: string;
  residentName: string;
  residentEmail: string;
  propertyId: string;
  propertyLabel: string;
  roomLabel: string;
};

function residentBelongsToProperty(resident: ApprovedResidentOption, property: PropertyLeaseOption): boolean {
  if (resident.propertyId && resident.propertyId === property.propertyId) return true;
  return resident.propertyLabel.toLowerCase() === property.propertyLabel.toLowerCase();
}

function buildApprovedResidentOptions(managerUserId: string | null): ApprovedResidentOption[] {
  return readManagerApplicationRows()
    .filter(
      (row) =>
        row.bucket === "approved" &&
        applicationVisibleToPortalUser(row, managerUserId) &&
        row.name?.trim() &&
        row.email?.trim().includes("@"),
    )
    .map((row) => {
      const propertyLabel = displayPropertyLabel(row.property?.trim() || "");
      const propertyId =
        row.assignedPropertyId?.trim() ||
        row.propertyId?.trim() ||
        (propertyLabel ? `prop_mgr_${propertyLabel.toLowerCase().replace(/[^a-z0-9]+/g, "_")}` : "");
      const roomLabel =
        getRoomChoiceLabel(row.assignedRoomChoice?.trim() || row.application?.roomChoice1?.trim() || "")
          .split(" · ")[0]
          ?.trim() ||
        row.manualResidentDetails?.roomNumber?.trim() ||
        "";
      return {
        applicationId: row.id,
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

export function ManagerAddLeaseModal({
  open,
  onClose,
  onSubmitted,
  managerUserId,
  initialApplicationId,
  initialPropertyId,
  onOpenLease,
}: {
  open: boolean;
  onClose: () => void;
  onSubmitted: () => void;
  managerUserId: string | null;
  initialApplicationId?: string;
  initialPropertyId?: string;
  onOpenLease?: (leaseId: string) => void;
}) {
  const { showToast } = useAppUi();
  const router = useRouter();
  const [applicationTick, setApplicationTick] = useState(0);
  const [propertyTick, setPropertyTick] = useState(0);
  const [propertyId, setPropertyId] = useState("");
  const [applicationId, setApplicationId] = useState("");
  const [busy, setBusy] = useState(false);
  const [stepIdx, setStepIdx] = useState(0);
  const [leaseMethod, setLeaseMethod] = useState<"generate" | "upload">("generate");
  const [stepError, setStepError] = useState<string | null>(null);
  const [generateLeaseRowId, setGenerateLeaseRowId] = useState<string | null>(null);
  const [importReviewLeaseId, setImportReviewLeaseId] = useState<string | null>(null);
  const [newResidentImportOpen, setNewResidentImportOpen] = useState(false);
  const [newResidentImportBootstrap, setNewResidentImportBootstrap] = useState<{
    parse: ParsedResidentDocument;
    file: File;
    dataUrl: string;
  } | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const onApplications = () => setApplicationTick((n) => n + 1);
    const onProperties = () => setPropertyTick((n) => n + 1);
    void syncManagerApplicationsFromServer({ force: true, managerUserId: managerUserId ?? undefined }).then(onApplications);
    void syncManagerPortfolioFromServer(managerUserId ?? "", { force: true }).then(onProperties);
    window.addEventListener(MANAGER_APPLICATIONS_EVENT, onApplications);
    window.addEventListener(PROPERTY_PIPELINE_EVENT, onProperties);
    return () => {
      window.removeEventListener(MANAGER_APPLICATIONS_EVENT, onApplications);
      window.removeEventListener(PROPERTY_PIPELINE_EVENT, onProperties);
    };
  }, [open, managerUserId]);

  const propertyOptions = useMemo(() => {
    void propertyTick;
    return buildManagerPropertyOptions(managerUserId);
  }, [managerUserId, propertyTick]);

  const residents = useMemo(() => {
    void applicationTick;
    return buildApprovedResidentOptions(managerUserId);
  }, [applicationTick, managerUserId]);

  const selectedProperty = useMemo(
    () => propertyOptions.find((row) => row.propertyId === propertyId) ?? null,
    [propertyId, propertyOptions],
  );

  const residentsForProperty = useMemo(() => {
    if (!selectedProperty) return [];
    return residents.filter((row) => residentBelongsToProperty(row, selectedProperty));
  }, [residents, selectedProperty]);

  const selectedResident = useMemo(
    () =>
      applicationId && applicationId !== NEW_RESIDENT_ID
        ? residents.find((row) => row.applicationId === applicationId) ?? null
        : null,
    [applicationId, residents],
  );

  const isNewResident = applicationId === NEW_RESIDENT_ID;
  const canGenerateLease = Boolean(applicationId && !isNewResident);
  const canUploadLease = Boolean(propertyId && (canGenerateLease || isNewResident));

  useEffect(() => {
    if (!open) return;
    setImportReviewLeaseId(null);
    setGenerateLeaseRowId(null);
    setNewResidentImportOpen(false);
    setNewResidentImportBootstrap(null);
    setStepIdx(0);
    setLeaseMethod("generate");
    setStepError(null);
    if (!initialApplicationId && !initialPropertyId) {
      setPropertyId("");
      setApplicationId("");
      return;
    }
    const resident = initialApplicationId
      ? residents.find((row) => row.applicationId === initialApplicationId)
      : null;
    if (resident) {
      setPropertyId(resident.propertyId);
      setApplicationId(resident.applicationId);
      return;
    }
    setPropertyId(initialPropertyId?.trim() || "");
    setApplicationId("");
  }, [open, initialApplicationId, initialPropertyId, residents]);

  function ensureLeaseRow(): { ok: true; rowId: string } | { ok: false } {
    if (!propertyId || !applicationId) {
      showToast("Select a property and resident.");
      return { ok: false };
    }
    const ensured = ensureManagerReviewLeaseForApplication(applicationId, managerUserId);
    if (!ensured.ok) {
      showToast(ensured.error);
      return { ok: false };
    }
    return { ok: true, rowId: ensured.row.id };
  }

  async function handleUpload(file: File) {
    if (isNewResident) {
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
      setBusy(true);
      try {
        const dataUrl = await readDataUrlFromFile(file);
        const parsed = await parseResidentDocumentPdfClient({
          dataUrl,
          fileName: file.name,
          kind: "lease",
          propertyId,
        });
        setNewResidentImportBootstrap({ parse: parsed, file, dataUrl });
        setNewResidentImportOpen(true);
      } catch (err) {
        showToast(err instanceof Error ? err.message : "Could not read lease PDF.");
      } finally {
        setBusy(false);
        if (uploadRef.current) uploadRef.current.value = "";
      }
      return;
    }

    const ensured = ensureLeaseRow();
    if (!ensured.ok) return;
    setBusy(true);
    const result = await uploadAndParseLeasePdf(ensured.rowId, file, managerUserId);
    setBusy(false);
    if (uploadRef.current) uploadRef.current.value = "";
    if (!result.ok) {
      showToast(result.error ?? "Upload failed.");
      return;
    }
    onSubmitted();
    if (result.saveError) {
      showToast(`Lease PDF uploaded, but its PropLane reading was not stored: ${result.saveError}`);
      onOpenLease?.(ensured.rowId);
      onClose();
      return;
    }
    if (!result.parse) {
      showToast("Lease PDF uploaded.");
      onOpenLease?.(ensured.rowId);
      onClose();
      return;
    }
    setImportReviewLeaseId(ensured.rowId);
    showToast(
      result.parse.status === "parsed"
        ? `Lease imported into PropLane format (${result.parse.sections.length} sections). ${UPLOADED_LEASE_REVIEW_REQUIRED_MESSAGE}`
        : `Lease PDF uploaded, but PropLane could not read its text. ${UPLOADED_LEASE_REVIEW_REQUIRED_MESSAGE}`,
    );
  }

  function openGenerateConfirm() {
    const ensured = ensureLeaseRow();
    if (!ensured.ok) return;
    const row = readLeasePipeline(managerUserId).find((candidate) => candidate.id === ensured.rowId);
    if (!row) {
      showToast("Lease row not found.");
      return;
    }
    if (!leaseAllowsManagerDocumentEdits(row)) {
      showToast("This lease can no longer be edited.");
      return;
    }
    const gate = leaseGenerationSupportedForRow(row);
    if (!gate.ok) {
      showToast(gate.error);
      return;
    }
    setGenerateLeaseRowId(ensured.rowId);
  }

  const generateLeaseRow = generateLeaseRowId
    ? readLeasePipeline(managerUserId).find((candidate) => candidate.id === generateLeaseRowId) ?? null
    : null;

  const reviewRow = importReviewLeaseId
    ? readLeasePipeline(managerUserId).find((row) => row.id === importReviewLeaseId) ?? null
    : null;

  const noProperties = propertyOptions.length === 0;
  const method = isNewResident ? "upload" : leaseMethod;
  const whoIncomplete = !propertyId || !applicationId;
  const propertyLabel = selectedProperty?.propertyLabel ?? "Not set";
  const residentLabel = isNewResident
    ? "New resident"
    : selectedResident
      ? selectedResident.residentName
      : "Not set";
  const steps: AddWorkspaceStep[] = [
    { id: "who", label: "Who", summary: whoIncomplete ? "Property and resident" : `${propertyLabel} · ${residentLabel}`, incomplete: whoIncomplete },
    { id: "lease", label: "Lease", summary: method === "upload" ? "Upload PDF" : "Generate" },
    { id: "review", label: "Review", summary: "Ready" },
  ];
  const current = Math.min(stepIdx, steps.length - 1);
  const stepId = steps[current]!.id;

  return (
    <>
      {open ? (
        <AddWorkspace
          title="Add lease"
          steps={steps}
          current={current}
          onJump={(index) => {
            setStepError(null);
            setStepIdx(index);
          }}
          onClose={() => {
            if (!busy) onClose();
          }}
          dirty={Boolean(propertyId || applicationId)}
          discardTitle="Discard this lease?"
          assistantContext="Add a lease for a property and resident. Generate from PropLane or upload a signed PDF."
          assistantScopeKey="Add lease"
          sidePanel={
            <PreviewPanel
              title="Lease"
              name={residentLabel}
              sub={propertyLabel}
              facts={[
                { label: "Resident", value: residentLabel, warn: !applicationId },
                { label: "Property", value: propertyLabel, warn: !propertyId },
                { label: "Lease", value: method === "upload" ? "Upload PDF" : "Generate" },
              ]}
              creates={[
                { tone: "yes", text: selectedResident ? `Draft lease for ${selectedResident.residentName} at ${propertyLabel}` : "Draft lease" },
                { tone: "yes", text: "No signature until you send" },
              ]}
            />
          }
          lastLabel={method === "upload" ? "Upload PDF" : "Generate lease"}
          lastDisabled={busy || (method === "generate" ? !canGenerateLease : !canUploadLease)}
          nextDisabled={stepId === "who" && whoIncomplete}
          onBeforeNext={() => {
            if (stepId === "who" && whoIncomplete) {
              setStepError(noProperties ? "Add a property first." : "Select a property and resident.");
              return false;
            }
            setStepError(null);
            return true;
          }}
          busy={busy}
          onFinish={() => {
            if (method === "upload") uploadRef.current?.click();
            else openGenerateConfirm();
          }}
          dataAttrPrefix="add-lease"
          finishDataAttr={method === "upload" ? "add-lease-upload" : "add-lease-generate"}
          footerNote={stepError ? <span className="text-sm text-rose-600">{stepError}</span> : null}
        >
          {stepId === "who" ? (
            <StepColumn>
              <StepHeading title="Property and resident" />
              {noProperties ? (
                <div className="flex min-h-40 flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border px-4 py-8">
                  <p className="text-[16px] font-bold">No properties</p>
                  <Button type="button" data-attr="add-lease-add-property" onClick={() => router.push("/portal/properties")}>
                    Add property
                  </Button>
                </div>
              ) : (
                <>
                  <WizardSelect
                    label="Property"
                    value={propertyId}
                    onChange={(next) => {
                      setPropertyId(next);
                      setApplicationId("");
                    }}
                    options={propertyOptions.map((option) => ({ value: option.propertyId, label: option.propertyLabel }))}
                    placeholder="Select property"
                    dataAttr="add-lease-property"
                    disabled={busy}
                  />
                  <WizardSelect
                    label="Resident"
                    value={applicationId}
                    onChange={setApplicationId}
                    options={[
                      { value: NEW_RESIDENT_ID, label: "New resident…" },
                      ...residentsForProperty.map((row) => ({
                        value: row.applicationId,
                        label: row.roomLabel ? `${row.residentName} · ${row.roomLabel}` : row.residentName,
                      })),
                    ]}
                    placeholder={propertyId ? "Select resident" : "Select property first"}
                    dataAttr="add-lease-resident"
                    disabled={busy || !propertyId}
                  />
                </>
              )}
            </StepColumn>
          ) : null}
          {stepId === "lease" ? (
            <StepColumn>
              <StepHeading title="Lease" />
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant={method === "generate" ? "primary" : "outline"}
                  disabled={isNewResident || busy}
                  data-attr="add-lease-method-generate"
                  onClick={() => setLeaseMethod("generate")}
                >
                  Generate
                </Button>
                <Button
                  type="button"
                  variant={method === "upload" ? "primary" : "outline"}
                  disabled={busy}
                  data-attr="add-lease-method-upload"
                  onClick={() => setLeaseMethod("upload")}
                >
                  Upload PDF
                </Button>
              </div>
            </StepColumn>
          ) : null}
          {stepId === "review" ? (
            <StepColumn>
              <StepHeading title="Review" />
              <PreviewPanel
                title="Lease"
                name={residentLabel}
                facts={[
                  { label: "Resident", value: residentLabel },
                  { label: "Property", value: propertyLabel },
                  { label: "Lease", value: method === "upload" ? "Upload PDF" : "Generate" },
                ]}
                creates={[{ tone: "yes", text: method === "upload" ? "Uploads a PDF" : "Generates a draft lease" }]}
              />
            </StepColumn>
          ) : null}
        </AddWorkspace>
      ) : null}

      {newResidentImportOpen && selectedProperty ? (
        <PropertyResidentDocumentImportModal
          open
          kind="lease"
          propertyId={propertyId}
          propertyLabel={selectedProperty.propertyLabel}
          managerUserId={managerUserId}
          initialPdf={newResidentImportBootstrap}
          showToast={showToast}
          onClose={() => {
            setNewResidentImportOpen(false);
            setNewResidentImportBootstrap(null);
          }}
          onImported={({ leaseId }) => {
            onSubmitted();
            setNewResidentImportOpen(false);
            setNewResidentImportBootstrap(null);
            if (leaseId) onOpenLease?.(leaseId);
            onClose();
          }}
        />
      ) : null}

      <input
        ref={uploadRef}
        type="file"
        accept="application/pdf"
        className="sr-only"
        aria-hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void handleUpload(file);
        }}
      />

      <LeaseGenerateModal
        open={generateLeaseRow !== null}
        row={generateLeaseRow}
        managerUserId={managerUserId}
        replacesManagerEdits={Boolean(
          generateLeaseRow?.generatedHtml || generateLeaseRow?.managerUploadedPdf?.dataUrl,
        )}
        onClose={() => setGenerateLeaseRowId(null)}
        onGenerated={(rowId) => {
          onSubmitted();
          setGenerateLeaseRowId(null);
          onOpenLease?.(rowId);
          onClose();
        }}
      />

      {reviewRow?.uploadedLeaseParse ? (
        <UploadedLeaseReviewModal
          open
          row={reviewRow}
          parse={reviewRow.uploadedLeaseParse}
          onClose={() => {
            setImportReviewLeaseId(null);
            onOpenLease?.(reviewRow.id);
            onClose();
          }}
          onConfirm={({ overrides, note }) => {
            const result = confirmUploadedLeaseParse(reviewRow.id, {
              managerUserId,
              overrides: overrides as Partial<Record<UploadedLeaseFieldKey, string>>,
              note,
            });
            if (!result.ok) {
              showToast(result.error ?? "Could not confirm the imported lease.");
              return;
            }
            onSubmitted();
            setImportReviewLeaseId(null);
            void syncLeasePipelineFromServer(managerUserId, { force: true });
            showToast("Imported lease confirmed. It can now be sent for signature.");
            onOpenLease?.(reviewRow.id);
            onClose();
          }}
          onRetryRead={async () => {
            const result = await retryUploadedLeaseParse(reviewRow.id, managerUserId);
            if (!result.ok) {
              showToast(result.error ?? "Could not read that lease PDF.");
              return;
            }
            await syncLeasePipelineFromServer(managerUserId, { force: true });
            onSubmitted();
          }}
        />
      ) : null}
    </>
  );
}
