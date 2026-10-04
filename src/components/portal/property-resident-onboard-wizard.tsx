"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileUp } from "lucide-react";
import { PortalDialog } from "@/components/portal/portal-dialog";
import { WizardField, PreviewPanel, type CreatesItem } from "@/components/portal/add-workspace/parts";
import { PortalSettingsGroup, PortalSettingsRow, PortalSettingsToggle } from "@/components/portal/portal-settings-ui";
import { DateField } from "@/components/ui/date-field";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { Input } from "@/components/ui/input";
import { normalizeParsedDateForInput } from "@/lib/resident-document-import/apply-parsed-to-add-resident";
import { AIRBNB_LEASE_TERM, LEASE_TERM_CHOICES, SHORT_TERM_LEASE_TERM } from "@/lib/rental-application/lease-terms";
import { readExtraListingsForUser } from "@/lib/demo-property-pipeline";
import {
  collectLinkedPropertyIdsForModule,
  resolvePropertyLabelForId,
} from "@/lib/manager-portfolio-access";
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

const LEASE_TERM_PICK_OPTIONS = [...LEASE_TERM_CHOICES, SHORT_TERM_LEASE_TERM, AIRBNB_LEASE_TERM];

/** A label row for a picker: sentence case, "Optional" when it is not required. */
function PickerLabel({ label, optional }: { label: string; optional?: boolean }) {
  return (
    <span className="mb-1.5 flex items-center gap-1.5 text-[12.5px] font-bold text-foreground">
      {label}
      {optional ? (
        <span aria-hidden="true" data-field-optional="" className="ml-2 text-xs font-normal text-muted">
          Optional
        </span>
      ) : null}
    </span>
  );
}

