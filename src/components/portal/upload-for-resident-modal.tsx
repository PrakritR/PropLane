"use client";

/**
 * Upload for resident — a filled application or lease PDF for ONE resident.
 *
 *   Resident  →  File (Application | Lease, drop the PDF)  →  Check (the normal form, filled in)  →  Create
 *
 * It reuses the existing upload pipeline: `parseResidentDocumentPdfClient` reads the PDF and
 * `commitResidentDocumentImport` writes the record. There are no verify checkboxes - the values
 * fill the normal form for the manager to adjust, and Create is the confirmation. The picked
 * resident's identity always wins over what the PDF says (see `upload-for-resident.ts`).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { AddWorkspace, type AddWorkspaceStep } from "@/components/portal/add-workspace";
import { WizardField, WizardSection, WizardSelect } from "@/components/portal/add-workspace/parts";
import { WorkspaceFileCard } from "@/components/portal/add-workspace/upload-action";
import { StepColumn, StepHeading } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import { DateField } from "@/components/ui/date-field";
import { Input } from "@/components/ui/input";
import { SegmentedTwo } from "@/components/ui/segmented-control";
import { useAppUi } from "@/components/providers/app-ui-provider";
import type { ManagerPropertyFilterOption } from "@/lib/manager-portfolio-access";
import { readManagerApplicationRows, syncManagerApplicationsFromServer } from "@/lib/manager-applications-storage";
import { commitResidentDocumentImport } from "@/lib/resident-document-import/commit-import.client";
import { parseResidentDocumentPdfClient, readDataUrlFromFile } from "@/lib/resident-document-import.client";
import type { ParsedResidentDocument, ResidentDocumentKind } from "@/lib/resident-document-import/types";
import {
  uploadForResidentFields,
  uploadForResidentReview,
  uploadFormFields,
  uploadResidentOptions,
  type UploadForResidentTarget,
} from "@/lib/resident-document-import/upload-for-resident";

const NEW_RESIDENT = "__new__";
const MAX_PDF_BYTES = 3.5 * 1024 * 1024;
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

export function UploadForResidentModal({
  open,
  onClose,
  managerUserId,
  properties,
  initialKind = "application",
  residentApplicationId,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  managerUserId: string | null;
  properties: ManagerPropertyFilterOption[];
  /** The list the manager opened this from: Applications opens on Application, Leases on Lease. */
  initialKind?: ResidentDocumentKind;
  /** The resident record it was opened from: that resident is already chosen. */
  residentApplicationId?: string | null;
  onCreated?: (result: { applicationId: string; leaseId?: string }) => void;
}) {
  const { showToast } = useAppUi();
  const [step, setStep] = useState(0);
  const [kind, setKind] = useState<ResidentDocumentKind>(initialKind);
  const [residentPick, setResidentPick] = useState(residentApplicationId ?? "");
  const [newName, setNewName] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newPropertyId, setNewPropertyId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [dataUrl, setDataUrl] = useState("");
  const [parse, setParse] = useState<ParsedResidentDocument | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false;
      return;
    }
    if (wasOpenRef.current) return;
    wasOpenRef.current = true;
    setStep(0);
    setKind(initialKind);
    setResidentPick(residentApplicationId ?? "");
    setNewName("");
    setNewEmail("");
    setNewPropertyId("");
    setFile(null);
    setDataUrl("");
    setParse(null);
    setFields({});
    setReading(false);
    setBusy(false);
  }, [open, initialKind, residentApplicationId]);

  const residents = useMemo(() => (open ? uploadResidentOptions(readManagerApplicationRows(), managerUserId) : []), [open, managerUserId]);
  const picked = residents.find((resident) => resident.id === residentPick) ?? null;
  const isNew = residentPick === NEW_RESIDENT;
  // A resident filed under no home yet needs one picked, the same as a new resident does.
  const needsHomePick = isNew || Boolean(picked && !picked.propertyId);
  const propertyId = isNew ? newPropertyId : picked?.propertyId || newPropertyId;
  const propertyLabel = properties.find((property) => property.id === propertyId)?.label ?? "";

  const target: UploadForResidentTarget | null = isNew
    ? { mode: "new" }
    : picked
      ? { mode: "existing", resident: picked }
      : null;
  const residentReady = isNew
    ? Boolean(newName.trim() && EMAIL_RE.test(newEmail.trim()) && newPropertyId)
    : Boolean(picked && propertyId);

  const chooseKind = (next: ResidentDocumentKind) => {
    if (next === kind) return;
    setKind(next);
    // The reading belongs to the kind it was read as.
    setFile(null);
    setDataUrl("");
    setParse(null);
    setFields({});
  };

  const readFile = async (next: File) => {
    if (next.type !== "application/pdf") {
      showToast("Choose a PDF file.");
      return;
    }
    if (next.size > MAX_PDF_BYTES) {
      showToast("PDF too large (max 3.5 MB).");
      return;
    }
    setReading(true);
    try {
      const url = await readDataUrlFromFile(next);
      const parsed = await parseResidentDocumentPdfClient({ dataUrl: url, fileName: next.name, kind, propertyId: propertyId || undefined });
      const identity = isNew
        ? { name: newName, email: newEmail, phone: "" }
        : { name: picked?.name ?? "", email: picked?.email ?? "", phone: picked?.phone ?? "" };
      setFile(next);
      setDataUrl(url);
      setParse(parsed);
      setFields(uploadForResidentFields(parsed, identity));
      if (parsed.warnings[0]) showToast(parsed.warnings[0]);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Could not read that PDF.");
    } finally {
      setReading(false);
    }
  };

  const formFields = useMemo(() => uploadFormFields(kind, fields), [kind, fields]);
  const finishReady = Boolean(parse && file && target && fields.tenantName?.trim() && EMAIL_RE.test((fields.tenantEmail ?? "").trim()) && propertyId);

  const create = async () => {
    if (!parse || !file || !target || busy) return;
    setBusy(true);
    try {
      const review = uploadForResidentReview({
        kind,
        target,
        parse,
        file,
        dataUrl,
        fields,
        propertyId,
        roomId: parse.propertyMatch?.propertyId === propertyId ? parse.propertyMatch.roomId ?? "" : picked?.roomId ?? "",
      });
      const result = await commitResidentDocumentImport({
        parse,
        review,
        file,
        managerUserId,
        propertyLabel: propertyLabel || "Property",
      });
      if (!result.ok) {
        showToast(result.error);
        return;
      }
      void syncManagerApplicationsFromServer({ force: true, managerUserId: managerUserId ?? undefined }).catch(() => undefined);
      showToast(kind === "lease" ? "Lease created from the uploaded file." : "Application created from the uploaded file.");
      onCreated?.({ applicationId: result.applicationId, leaseId: result.leaseId });
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const steps = useMemo<AddWorkspaceStep[]>(
    () => [
      {
        id: "resident",
        label: "Resident",
        incomplete: !residentReady,
        summary: isNew ? newName.trim() || "New resident" : picked?.name ?? "Choose a resident",
      },
      { id: "file", label: "File", incomplete: !parse, summary: file?.name ?? (kind === "lease" ? "Lease PDF" : "Application PDF") },
      { id: "check", label: "Check", incomplete: !finishReady, summary: parse ? "Review the values" : "Upload a file first" },
    ],
    [residentReady, isNew, newName, picked, parse, file, kind, finishReady],
  );
  const stepId = steps[Math.min(step, steps.length - 1)]!.id;

  if (!open) return null;

  return (
    <AddWorkspace
      title="Upload for resident"
      steps={steps}
      current={step}
      onJump={setStep}
      onClose={onClose}
      hideFooterStepCount
      assistantContext="Upload for resident"
      assistantScopeKey="upload-for-resident"
      dataAttrPrefix="upload-for-resident"
      finishDataAttr="upload-for-resident-create"
      lastLabel="Create"
      lastDisabled={!finishReady}
      nextDisabled={(stepId === "resident" && !residentReady) || (stepId === "file" && !parse)}
      busy={busy}
      dirty={Boolean(file)}
      onBeforeNext={() => {
        if (stepId === "resident" && !residentReady) {
          showToast(isNew ? "Add the name, email and home first." : picked ? "Choose a home first." : "Choose a resident first.");
          return false;
        }
        if (stepId === "file" && !parse) {
          showToast("Upload the PDF first.");
          return false;
        }
        return true;
      }}
      onFinish={() => void create()}
    >
      <div className="min-w-0">
        {stepId === "resident" ? (
          <StepColumn>
            <StepHeading title="Resident" />
            <WizardSection title="Who" dataAttr="upload-for-resident-who">
              <WizardSelect
                label="Resident"
                value={residentPick}
                onChange={(next) => {
                  setResidentPick(next);
                  setFile(null);
                  setDataUrl("");
                  setParse(null);
                  setFields({});
                }}
                options={[
                  ...residents.map((resident) => ({ value: resident.id, label: resident.name })),
                  { value: NEW_RESIDENT, label: "New resident" },
                ]}
                placeholder="Choose a resident"
                dataAttr="upload-for-resident-resident"
                required
              />
              {needsHomePick ? (
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  {isNew ? (
                    <>
                      <WizardField label="Name" required>
                        <Input value={newName} onChange={(e) => setNewName(e.target.value)} data-attr="upload-for-resident-name" />
                      </WizardField>
                      <WizardField label="Email" required>
                        <Input type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} data-attr="upload-for-resident-email" />
                      </WizardField>
                    </>
                  ) : null}
                  <WizardSelect
                    label="Home"
                    value={newPropertyId}
                    onChange={setNewPropertyId}
                    options={properties.map((property) => ({ value: property.id, label: property.label }))}
                    placeholder="Select property…"
                    dataAttr="upload-for-resident-property"
                    required
                  />
                </div>
              ) : null}
            </WizardSection>
          </StepColumn>
        ) : null}

        {stepId === "file" ? (
          <StepColumn>
            <StepHeading title="File" />
            <WizardSection title="This is a" dataAttr="upload-for-resident-kind">
              <SegmentedTwo<ResidentDocumentKind>
                value={kind}
                onChange={chooseKind}
                left={{ id: "application", label: "Application" }}
                right={{ id: "lease", label: "Lease" }}
              />
            </WizardSection>
            <WorkspaceFileCard
              accept="application/pdf,.pdf"
              chips={[".pdf", "up to 3.5 MB"]}
              dataAttr="upload-for-resident-drop"
              disabled={reading}
              fileName={reading ? "Reading the PDF…" : file?.name ?? null}
              onPick={(next) => void readFile(next)}
            />
          </StepColumn>
        ) : null}

        {stepId === "check" ? (
          <StepColumn>
            <StepHeading title="Check" />
            {parse ? (
              <WizardSection title={kind === "lease" ? "Lease" : "Application"} dataAttr="upload-for-resident-form">
                <div className="grid gap-3 sm:grid-cols-2">
                  {formFields.map((def) => (
                    <WizardField key={def.key} label={def.label}>
                      {def.type === "date" ? (
                        <DateField value={fields[def.key] ?? ""} onChange={(value) => setFields((prev) => ({ ...prev, [def.key]: value }))} aria-label={def.label} />
                      ) : (
                        <Input
                          type={def.type ?? "text"}
                          value={fields[def.key] ?? ""}
                          disabled={!isNew && def.key === "tenantEmail"}
                          onChange={(e) => setFields((prev) => ({ ...prev, [def.key]: e.target.value }))}
                          data-attr={`upload-for-resident-field-${def.key}`}
                        />
                      )}
                    </WizardField>
                  ))}
                </div>
              </WizardSection>
            ) : (
              <p role="status">Upload a file on the previous step.</p>
            )}
          </StepColumn>
        ) : null}
      </div>
    </AddWorkspace>
  );
}
