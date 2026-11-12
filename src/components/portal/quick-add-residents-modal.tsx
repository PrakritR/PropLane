"use client";

/**
 * Residents + : one resident in one sheet, or several from a CSV. Both go through `saveQuickAddResident`, which
 * is the Add resident wizard's own commit plus documents, one-time charges and the email + text onboarding links.
 * "Full form" opens the wizard for everything this sheet leaves out.
 */
import { useEffect, useMemo, useState } from "react";
import { Download, Plus, X } from "lucide-react";
import { DocumentRow, WizardField, WizardRow, WizardSection, WizardSelect, type AttachedDocument } from "@/components/portal/add-workspace/parts";
import { WorkspaceFileCard } from "@/components/portal/add-workspace/upload-action";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { normalizeManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { getPropertyById, isPropertyRentedByRoom } from "@/lib/rental-application/data";
import { resolveManualResidentPlacementValues } from "@/lib/rental-application/placement-values";
import {
  previewQuickAddCsv,
  quickAddCsvTemplate,
  quickAddRowProblems,
  validateQuickAdd,
  type QuickAddCatalog,
  type QuickAddLeaseChoice,
  type QuickAddPreview,
  type QuickAddRaw,
} from "@/lib/resident-quick-add/model";
import {
  QUICK_ADD_DOCUMENT_KINDS,
  saveQuickAddResident,
  type QuickAddDocumentKind,
  type QuickAddFile,
  type QuickAddSaveContext,
} from "@/lib/resident-quick-add/save.client";

const MAX_PDF_BYTES = 3.5 * 1024 * 1024;
const DOCUMENT_ACCEPT = "application/pdf,image/*";

type PropertyOption = { id: string; label: string };
type Mode = "one" | "csv";
type LeaseSource = "generate" | "signed" | "draft" | "later";

const EMPTY: QuickAddRaw = { name: "", email: "", phone: "", house: "", room: "", moveIn: "", leaseEnd: "", rent: "", deposit: "", moveInFee: "", oneTimeCharges: [] };

function buildCatalog(options: readonly PropertyOption[]): QuickAddCatalog {
  return {
    houses: options.map((option) => {
      let rooms: { id: string; name: string }[] = [];
      try {
        if (isPropertyRentedByRoom(option.id)) {
          const listing = getPropertyById(option.id);
          const submission = listing?.listingSubmission ? normalizeManagerListingSubmissionV1(listing.listingSubmission) : null;
          rooms = (submission?.rooms ?? []).map((r) => ({ id: r.id, name: r.name || r.id }));
        }
      } catch {
        rooms = [];
      }
      return { id: option.id, label: option.label.split(" · ")[0]!.trim() || option.label, rooms };
    }),
  };
}

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

type ResultLine = { who: string; ok: boolean; messages: string[] };

export function QuickAddResidentsModal({
  open,
  onClose,
  onFullForm,
  onAdded,
  managerUserId,
  propertyOptions,
  propertyTick,
  executedLeaseKeys,
}: {
  open: boolean;
  onClose: () => void;
  /** Close this sheet and open the full Add resident wizard. */
  onFullForm: () => void;
  onAdded: () => void;
  managerUserId: string | null;
  propertyOptions: PropertyOption[];
  propertyTick: number;
  executedLeaseKeys: { axisIds: Set<string>; emails: Set<string> };
}) {
  const { showToast } = useAppUi();
  const catalog = useMemo(() => {
    void propertyTick;
    return buildCatalog(propertyOptions);
  }, [propertyOptions, propertyTick]);

  const [mode, setMode] = useState<Mode>("one");
  const [raw, setRaw] = useState<QuickAddRaw>(EMPTY);
  const [touched, setTouched] = useState(false);
  const [leaseSource, setLeaseSource] = useState<LeaseSource>("generate");
  const [leaseFile, setLeaseFile] = useState<File | null>(null);
  const [leaseDataUrl, setLeaseDataUrl] = useState("");
  const [files, setFiles] = useState<QuickAddFile[]>([]);
  const [csvName, setCsvName] = useState("");
  const [preview, setPreview] = useState<QuickAddPreview | null>(null);
  const [csvGenerate, setCsvGenerate] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [results, setResults] = useState<ResultLine[] | null>(null);

  useEffect(() => {
    if (!open) return;
    setMode("one");
    setRaw(EMPTY);
    setTouched(false);
    setLeaseSource("generate");
    setLeaseFile(null);
    setLeaseDataUrl("");
    setFiles([]);
    setCsvName("");
    setPreview(null);
    setBusy(null);
    setResults(null);
  }, [open]);

  const house = catalog.houses.find((h) => h.id === raw.house);
  const rooms = house?.rooms ?? [];
  const checked = useMemo(() => validateQuickAdd(raw, catalog), [raw, catalog]);
  const errors = checked.ok ? {} : checked.errors;
  const leaseNeedsFile = (leaseSource === "signed" || leaseSource === "draft") && !leaseDataUrl;
  const patch = (next: Partial<QuickAddRaw>) => setRaw((prev) => ({ ...prev, ...next }));

  const priceDefaults = (propertyId: string, roomId: string) => {
    if (!propertyId) return {};
    try {
      const priced = resolveManualResidentPlacementValues({ propertyId, roomId, leaseTerm: "long_term", leaseTermCustomMode: false });
      if (!priced) return {};
      return { rent: priced.rent && Number(priced.rent) > 0 ? priced.rent : "", deposit: priced.securityDeposit && Number(priced.securityDeposit) > 0 ? priced.securityDeposit : "" };
    } catch {
      return {};
    }
  };

  /** The listing's own rent/deposit for the pick, only into fields still blank. */
  const fillBlankPrices = (prev: QuickAddRaw, propertyId: string, roomId: string): Partial<QuickAddRaw> => {
    const priced = priceDefaults(propertyId, roomId) as { rent?: string; deposit?: string };
    return { ...(!prev.rent.trim() && priced.rent ? { rent: priced.rent } : {}), ...(!prev.deposit.trim() && priced.deposit ? { deposit: priced.deposit } : {}) };
  };

  const pickLease = async (file: File) => {
    if (file.type !== "application/pdf") {
      showToast("The lease must be a PDF.");
      return;
    }
    if (file.size > MAX_PDF_BYTES) {
      showToast("PDF too large (max 3.5 MB).");
      return;
    }
    try {
      setLeaseDataUrl(await readDataUrl(file));
      setLeaseFile(file);
      if (leaseSource === "generate" || leaseSource === "later") setLeaseSource("signed");
    } catch {
      showToast("Could not read that file.");
    }
  };

  const addFiles = (picked: File[]) =>
    setFiles((prev) => [...prev, ...picked.map((file) => ({ id: `${Date.now()}-${file.name}-${file.size}`, file, kind: "other_private" as QuickAddDocumentKind }))]);

  const saveContext = (sendGeneratedLease: boolean): QuickAddSaveContext => ({
    userId: managerUserId,
    executedLeaseKeys,
    propertyLabelFor: (id: string) => propertyOptions.find((p) => p.id === id)?.label,
    sendGeneratedLease,
  });

  const lines = (resident: string, outcome: Awaited<ReturnType<typeof saveQuickAddResident>>): ResultLine => ({
    who: resident,
    ok: outcome.applicationId !== null,
    messages: outcome.applicationId
      ? [`Link ${[outcome.emailed ? "emailed" : "", outcome.texted ? "texted" : ""].filter(Boolean).join(" and ") || "not sent"}`, ...outcome.problems]
      : outcome.problems,
  });

  const saveOne = async () => {
    setTouched(true);
    if (!checked.ok || leaseNeedsFile || busy) return;
    setBusy("Adding…");
    try {
      const choice: QuickAddLeaseChoice = leaseSource === "signed" ? "signed" : leaseSource === "draft" ? "draft" : "none";
      const outcome = await saveQuickAddResident(checked.value, { lease: { choice, file: leaseFile, dataUrl: leaseDataUrl }, files }, saveContext(leaseSource === "generate"));
      const line = lines(checked.value.name, outcome);
      if (outcome.applicationId) onAdded();
      if (outcome.applicationId && outcome.problems.length === 0) {
        showToast(`${checked.value.name} added. ${line.messages[0]}.`);
        onClose();
        return;
      }
      setResults([line]);
    } finally {
      setBusy(null);
    }
  };

  const pickCsv = async (file: File) => {
    if (!/\.csv$/i.test(file.name) && !/csv|text\/plain/i.test(file.type)) {
      showToast("Choose a .csv file.");
      return;
    }
    setCsvName(file.name);
    setPreview(previewQuickAddCsv(await file.text(), catalog));
  };

  const saveCsv = async () => {
    if (!preview || busy) return;
    const good = preview.rows.filter((r) => r.value);
    if (good.length === 0) return;
    const out: ResultLine[] = preview.rows
      .filter((r) => !r.value)
      .map((r) => ({ who: `Line ${r.line}${r.raw.name ? ` (${r.raw.name})` : ""}`, ok: false, messages: ["Not added: " + quickAddRowProblems(r).join(" ")] }));
    let added = 0;
    try {
      // One at a time: the room-capacity check and the local stores must see each resident before the next.
      for (const [index, row] of good.entries()) {
        setBusy(`Adding ${index + 1} of ${good.length}…`);
        const outcome = await saveQuickAddResident(row.value!, { lease: { choice: "none", file: null, dataUrl: "" }, files: [] }, saveContext(csvGenerate));
        if (outcome.applicationId) added += 1;
        out.push(lines(row.value!.name, outcome));
      }
    } finally {
      setBusy(null);
    }
    if (added > 0) onAdded();
    setResults(out);
  };

  const moneyInput = (key: "rent" | "deposit" | "moveInFee", label: string, required = false) => (
    <WizardField label={label} required={required}>
      <Input
        inputMode="decimal"
        placeholder="0"
        value={raw[key] ?? ""}
        onChange={(e) => patch({ [key]: e.target.value })}
        data-attr={`residents-quick-add-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`}
        aria-invalid={touched && Boolean(errors[key])}
      />
      {touched && errors[key] ? <span className="mt-1 block text-xs text-red-700">{errors[key]}</span> : null}
    </WizardField>
  );

  const fieldError = (key: keyof QuickAddRaw) => (touched && errors[key] ? <span className="mt-1 block text-xs text-red-700">{errors[key]}</span> : null);

  const footer = results ? (
    <ModalFooter>
      <Button type="button" onClick={onClose} data-attr="residents-quick-add-done">Done</Button>
    </ModalFooter>
  ) : (
    <ModalFooter>
      <Button type="button" variant="outline" onClick={onFullForm} data-attr="residents-quick-add-full-form" disabled={Boolean(busy)}>
        Full form
      </Button>
      {mode === "one" ? (
        <Button type="button" onClick={() => void saveOne()} disabled={Boolean(busy)} data-attr="residents-quick-add-save">
          {busy ?? "Add resident"}
        </Button>
      ) : (
        <Button type="button" onClick={() => void saveCsv()} disabled={Boolean(busy) || !preview || preview.okCount === 0} data-attr="residents-quick-add-csv-save">
          {busy ?? (preview && preview.okCount > 0 ? `Add ${preview.okCount} ${preview.okCount === 1 ? "resident" : "residents"}` : "Add residents")}
        </Button>
      )}
    </ModalFooter>
  );

  return (
    <Modal open={open} title="Add residents" onClose={() => (busy ? undefined : onClose())} dataAttr="residents-quick-add" contextPanel={null} preview={null} footer={footer}>
      {results ? (
        <div className="space-y-2" data-attr="residents-quick-add-results">
          {results.map((line, i) => (
            <div key={`${line.who}-${i}`} className="border-b border-border/60 pb-2 last:border-b-0">
              <div className="text-sm font-semibold">{line.who}</div>
              {line.messages.map((m, mi) => (
                <div key={m} className={line.ok && mi === 0 ? "text-sm text-muted" : "text-sm text-red-700"}>{m}</div>
              ))}
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex gap-2" role="tablist" aria-label="How to add">
            <Button type="button" variant={mode === "one" ? "primary" : "outline"} onClick={() => setMode("one")} data-attr="residents-quick-add-tab-one">One resident</Button>
            <Button type="button" variant={mode === "csv" ? "primary" : "outline"} onClick={() => setMode("csv")} data-attr="residents-quick-add-tab-csv">Several from a CSV</Button>
          </div>

          {mode === "one" ? (
            <>
              <WizardSection title="Resident" dataAttr="residents-quick-add-contact">
                <WizardRow cols={2}>
                  <WizardField label="Name" required>
                    <Input value={raw.name} onChange={(e) => patch({ name: e.target.value })} autoComplete="off" data-attr="residents-quick-add-name" aria-invalid={touched && Boolean(errors.name)} />
                    {fieldError("name")}
                  </WizardField>
                  <WizardField label="Email" required>
                    <Input type="email" value={raw.email} onChange={(e) => patch({ email: e.target.value })} autoComplete="off" data-attr="residents-quick-add-email" aria-invalid={touched && Boolean(errors.email)} />
                    {fieldError("email")}
                  </WizardField>
                  <WizardField label="Phone" required>
                    <Input type="tel" value={raw.phone} onChange={(e) => patch({ phone: e.target.value })} autoComplete="off" data-attr="residents-quick-add-phone" aria-invalid={touched && Boolean(errors.phone)} />
                    {fieldError("phone")}
                  </WizardField>
                </WizardRow>
              </WizardSection>

              <WizardSection title="Home" dataAttr="residents-quick-add-home">
                <WizardRow cols={2}>
                  <div>
                    <WizardSelect
                      label="House *"
                      value={raw.house}
                      onChange={(next) => setRaw((prev) => ({ ...prev, house: next, room: "", ...fillBlankPrices(prev, next, "") }))}
                      options={catalog.houses.map((h) => ({ value: h.id, label: h.label }))}
                      placeholder={catalog.houses.length ? "Select house…" : "No houses yet"}
                      dataAttr="residents-quick-add-house"
                    />
                    {fieldError("house")}
                  </div>
                  {rooms.length > 0 ? (
                    <div>
                      <WizardSelect
                        label="Room *"
                        value={raw.room}
                        onChange={(next) => setRaw((prev) => ({ ...prev, room: next, ...fillBlankPrices(prev, prev.house, next) }))}
                        options={rooms.map((r) => ({ value: r.id, label: r.name }))}
                        placeholder="Select room…"
                        dataAttr="residents-quick-add-room"
                      />
                      {fieldError("room")}
                    </div>
                  ) : null}
                </WizardRow>
              </WizardSection>

              <WizardSection title="Lease and rent" dataAttr="residents-quick-add-terms">
                <WizardRow cols={2}>
                  <WizardField label="Move-in" required>
                    <Input type="date" className="portal-modal-date-input" value={raw.moveIn} onChange={(e) => patch({ moveIn: e.target.value })} data-attr="residents-quick-add-move-in" aria-invalid={touched && Boolean(errors.moveIn)} />
                    {fieldError("moveIn")}
                  </WizardField>
                  <WizardField label="Lease end (blank = month-to-month)">
                    <Input type="date" className="portal-modal-date-input" value={raw.leaseEnd} onChange={(e) => patch({ leaseEnd: e.target.value })} data-attr="residents-quick-add-lease-end" aria-invalid={touched && Boolean(errors.leaseEnd)} />
                    {fieldError("leaseEnd")}
                  </WizardField>
                  {moneyInput("rent", "Monthly rent", true)}
                  {moneyInput("deposit", "Deposit")}
                  {moneyInput("moveInFee", "Move-in fee")}
                </WizardRow>
                <div className="mt-3 space-y-2" data-attr="residents-quick-add-charges">
                  {(raw.oneTimeCharges ?? []).map((charge, index) => (
                    <div key={index} className="flex items-end gap-2">
                      <WizardField label="One-time charge" className="min-w-0 flex-1">
                        <Input value={charge.label} placeholder="Name" onChange={(e) => patch({ oneTimeCharges: (raw.oneTimeCharges ?? []).map((c, i) => (i === index ? { ...c, label: e.target.value } : c)) })} data-attr="residents-quick-add-charge-label" />
                      </WizardField>
                      <WizardField label="Amount" className="w-32">
                        <Input inputMode="decimal" value={charge.amount} placeholder="0" onChange={(e) => patch({ oneTimeCharges: (raw.oneTimeCharges ?? []).map((c, i) => (i === index ? { ...c, amount: e.target.value } : c)) })} data-attr="residents-quick-add-charge-amount" />
                      </WizardField>
                      <PortalIconAction icon={X} label="Remove charge" onClick={() => patch({ oneTimeCharges: (raw.oneTimeCharges ?? []).filter((_, i) => i !== index) })} data-attr="residents-quick-add-charge-remove" />
                    </div>
                  ))}
                  {fieldError("oneTimeCharges")}
                  {(raw.oneTimeCharges ?? []).length < 5 ? (
                    <PortalIconAction icon={Plus} label="Add a one-time charge" onClick={() => patch({ oneTimeCharges: [...(raw.oneTimeCharges ?? []), { label: "", amount: "" }] })} data-attr="residents-quick-add-charge-add" />
                  ) : null}
                </div>
              </WizardSection>

              <WizardSection title="Upload" dataAttr="residents-quick-add-upload">
                <WizardSelect
                  label="Lease"
                  value={leaseSource}
                  onChange={(next) => setLeaseSource(next as LeaseSource)}
                  options={[
                    { value: "generate", label: "Generate and send for signature" },
                    { value: "signed", label: "Signed lease PDF" },
                    { value: "draft", label: "Draft lease PDF, send for signature" },
                    { value: "later", label: "Add the lease later" },
                  ]}
                  dataAttr="residents-quick-add-lease-source"
                />
                {leaseSource === "signed" || leaseSource === "draft" ? (
                  <div className="mt-2">
                    <WorkspaceFileCard accept="application/pdf" label="Lease PDF" fileName={leaseFile?.name ?? null} onPick={(f) => void pickLease(f)} dataAttr="residents-quick-add-lease-upload" inputDataAttr="residents-quick-add-lease-input" />
                    {touched && leaseNeedsFile ? <span className="mt-1 block text-xs text-red-700">Attach the lease PDF.</span> : null}
                  </div>
                ) : null}
                <div className="mt-3">
                  <WorkspaceFileCard accept={DOCUMENT_ACCEPT} label="ID and other documents" onPick={() => undefined} onPickMany={addFiles} dataAttr="residents-quick-add-docs-upload" inputDataAttr="residents-quick-add-docs-input" />
                </div>
                {files.map((entry) => (
                  <DocumentRow
                    key={entry.id}
                    doc={{ id: entry.id, file: entry.file, kind: entry.kind } as AttachedDocument}
                    kinds={QUICK_ADD_DOCUMENT_KINDS}
                    onKind={(kind) => setFiles((prev) => prev.map((f) => (f.id === entry.id ? { ...f, kind: kind as QuickAddDocumentKind } : f)))}
                    onRemove={() => setFiles((prev) => prev.filter((f) => f.id !== entry.id))}
                  />
                ))}
              </WizardSection>
            </>
          ) : (
            <>
              <WizardSection title="CSV" dataAttr="residents-quick-add-csv">
                <div className="mb-2 flex items-center justify-end">
                  <PortalIconAction icon={Download} label="Download template" onClick={() => download("residents-template.csv", quickAddCsvTemplate(catalog))} data-attr="residents-quick-add-template" />
                </div>
                <WorkspaceFileCard accept=".csv,text/csv" label="Residents CSV" fileName={csvName || null} onPick={(f) => void pickCsv(f)} dataAttr="residents-quick-add-csv-upload" inputDataAttr="residents-quick-add-csv-input" />
                <div className="mt-3">
                  <WizardSelect
                    label="Lease"
                    value={csvGenerate ? "generate" : "later"}
                    onChange={(next) => setCsvGenerate(next === "generate")}
                    options={[
                      { value: "generate", label: "Generate and send for signature" },
                      { value: "later", label: "Add leases later" },
                    ]}
                    dataAttr="residents-quick-add-csv-lease"
                  />
                </div>
              </WizardSection>
              {preview?.fileError ? <p className="text-sm text-red-700" data-attr="residents-quick-add-csv-error">{preview.fileError}</p> : null}
              {preview && !preview.fileError ? (
                <div className="overflow-x-auto" data-attr="residents-quick-add-preview">
                  <table className="w-full min-w-[560px] border-collapse text-left text-[13px]">
                    <thead>
                      <tr className="border-b border-border text-muted">
                        <th className="py-1.5 pr-3 font-semibold">Line</th>
                        <th className="py-1.5 pr-3 font-semibold">Name</th>
                        <th className="py-1.5 pr-3 font-semibold">House</th>
                        <th className="py-1.5 pr-3 font-semibold">Move-in</th>
                        <th className="py-1.5 pr-3 font-semibold">Rent</th>
                        <th className="py-1.5 font-semibold">Check</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.rows.map((row) => {
                        const problems = quickAddRowProblems(row);
                        return (
                          <tr key={row.line} className="border-b border-border/60 align-top" data-attr="residents-quick-add-preview-row" data-ok={problems.length === 0}>
                            <td className="py-1.5 pr-3 tabular-nums">{row.line}</td>
                            <td className="py-1.5 pr-3">{row.raw.name || "-"}</td>
                            <td className="py-1.5 pr-3">{row.raw.house}{row.raw.room ? ` · ${row.raw.room}` : ""}</td>
                            <td className="py-1.5 pr-3 tabular-nums">{row.raw.moveIn}</td>
                            <td className="py-1.5 pr-3 tabular-nums">{row.raw.rent}</td>
                            <td className={problems.length ? "py-1.5 text-red-700" : "py-1.5"}>{problems.length ? problems.map((p) => <div key={p}>{p}</div>) : "Ready"}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
