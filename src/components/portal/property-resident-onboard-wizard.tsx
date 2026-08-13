"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileUp } from "lucide-react";
import {
  Modal,
  MODAL_FIELD_LABEL_CLASS,
  ModalFooter,
  PORTAL_MODAL_FORM_FIELD_CLASS,
  PORTAL_MODAL_FORM_GRID_CLASS,
} from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { PortalFormSingleSelect } from "@/components/portal/portal-form-single-select";
import { readExtraListingsForUser } from "@/lib/demo-property-pipeline";
import { commitResidentDocumentImport } from "@/lib/resident-document-import/commit-import.client";
import {
  clearResidentOnboardDraft,
  mergeParsedFields,
  readResidentOnboardDraft,
  writeResidentOnboardDraft,
  type ResidentOnboardDraft,
} from "@/lib/resident-document-import/onboard-draft";
import type { ParsedResidentDocument } from "@/lib/resident-document-import/types";
import {
  parsedFieldsToRecord,
  parseResidentDocumentPdfClient,
  readDataUrlFromFile,
} from "@/lib/resident-document-import.client";

const FIELD_DEFS: Array<{ key: string; label: string; type?: "text" | "email" | "tel" }> = [
  { key: "tenantName", label: "Resident name *" },
  { key: "tenantEmail", label: "Email *", type: "email" },
  { key: "tenantPhone", label: "Phone", type: "tel" },
  { key: "leaseStart", label: "Lease start" },
  { key: "leaseEnd", label: "Lease end" },
  { key: "leaseTerm", label: "Lease term" },
  { key: "monthlyRent", label: "Monthly rent" },
  { key: "securityDeposit", label: "Security deposit" },
  { key: "monthlyUtilities", label: "Monthly utilities" },
];

type WizardStep = "upload" | "review";

function UploadCard({
  title,
  subtitle,
  fileName,
  busy,
  dataAttr,
  onPick,
}: {
  title: string;
  subtitle: string;
  fileName: string | null;
  busy: boolean;
  dataAttr: string;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      className="flex min-h-[10rem] min-w-[min(100%,11rem)] flex-1 basis-[calc(50%-0.375rem)] flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-border bg-accent/10 px-3 py-6 text-center transition hover:border-primary/40 hover:bg-primary/[0.05] disabled:opacity-60"
      onClick={onPick}
      disabled={busy}
      data-attr={dataAttr}
    >
      <FileUp className="h-7 w-7 text-primary" aria-hidden />
      <span className="text-sm font-semibold text-foreground">{title}</span>
      <span className="text-xs text-muted">{subtitle}</span>
      {fileName ? <span className="mt-1 max-w-full truncate text-xs font-medium text-foreground">{fileName}</span> : null}
    </button>
  );
}

