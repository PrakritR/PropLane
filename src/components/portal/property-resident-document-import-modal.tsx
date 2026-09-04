"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { FileUp } from "lucide-react";
import { Modal, MODAL_FIELD_LABEL_CLASS, ModalFooter, PORTAL_MODAL_FORM_FIELD_CLASS, PORTAL_MODAL_FORM_GRID_CLASS } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { PortalFormSingleSelect } from "@/components/portal/filter-field-lists";
import { readExtraListingsForUser } from "@/lib/demo-property-pipeline";
import {
  collectLinkedPropertyIdsForModule,
  resolvePropertyLabelForId,
} from "@/lib/manager-portfolio-access";
import { commitResidentDocumentImport } from "@/lib/resident-document-import/commit-import.client";
import type { ParsedResidentDocument, ResidentDocumentKind } from "@/lib/resident-document-import/types";
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

export function PropertyResidentDocumentImportModal({
  open,
  kind,
  propertyId,
  propertyLabel,
  managerUserId,
  onClose,
  onImported,
  showToast,
  initialPdf = null,
  forcedExistingApplicationId,
}: {
  open: boolean;
  kind: ResidentDocumentKind;
  propertyId: string;
  propertyLabel: string;
  managerUserId: string | null;
  onClose: () => void;
  onImported: (result: { applicationId: string; leaseId?: string }) => void;
  showToast: (message: string) => void;
  /** Skip the upload card when the parent already parsed a PDF. */
  initialPdf?: {
    parse: ParsedResidentDocument;
    file: File;
    dataUrl: string;
  } | null;
  forcedExistingApplicationId?: string;
}) {
  const uploadRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [parse, setParse] = useState<ParsedResidentDocument | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [dataUrl, setDataUrl] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [selectedPropertyId, setSelectedPropertyId] = useState(propertyId);
  const [selectedRoomId, setSelectedRoomId] = useState("");
  const [sendAccountSetup, setSendAccountSetup] = useState(true);
  const [leaseFullyExecuted, setLeaseFullyExecuted] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (initialPdf) {
      setParse(initialPdf.parse);
      setFile(initialPdf.file);
      setDataUrl(initialPdf.dataUrl);
      setFields(parsedFieldsToRecord(initialPdf.parse.fields));
      setSelectedPropertyId(
        propertyId.trim() || initialPdf.parse.propertyMatch?.propertyId?.trim() || "",
      );
      setSelectedRoomId(initialPdf.parse.propertyMatch?.roomId?.trim() || "");
      setSendAccountSetup(initialPdf.parse.residentMatch.kind === "new");
      setLeaseFullyExecuted(
        initialPdf.parse.suggestedLeaseBucket === "signed" ||
          initialPdf.parse.leaseSignatures?.fullyExecuted === true,
      );
      return;
    }
    setParse(null);
    setFile(null);
    setDataUrl("");
    setFields({});
    setSelectedPropertyId(propertyId);
    setSelectedRoomId("");
    setSendAccountSetup(true);
    setLeaseFullyExecuted(false);
  }, [open, propertyId, initialPdf]);

  const propertyOptions = useMemo(() => {
    if (!managerUserId) return [];
    const owned = readExtraListingsForUser(managerUserId).map((row) => ({
      value: row.id,
      label: row.buildingName?.trim() || row.title?.trim() || row.id,
    }));
      // Linked listings live in the OWNER's bucket, not this viewer's (AXI-156),
      // so a co-manager saw an empty picker here.
    const ownedIds = new Set(owned.map((row) => row.value));
    const linked = [...collectLinkedPropertyIdsForModule(managerUserId, "residents")]
      .filter((id) => id && !ownedIds.has(id))
      .map((id) => ({ value: id, label: resolvePropertyLabelForId(id) }));
    return [...owned, ...linked];
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

  useEffect(() => {
    if (!parse?.propertyMatch?.roomId) return;
    setSelectedRoomId(parse.propertyMatch.roomId);
  }, [parse]);

  async function handleFileChosen(nextFile: File) {
    if (nextFile.type !== "application/pdf") {
      showToast("Please choose a PDF file.");
      return;
    }
    if (nextFile.size > 3.5 * 1024 * 1024) {
      showToast("PDF too large (max 3.5 MB).");
      return;
    }
    setBusy(true);
    setFile(nextFile);
    try {
      const url = await readDataUrlFromFile(nextFile);
      setDataUrl(url);
      const parsed = await parseResidentDocumentPdfClient({
        dataUrl: url,
        fileName: nextFile.name,
        kind,
        propertyId,
      });
      setParse(parsed);
      setFields(parsedFieldsToRecord(parsed.fields));
      if (parsed.propertyMatch?.propertyId) setSelectedPropertyId(parsed.propertyMatch.propertyId);
      if (parsed.propertyMatch?.roomId) setSelectedRoomId(parsed.propertyMatch.roomId);
      setLeaseFullyExecuted(
        parsed.suggestedLeaseBucket === "signed" || parsed.leaseSignatures?.fullyExecuted === true,
      );
      if (parsed.residentMatch.kind === "new") setSendAccountSetup(true);
      if (parsed.warnings.length > 0) showToast(parsed.warnings[0]!);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Could not read that PDF.");
      setParse(null);
      setFile(null);
      setDataUrl("");
    } finally {
      setBusy(false);
      if (uploadRef.current) uploadRef.current.value = "";
    }
  }

  async function handleImport() {
    if (!parse || !file || !dataUrl) {
      showToast("Upload a PDF first.");
      return;
    }
    if (!fields.tenantName?.trim() || !fields.tenantEmail?.trim()) {
      showToast("Resident name and email are required.");
      return;
    }
    if (!selectedPropertyId) {
      showToast("Select a property.");
      return;
    }
    setBusy(true);
    try {
      const label =
        propertyOptions.find((row) => row.value === selectedPropertyId)?.label || propertyLabel || "Property";
      const forcedExistingId = forcedExistingApplicationId?.trim() || "";
      const existingApplicationId =
        forcedExistingId ||
        (parse.residentMatch.kind === "existing" ? parse.residentMatch.applicationId : undefined);
      const result = await commitResidentDocumentImport({
        parse,
        review: {
          kind,
          fileName: file.name,
          dataUrl,
          fields,
          propertyId: selectedPropertyId,
          roomId: selectedRoomId,
          residentMode: existingApplicationId ? "existing" : "new",
          existingApplicationId,
          sendAccountSetup,
          leaseFullyExecuted,
        },
        file,
        managerUserId,
        propertyLabel: label,
      });
      if (!result.ok) {
        showToast(result.error);
        return;
      }
      showToast(
        kind === "lease"
          ? "Lease imported and resident record updated."
          : parse.residentMatch.kind === "existing"
            ? "Application details updated for this resident."
            : "Application created for this resident.",
      );
      onImported({ applicationId: result.applicationId, leaseId: result.leaseId });
      onClose();
    } finally {
      setBusy(false);
    }
  }

  const title = kind === "lease" ? "Import lease PDF" : "Import application PDF";
  const residentSummary =
    parse?.residentMatch.kind === "existing"
      ? `Matched existing resident: ${parse.residentMatch.residentName} (${parse.residentMatch.residentEmail})`
      : parse
        ? "New resident — an application will be created and you can send account setup instructions."
        : null;

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!busy) onClose();
      }}
      title={title}
      description={
        kind === "lease"
          ? "Upload a signed or draft lease. PropLane reads the PDF, links it to this property, and places the lease in the right pipeline stage."
          : "Upload a completed rental application. PropLane extracts resident details and creates or updates their record."
      }
      dataAttr={`property-${kind}-import-modal`}
      footer={
        parse ? (
          <ModalFooter>
            <Button
              type="button"
              variant="primary"
              className="ml-auto rounded-full"
              disabled={busy}
              onClick={() => void handleImport()}
              data-attr={`property-${kind}-import-confirm`}
            >
              {busy ? "Importing…" : kind === "lease" ? "Import lease" : "Import application"}
            </Button>
          </ModalFooter>
        ) : null
      }
    >
      <div className="space-y-4">
        {!parse ? (
          <button
            type="button"
            className="flex w-full flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-border bg-accent/10 px-4 py-10 text-center transition hover:border-primary/40 hover:bg-primary/[0.05]"
            onClick={() => uploadRef.current?.click()}
            disabled={busy}
            data-attr={`property-${kind}-import-upload`}
          >
            <FileUp className="h-8 w-8 text-primary" aria-hidden />
            <span className="text-sm font-medium text-foreground">{busy ? "Reading PDF…" : "Choose PDF to upload"}</span>
            <span className="text-xs text-muted">Uses AI-assisted parsing to pre-fill resident, property, and rent details.</span>
          </button>
        ) : (
          <>
            {residentSummary ? <p className="rounded-xl bg-accent/20 px-3 py-2 text-sm text-muted">{residentSummary}</p> : null}
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
            {kind === "lease" ? (
              <label className="flex items-start gap-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={leaseFullyExecuted}
                  onChange={(e) => setLeaseFullyExecuted(e.target.checked)}
                />
                <span>
                  Lease is fully signed off-platform (file in Signed / Manager review as executed, skip e-sign).
                </span>
              </label>
            ) : null}
            {parse.residentMatch.kind === "new" || kind === "lease" ? (
              <label className="flex items-start gap-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={sendAccountSetup}
                  onChange={(e) => setSendAccountSetup(e.target.checked)}
                />
                <span>Email portal account setup instructions after import.</span>
              </label>
            ) : null}
            <Button type="button" variant="outline" onClick={() => uploadRef.current?.click()} disabled={busy}>
              Choose a different PDF
            </Button>
          </>
        )}
      </div>

      <input
        ref={uploadRef}
        type="file"
        accept="application/pdf"
        className="sr-only"
        aria-hidden
        onChange={(e) => {
          const next = e.target.files?.[0];
          if (next) void handleFileChosen(next);
        }}
      />

    </Modal>
  );
}