export function PropertyResidentPdfUploadCard({
  title,
  subtitle,
  fileName,
  busy,
  dataAttr,
  onPick,
}: {
  title: string;
  subtitle?: string;
  fileName: string | null;
  busy: boolean;
  dataAttr: string;
  onPick: () => void;
}) {
  return (
    // A row on a phone (icon left, words right) so three choices fit one
    // screen of a sheet; the tall dashed tile from `sm` up where there is room.
    <button
      type="button"
      className="flex w-full items-center gap-3 rounded-2xl border-2 border-dashed border-border bg-accent/10 px-4 py-3 text-left transition hover:border-primary/40 hover:bg-primary/[0.05] disabled:opacity-60 sm:min-h-[10rem] sm:flex-col sm:items-center sm:justify-center sm:gap-2 sm:px-3 sm:py-6 sm:text-center"
      onClick={onPick}
      disabled={busy}
      data-attr={dataAttr}
    >
      <FileUp className="h-6 w-6 shrink-0 text-primary sm:h-7 sm:w-7" aria-hidden />
      <span className="min-w-0 sm:contents">
        <span className="block text-sm font-semibold text-foreground">{title}</span>
        {subtitle ? <span className="block text-xs text-muted">{subtitle}</span> : null}
        {fileName ? <span className="mt-1 block max-w-full truncate text-xs font-medium text-foreground">{fileName}</span> : null}
      </span>
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

  const matchedResident = useMemo(() => {
    const email = fields.tenantEmail?.trim().toLowerCase();
    if (!email) return null;
    const match = applicationParse?.residentMatch ?? leaseParse?.residentMatch;
    return match?.kind === "existing" ? match.residentName : null;
  }, [applicationParse, fields.tenantEmail, leaseParse?.residentMatch]);

  const setField = (key: string, value: string) => setFields((prev) => ({ ...prev, [key]: value }));
  const propertyName = propertyOptions.find((row) => row.value === selectedPropertyId)?.label || propertyLabel;
  const roomName = roomOptions.find((room) => room.value === selectedRoomId)?.label ?? "";
  const money = (key: string, label: string, placeholder: string) => (
    <WizardField label={label}>
      <span className="relative block">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[13px] text-muted">$</span>
        <Input
          inputMode="decimal"
          className="pl-6"
          value={fields[key] ?? ""}
          onChange={(e) => setField(key, e.target.value)}
          placeholder={placeholder}
          data-attr={`property-onboard-${key}`}
        />
      </span>
    </WizardField>
  );
  const leaseTermValue = fields.leaseTerm?.trim() ?? "";
  const leaseTermOptions = (
    leaseTermValue && !LEASE_TERM_PICK_OPTIONS.includes(leaseTermValue)
      ? [leaseTermValue, ...LEASE_TERM_PICK_OPTIONS]
      : LEASE_TERM_PICK_OPTIONS
  ).map((term) => ({ value: term, label: term }));
  const hasApplicationPdf = Boolean(applicationFile);
  const hasLeasePdf = Boolean(leaseFile);
  const creates: CreatesItem[] = [
    { tone: hasApplicationPdf ? "yes" : "no", text: "Application on file" },
    { tone: hasLeasePdf ? "yes" : "no", text: leaseFullyExecuted && hasLeasePdf ? "Signed lease on file" : "Lease on file" },
    { tone: sendAccountSetup ? "yes" : "no", text: "Portal setup email" },
  ];

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

  function persistDraft() {
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

    persistDraft();
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
    <PortalDialog
      open={open}
      onClose={() => {
        if (!busy) onClose();
      }}
      title="Add resident"
      dataAttr="property-resident-onboard-wizard"
      contextPanel={null}
      preview={
        <PreviewPanel
          title="Resident"
          name={fields.tenantName?.trim() || "New resident"}
          sub={fields.tenantEmail?.trim() || undefined}
          facts={[
            ...(propertyName || roomName
              ? [{ label: "Home", value: [propertyName, roomName].filter(Boolean).join(" · ") }]
              : []),
            ...(leaseTermValue ? [{ label: "Term", value: leaseTermValue }] : []),
            ...(fields.monthlyRent?.trim() ? [{ label: "Rent", value: `$${fields.monthlyRent.trim().replace(/^\$/, "")}` }] : []),
            ...(matchedResident ? [{ label: "Matched", value: matchedResident }] : []),
          ]}
          creates={creates}
          createsHeading="On import"
        />
      }
      primaryAction={{
        label: "Import resident",
        onClick: () => handleImport(),
        disabled: busy || (!applicationFile && !leaseFile),
        loading: busy,
        dataAttr: "property-onboard-import",
      }}
    >
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-3 min-[28rem]:grid-cols-2">
          <PropertyResidentPdfUploadCard
            title="Add application"
            fileName={applicationFile?.name ?? null}
            busy={busy}
            dataAttr="property-onboard-application-pdf"
            onPick={() => applicationUploadRef.current?.click()}
          />
          <PropertyResidentPdfUploadCard
            title="Add lease"
            fileName={leaseFile?.name ?? null}
            busy={busy}
            dataAttr="property-onboard-lease-pdf"
            onPick={() => leaseUploadRef.current?.click()}
          />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2" data-attr="property-onboard-fields">
          <WizardField label="Resident name" required>
            <Input
              value={fields.tenantName ?? ""}
              onChange={(e) => setField("tenantName", e.target.value)}
              data-attr="property-onboard-tenantName"
            />
          </WizardField>
          <WizardField label="Email" required>
            <Input
              type="email"
              value={fields.tenantEmail ?? ""}
              onChange={(e) => setField("tenantEmail", e.target.value)}
              data-attr="property-onboard-tenantEmail"
            />
          </WizardField>
          <WizardField label="Phone">
            <Input
              type="tel"
              value={fields.tenantPhone ?? ""}
              onChange={(e) => setField("tenantPhone", e.target.value)}
              data-attr="property-onboard-tenantPhone"
            />
          </WizardField>
          <div data-wizard-picker="">
            <PickerLabel label="Property" />
            <FieldSingleSelect
              label="Property"
              hideLabel
              value={selectedPropertyId}
              onChange={(next) => {
                setSelectedPropertyId(next);
                setSelectedRoomId("");
              }}
              options={propertyOptions}
              placeholder="Select property…"
              dataAttr="property-onboard-property"
            />
          </div>
          {roomOptions.length > 0 ? (
            <div data-wizard-picker="">
              <PickerLabel label="Room" optional />
              <FieldSingleSelect
                label="Room"
                hideLabel
                value={selectedRoomId}
                onChange={setSelectedRoomId}
                options={roomOptions}
                placeholder="Select room…"
                dataAttr="property-onboard-room"
              />
            </div>
          ) : null}
          <div data-wizard-picker="">
            <PickerLabel label="Lease term" optional />
            <FieldSingleSelect
              label="Lease term"
              hideLabel
              value={leaseTermValue}
              onChange={(next) => setField("leaseTerm", next)}
              options={leaseTermOptions}
              placeholder="Select term…"
              dataAttr="property-onboard-leaseTerm"
            />
          </div>
          <WizardField label="Lease start">
            <DateField
              value={normalizeParsedDateForInput(fields.leaseStart)}
              onChange={(iso) => setField("leaseStart", iso)}
              data-attr="property-onboard-leaseStart"
            />
          </WizardField>
          <WizardField label="Lease end">
            <DateField
              value={normalizeParsedDateForInput(fields.leaseEnd)}
              onChange={(iso) => setField("leaseEnd", iso)}
              data-attr="property-onboard-leaseEnd"
            />
          </WizardField>
          {money("monthlyRent", "Monthly rent", "875.00")}
          {money("securityDeposit", "Security deposit", "875.00")}
          {money("monthlyUtilities", "Monthly utilities", "120.00")}
        </div>
        <PortalSettingsGroup>
          {leaseFile ? (
            <PortalSettingsRow label="Lease signed off-platform">
              <PortalSettingsToggle
                checked={leaseFullyExecuted}
                onChange={setLeaseFullyExecuted}
                label="Lease signed off-platform"
                dataAttr="property-onboard-lease-executed"
              />
            </PortalSettingsRow>
          ) : null}
          <PortalSettingsRow label="Email portal account setup">
            <PortalSettingsToggle
              checked={sendAccountSetup}
              onChange={setSendAccountSetup}
              label="Email portal account setup"
              dataAttr="property-onboard-send-setup"
            />
          </PortalSettingsRow>
        </PortalSettingsGroup>
      </div>

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

    </PortalDialog>
  );
}