export function PropertyResidentOnboardWizard({
  open,
  propertyId,
  propertyLabel,
  managerUserId,
  onClose,
  onImported,
  showToast,
}: {
  open: boolean;
  propertyId: string;
  propertyLabel: string;
  managerUserId: string | null;
  onClose: () => void;
  onImported: (result: { applicationId: string; leaseId?: string }) => void;
  showToast: (message: string) => void;
}) {
  const applicationUploadRef = useRef<HTMLInputElement>(null);
  const leaseUploadRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<WizardStep>("upload");
  const [busy, setBusy] = useState(false);
  const [applicationFile, setApplicationFile] = useState<File | null>(null);
  const [leaseFile, setLeaseFile] = useState<File | null>(null);
  const [applicationParse, setApplicationParse] = useState<ParsedResidentDocument | null>(null);
  const [leaseParse, setLeaseParse] = useState<ParsedResidentDocument | null>(null);
  const [applicationDataUrl, setApplicationDataUrl] = useState("");
  const [leaseDataUrl, setLeaseDataUrl] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [selectedPropertyId, setSelectedPropertyId] = useState(propertyId);
  const [selectedRoomId, setSelectedRoomId] = useState("");
  const [sendAccountSetup, setSendAccountSetup] = useState(true);
  const [leaseFullyExecuted, setLeaseFullyExecuted] = useState(false);

  const reset = useCallback(() => {
    setStep("upload");
    setBusy(false);
    setApplicationFile(null);
    setLeaseFile(null);
    setApplicationParse(null);
    setLeaseParse(null);
    setApplicationDataUrl("");
    setLeaseDataUrl("");
    setFields({});
    setSelectedPropertyId(propertyId);
    setSelectedRoomId("");
    setSendAccountSetup(true);
    setLeaseFullyExecuted(false);
  }, [propertyId]);

  useEffect(() => {
    if (!open) return;
    reset();
    const saved = readResidentOnboardDraft(propertyId);
    if (!saved) return;
    setSelectedPropertyId(saved.propertyId || propertyId);
    setSelectedRoomId(saved.roomId || "");
    setFields(saved.fields);
    setApplicationDataUrl(saved.applicationDataUrl ?? "");
    setLeaseDataUrl(saved.leaseDataUrl ?? "");
    setApplicationParse(saved.applicationParse ?? null);
    setLeaseParse(saved.leaseParse ?? null);
    setLeaseFullyExecuted(saved.leaseFullyExecuted);
    setSendAccountSetup(saved.sendAccountSetup);
    if (saved.applicationFileName) {
      setApplicationFile(new File([], saved.applicationFileName, { type: "application/pdf" }));
    }
    if (saved.leaseFileName) {
      setLeaseFile(new File([], saved.leaseFileName, { type: "application/pdf" }));
    }
  }, [open, propertyId, reset]);

  const propertyOptions = useMemo(() => {
    if (!managerUserId) return [];
    return readExtraListingsForUser(managerUserId).map((row) => ({
      value: row.id,
      label: row.buildingName?.trim() || row.title?.trim() || row.id,
    }));
  }, [managerUserId, open]);

  const selectedProperty = useMemo(
    () => readExtraListingsForUser(managerUserId).find((row) => row.id === selectedPropertyId) ?? null,
    [managerUserId, selectedPropertyId],
  );

  const roomOptions = useMemo(() => {
    const rooms = selectedProperty?.listingSubmission?.rooms ?? [];
    return rooms
      .filter((room) => room.name?.trim())
      .map((room) => ({ value: room.id, label: room.name.trim() }));
  }, [selectedProperty]);

  const residentSummary = useMemo(() => {
    const email = fields.tenantEmail?.trim().toLowerCase();
    if (!email) return null;
    const appMatch = applicationParse?.residentMatch ?? leaseParse?.residentMatch;
    if (appMatch?.kind === "existing") {
      return `Matched existing resident: ${appMatch.residentName} (${appMatch.residentEmail})`;
    }
    return "New resident — account setup can be emailed after import.";
  }, [applicationParse, fields.tenantEmail, leaseParse?.residentMatch]);

  async function parseKind(file: File, kind: "application" | "lease") {
    const url = await readDataUrlFromFile(file);
    const parsed = await parseResidentDocumentPdfClient({
      dataUrl: url,
      fileName: file.name,
      kind,
      propertyId: selectedPropertyId || propertyId,
    });
    return { url, parsed };
  }

  async function handleApplicationFile(file: File) {
    setBusy(true);
    try {
      const { url, parsed } = await parseKind(file, "application");
      setApplicationFile(file);
      setApplicationDataUrl(url);
      setApplicationParse(parsed);
      const merged = mergeParsedFields(parsed, leaseParse);
      setFields((prev) => ({ ...merged, ...prev, ...parsedFieldsToRecord(parsed.fields) }));
      if (parsed.propertyMatch?.propertyId) setSelectedPropertyId(parsed.propertyMatch.propertyId);
      if (parsed.propertyMatch?.roomId) setSelectedRoomId(parsed.propertyMatch.roomId);
      if (parsed.warnings[0]) showToast(parsed.warnings[0]);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Could not read application PDF.");
    } finally {
      setBusy(false);
      if (applicationUploadRef.current) applicationUploadRef.current.value = "";
    }
  }

  async function handleLeaseFile(file: File) {
    setBusy(true);
    try {
      const { url, parsed } = await parseKind(file, "lease");
      setLeaseFile(file);
      setLeaseDataUrl(url);
      setLeaseParse(parsed);
      const merged = mergeParsedFields(applicationParse, parsed);
      setFields((prev) => ({ ...merged, ...prev, ...parsedFieldsToRecord(parsed.fields) }));
      if (!selectedRoomId && parsed.propertyMatch?.roomId) setSelectedRoomId(parsed.propertyMatch.roomId);
      setLeaseFullyExecuted(
        parsed.suggestedLeaseBucket === "signed" || parsed.leaseSignatures?.fullyExecuted === true,
      );
      if (parsed.warnings[0]) showToast(parsed.warnings[0]);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Could not read lease PDF.");
    } finally {
      setBusy(false);
      if (leaseUploadRef.current) leaseUploadRef.current.value = "";
    }
  }

  function persistDraftForContinue() {
    const draft: ResidentOnboardDraft = {
      propertyId: selectedPropertyId || propertyId,
      propertyLabel,
      roomId: selectedRoomId,
      fields,
      applicationFileName: applicationFile?.name,
      applicationDataUrl: applicationDataUrl || undefined,
      applicationParse,
      leaseFileName: leaseFile?.name,
      leaseDataUrl: leaseDataUrl || undefined,
      leaseParse,
      leaseFullyExecuted,
      sendAccountSetup,
    };
    writeResidentOnboardDraft(draft);
    return draft;
  }

  function goToReview() {
    persistDraftForContinue();
    setStep("review");
  }

  async function handleImport() {
    if (!fields.tenantName?.trim() || !fields.tenantEmail?.trim()) {
      showToast("Resident name and email are required.");
      return;
    }
    if (!selectedPropertyId) {
      showToast("Select a property.");
      return;
    }
    const hasApplication = Boolean(applicationFile && applicationDataUrl && applicationParse);
    const hasLease = Boolean(leaseFile && leaseDataUrl && leaseParse);
    if (!hasApplication && !hasLease) {
      showToast("Upload at least one PDF to import.");
      return;
    }

    setBusy(true);
    try {
      const label =
        propertyOptions.find((row) => row.value === selectedPropertyId)?.label || propertyLabel || "Property";
      const primaryParse = leaseParse ?? applicationParse!;
      let residentMode: "existing" | "new" =
        primaryParse.residentMatch.kind === "existing" ? "existing" : "new";
      let applicationId =
        primaryParse.residentMatch.kind === "existing" ? primaryParse.residentMatch.applicationId : "";

      if (hasApplication) {
        const appResult = await commitResidentDocumentImport({
          parse: applicationParse!,
          review: {
            kind: "application",
            fileName: applicationFile!.name,
            dataUrl: applicationDataUrl,
            fields,
            propertyId: selectedPropertyId,
            roomId: selectedRoomId,
            residentMode,
            existingApplicationId:
              applicationParse!.residentMatch.kind === "existing"
                ? applicationParse!.residentMatch.applicationId
                : undefined,
            sendAccountSetup: hasLease ? false : sendAccountSetup,
            leaseFullyExecuted: false,
          },
          file: applicationFile,
          managerUserId,
          propertyLabel: label,
        });
        if (!appResult.ok) {
          showToast(appResult.error);
          return;
        }
        applicationId = appResult.applicationId;
        residentMode = "existing";
      }

      if (hasLease) {
        const leaseResult = await commitResidentDocumentImport({
          parse: leaseParse!,
          review: {
            kind: "lease",
            fileName: leaseFile!.name,
            dataUrl: leaseDataUrl,
            fields,
            propertyId: selectedPropertyId,
            roomId: selectedRoomId,
            residentMode: applicationId ? "existing" : residentMode,
            existingApplicationId: applicationId || undefined,
            sendAccountSetup,
            leaseFullyExecuted,
          },
          file: leaseFile,
          managerUserId,
          propertyLabel: label,
        });
        if (!leaseResult.ok) {
          showToast(leaseResult.error);
          return;
        }
        clearResidentOnboardDraft(propertyId);
        onImported({ applicationId: leaseResult.applicationId, leaseId: leaseResult.leaseId });
        onClose();
        return;
      }

      clearResidentOnboardDraft(propertyId);
      onImported({ applicationId });
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!busy) onClose();
      }}
      title={step === "upload" ? "Add resident from PDFs" : "Review & import resident"}
      description={
        step === "upload"
          ? "Upload an application PDF and/or lease PDF side by side. PropLane merges the readings and links this resident to this property."
          : "Confirm resident details, rent, and property placement before creating records."
      }
      dataAttr="property-resident-onboard-wizard"
    >
      {step === "upload" ? (
        <div className="space-y-4">
          <div className="flex flex-row flex-wrap gap-3">
            <UploadCard
              title="Add application"
              subtitle="Rental application PDF"
              fileName={applicationFile?.name ?? null}
              busy={busy}
              dataAttr="property-onboard-application-pdf"
              onPick={() => applicationUploadRef.current?.click()}
            />
            <UploadCard
              title="Add lease"
              subtitle="Signed or draft lease PDF"
              fileName={leaseFile?.name ?? null}
              busy={busy}
              dataAttr="property-onboard-lease-pdf"
              onPick={() => leaseUploadRef.current?.click()}
            />
          </div>
          <p className="text-xs text-muted">
            Upload one or both. Lease fields auto-fill from the application reading when both are present.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {residentSummary ? (
            <p className="rounded-xl bg-accent/20 px-3 py-2 text-sm text-muted">{residentSummary}</p>
          ) : null}
          <div className={PORTAL_MODAL_FORM_GRID_CLASS}>
            {FIELD_DEFS.map((def) => (
              <label key={def.key} className={PORTAL_MODAL_FORM_FIELD_CLASS}>
                <span className={MODAL_FIELD_LABEL_CLASS}>{def.label}</span>
                <Input
                  type={def.type ?? "text"}
                  value={fields[def.key] ?? ""}
                  onChange={(e) => setFields((prev) => ({ ...prev, [def.key]: e.target.value }))}
                />
              </label>
            ))}
            <div className={PORTAL_MODAL_FORM_FIELD_CLASS}>
              <PortalFormSingleSelect
                label="Property"
                labelClassName={MODAL_FIELD_LABEL_CLASS}
                value={selectedPropertyId}
                onChange={(next) => {
                  setSelectedPropertyId(next);
                  setSelectedRoomId("");
                }}
                options={propertyOptions}
                placeholder="Select property…"
              />
            </div>
            {roomOptions.length > 0 ? (
              <label className={PORTAL_MODAL_FORM_FIELD_CLASS}>
                <span className={MODAL_FIELD_LABEL_CLASS}>Room</span>
                <Select value={selectedRoomId} onChange={(e) => setSelectedRoomId(e.target.value)}>
                  <option value="">Select room…</option>
                  {roomOptions.map((room) => (
                    <option key={room.value} value={room.value}>
                      {room.label}
                    </option>
                  ))}
                </Select>
              </label>
            ) : null}
          </div>
          {leaseFile ? (
            <label className="flex items-start gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                className="mt-1"
                checked={leaseFullyExecuted}
                onChange={(e) => setLeaseFullyExecuted(e.target.checked)}
              />
              <span>Lease is fully signed off-platform (file as executed in Signed).</span>
            </label>
          ) : null}
          <label className="flex items-start gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              className="mt-1"
              checked={sendAccountSetup}
              onChange={(e) => setSendAccountSetup(e.target.checked)}
            />
            <span>Email portal account setup instructions after import.</span>
          </label>
        </div>
      )}

      <input
        ref={applicationUploadRef}
        type="file"
        accept="application/pdf"
        className="sr-only"
        aria-hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void handleApplicationFile(file);
        }}
      />
      <input
        ref={leaseUploadRef}
        type="file"
        accept="application/pdf"
        className="sr-only"
        aria-hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void handleLeaseFile(file);
        }}
      />

      <ModalFooter>
        {step === "review" ? (
          <Button type="button" variant="outline" disabled={busy} onClick={() => setStep("upload")}>
            Back
          </Button>
        ) : null}
        {step === "upload" ? (
          <Button
            type="button"
            variant="primary"
            disabled={busy || (!applicationFile && !leaseFile)}
            onClick={goToReview}
            data-attr="property-onboard-continue"
          >
            Continue
          </Button>
        ) : (
          <Button
            type="button"
            variant="primary"
            disabled={busy}
            onClick={() => void handleImport()}
            data-attr="property-onboard-import"
          >
            {busy ? "Importing…" : "Import resident"}
          </Button>
        )}
      </ModalFooter>
    </Modal>
  );
}
