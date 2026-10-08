"use client";

import { useEffect, useRef, useState } from "react";
import { Paperclip } from "lucide-react";
import { AddWorkspace, type AddWorkspaceStep } from "@/components/portal/add-workspace";
import { useWorkspaceDraft } from "@/components/portal/add-workspace/draft";
import {
  PreviewPanel,
  ReviewCard,
  WizardField,
  WizardSection,
  WizardSelect,
} from "@/components/portal/add-workspace/parts";
import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-field";
import { Input } from "@/components/ui/input";
import { pacificCalendarDateYmd } from "@/lib/pacific-time";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import {
  EXPENSE_CATEGORIES,
  EXPENSE_RECURRENCES,
  EXPENSE_RECURRENCE_LABELS,
  expenseCategoryLabel,
  formatCents,
  type ExpenseRecurrence,
  type PlatformExpense,
} from "@/lib/admin/platform-expense-rules";

const RECEIPT_MIME = ["application/pdf", "image/png", "image/jpeg", "image/webp", "image/heic"];
const RECEIPT_MAX_BYTES = 10 * 1024 * 1024;

type Draft = {
  stepIdx: number;
  vendor: string;
  category: string;
  amount: string;
  spentOn: string;
  recurrence: ExpenseRecurrence;
  endsOn: string;
  note: string;
  receiptPath: string | null;
  receiptName: string;
};

function freshDraft(): Draft {
  return {
    stepIdx: 0,
    vendor: "",
    category: "",
    amount: "",
    spentOn: pacificCalendarDateYmd(),
    recurrence: "none",
    endsOn: "",
    note: "",
    receiptPath: null,
    receiptName: "",
  };
}

function draftFromExpense(expense: PlatformExpense): Draft {
  return {
    stepIdx: 0,
    vendor: expense.vendor,
    category: expense.category,
    amount: (expense.amountCents / 100).toFixed(2),
    spentOn: expense.spentOn,
    recurrence: expense.recurrence,
    endsOn: expense.endsOn ?? "",
    note: expense.note,
    receiptPath: expense.receiptPath,
    receiptName: expense.receiptPath ? (expense.receiptPath.split("/").pop() ?? "Receipt") : "",
  };
}

/** Dollars typed by hand ("1,234.5") to whole cents; null when it is not a positive amount. */
export function parseExpenseAmountCents(raw: string): number | null {
  const cleaned = raw.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{0,2})?$/.test(cleaned)) return null;
  const cents = Math.round(Number(cleaned) * 100);
  return Number.isFinite(cents) && cents > 0 ? cents : null;
}

function sanitizeAmountInput(raw: string): string {
  const cleaned = raw.replace(/[^0-9.]/g, "");
  const [whole = "", ...rest] = cleaned.split(".");
  return rest.length ? `${whole}.${rest.join("").slice(0, 2)}` : whole;
}

const CATEGORY_OPTIONS = EXPENSE_CATEGORIES.map((c) => ({ value: c.id, label: c.label }));
const RECURRENCE_OPTIONS = EXPENSE_RECURRENCES.map((r) => ({ value: r, label: EXPENSE_RECURRENCE_LABELS[r] }));

/**
 * Add expense — the New property wizard standard (AddWorkspace). Steps: Details, Repeat, Receipt, Review.
 * A receipt goes straight to the private bucket through a server-minted signed upload; the expense only
 * stores its path. Editing reuses the same workspace with the row filled in.
 */
export function AdminAddExpenseWizard({
  open,
  editing = null,
  onClose,
  onSaved,
}: {
  open: boolean;
  /** The expense being edited, or null to add one. */
  editing?: PlatformExpense | null;
  onClose: () => void;
  onSaved: (expense: PlatformExpense) => void;
}) {
  const [draft, setDraft] = useState<Draft>(freshDraft);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receiptError, setReceiptError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const set = (patch: Partial<Draft>) => setDraft((prev) => ({ ...prev, ...patch }));

  useEffect(() => {
    if (!open) return;
    setError(null);
    setReceiptError(null);
    setBusy(false);
    if (editing) setDraft(draftFromExpense(editing));
  }, [open, editing]);

  const workspaceDraft = useWorkspaceDraft<Draft>({
    scope: `admin-add-expense:${editing?.id ?? "new"}`,
    open,
    value: draft,
    restore: (saved) => setDraft(saved),
  });

  const amountCents = parseExpenseAmountCents(draft.amount);
  const vendorOk = draft.vendor.trim().length > 0;
  const detailsOk = vendorOk && Boolean(draft.category) && amountCents !== null && Boolean(draft.spentOn);
  const recurring = draft.recurrence !== "none";
  const endsOk = !recurring || !draft.endsOn || draft.endsOn >= draft.spentOn;

  const steps: AddWorkspaceStep[] = [
    { id: "details", label: "Details", incomplete: !detailsOk, summary: draft.vendor.trim() || "Vendor and amount" },
    { id: "repeat", label: "Repeat", incomplete: !endsOk, summary: EXPENSE_RECURRENCE_LABELS[draft.recurrence] },
    { id: "receipt", label: "Receipt", summary: draft.receiptPath ? draft.receiptName || "Attached" : "None" },
    { id: "review", label: "Review", summary: editing ? "Save expense" : "Add expense" },
  ];
  const current = Math.min(draft.stepIdx, steps.length - 1);
  const stepId = steps[current]!.id;
  const canSave = detailsOk && endsOk && !busy && !uploading;

  const uploadReceipt = async (file: File) => {
    setReceiptError(null);
    if (!RECEIPT_MIME.includes(file.type)) {
      setReceiptError("Use a PDF or an image (PNG, JPG, WebP, HEIC).");
      return;
    }
    if (file.size > RECEIPT_MAX_BYTES) {
      setReceiptError("Receipts are up to 10 MB.");
      return;
    }
    setUploading(true);
    try {
      const res = await fetch("/api/admin/expenses/receipt", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileName: file.name, mimeType: file.type, sizeBytes: file.size }),
      });
      const slot = (await res.json().catch(() => ({}))) as { path?: string; token?: string; bucket?: string; error?: string };
      if (!res.ok || !slot.path || !slot.token || !slot.bucket) {
        setReceiptError(slot.error ?? "Could not start the upload.");
        return;
      }
      const { error: uploadError } = await createSupabaseBrowserClient()
        .storage.from(slot.bucket)
        .uploadToSignedUrl(slot.path, slot.token, file, { contentType: file.type });
      if (uploadError) {
        setReceiptError("Upload failed. Try again.");
        return;
      }
      set({ receiptPath: slot.path, receiptName: file.name });
    } catch {
      setReceiptError("Upload failed. Try again.");
    } finally {
      setUploading(false);
    }
  };

  const save = async () => {
    if (!canSave || amountCents === null) return;
    setBusy(true);
    setError(null);
    try {
      const body = {
        ...(editing ? { id: editing.id } : {}),
        category: draft.category,
        vendor: draft.vendor.trim(),
        amountCents,
        spentOn: draft.spentOn,
        recurrence: draft.recurrence,
        endsOn: recurring && draft.endsOn ? draft.endsOn : null,
        receiptPath: draft.receiptPath,
        note: draft.note.trim(),
      };
      const res = await fetch("/api/admin/expenses", {
        method: editing ? "PATCH" : "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => ({}))) as { expense?: PlatformExpense; error?: string };
      if (!res.ok || !json.expense) {
        setError(json.error ?? "Could not save the expense.");
        return;
      }
      workspaceDraft.clear();
      setDraft(freshDraft());
      onSaved(json.expense);
    } catch {
      setError("Could not reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  const amountText = amountCents !== null ? formatCents(amountCents) : "Not set";
  const repeatText = recurring
    ? `${EXPENSE_RECURRENCE_LABELS[draft.recurrence]}${draft.endsOn ? ` until ${draft.endsOn}` : ""}`
    : "One-time";

  return (
    <div data-attr="admin-add-expense-wizard">
      <AddWorkspace
        title={editing ? "Edit expense" : "Add expense"}
        steps={steps}
        current={current}
        onJump={(index) => set({ stepIdx: index })}
        onClose={() => {
          workspaceDraft.preserve();
          onClose();
        }}
        keepsDraft
        onDiscardDraft={() => {
          workspaceDraft.clear();
          setDraft(editing ? draftFromExpense(editing) : freshDraft());
        }}
        dirty={Boolean(draft.vendor || draft.amount)}
        discardTitle="Discard this expense?"
        assistantContext="Adding one of PropLane's own expenses to Finances."
        assistantScopeKey="admin-add-expense"
        lastLabel={editing ? "Save expense" : "Add expense"}
        lastDisabled={!canSave}
        nextDisabled={(stepId === "details" && !detailsOk) || (stepId === "repeat" && !endsOk) || uploading}
        busy={busy}
        onFinish={() => void save()}
        dataAttrPrefix="admin-add-expense"
        finishDataAttr="admin-add-expense-save"
        sidePanel={
          <PreviewPanel
            title="Expense preview"
            name={draft.vendor.trim() || "Vendor"}
            sub={draft.category ? expenseCategoryLabel(draft.category) : "Pick a category"}
            facts={[
              { label: "Amount", value: amountText, warn: amountCents === null },
              { label: "First charge", value: draft.spentOn || "Not set" },
              { label: "Repeats", value: repeatText },
              { label: "Receipt", value: draft.receiptPath ? "Attached" : "None" },
            ]}
            creates={[
              { tone: detailsOk ? "yes" : "warn", text: recurring ? "A charge in every month it covers" : "A charge in its month" },
              { tone: "yes", text: "Counted against profit on Finances" },
            ]}
          />
        }
      >
        {stepId === "details" ? (
          <WizardSection title="Details">
            <WizardField label="Vendor" required>
              <Input value={draft.vendor} onChange={(e) => set({ vendor: e.target.value })} maxLength={120} data-attr="admin-expense-vendor" />
            </WizardField>
            <div className="mt-3">
              <WizardSelect
                label="Category *"
                value={draft.category}
                onChange={(category) => set({ category })}
                options={CATEGORY_OPTIONS}
                placeholder="Select category"
                dataAttr="admin-expense-category"
              />
            </div>
            <div className="mt-3">
              <WizardField label="Amount" required>
                <Input
                  value={draft.amount}
                  onChange={(e) => set({ amount: sanitizeAmountInput(e.target.value) })}
                  inputMode="decimal"
                  placeholder="0.00"
                  data-attr="admin-expense-amount"
                />
              </WizardField>
            </div>
            <div className="mt-3">
              <WizardField label="Date" required>
                <DateField value={draft.spentOn} onChange={(spentOn) => set({ spentOn })} data-attr="admin-expense-date" />
              </WizardField>
            </div>
            <div className="mt-3">
              <WizardField label="Note">
                <Input value={draft.note} onChange={(e) => set({ note: e.target.value })} maxLength={500} data-attr="admin-expense-note" />
              </WizardField>
            </div>
          </WizardSection>
        ) : null}

        {stepId === "repeat" ? (
          <WizardSection title="Repeat">
            <WizardSelect
              label="Repeats"
              value={draft.recurrence}
              onChange={(next) => set({ recurrence: next as ExpenseRecurrence, endsOn: next === "none" ? "" : draft.endsOn })}
              options={RECURRENCE_OPTIONS}
              dataAttr="admin-expense-recurrence"
            />
            {recurring ? (
              <div className="mt-3">
                <WizardField label="End date">
                  <DateField value={draft.endsOn} onChange={(endsOn) => set({ endsOn })} min={draft.spentOn} data-attr="admin-expense-ends" />
                </WizardField>
                {!endsOk ? (
                  <p role="alert" className="mt-2 text-sm font-semibold text-danger">
                    The end date is before the first charge.
                  </p>
                ) : null}
              </div>
            ) : null}
          </WizardSection>
        ) : null}

        {stepId === "receipt" ? (
          <WizardSection title="Receipt">
            <input
              ref={fileRef}
              type="file"
              accept={RECEIPT_MIME.join(",")}
              className="sr-only"
              data-attr="admin-expense-receipt-input"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) void uploadReceipt(file);
              }}
            />
            <div className="flex items-center gap-3">
              <span className="grid size-10 shrink-0 place-items-center rounded-[10px] bg-accent/60 text-muted/80">
                <Paperclip className="size-5" strokeWidth={1.6} aria-hidden />
              </span>
              <span className="min-w-0 flex-1 truncate text-[14px] font-semibold text-foreground">
                {uploading ? "Uploading" : draft.receiptPath ? draft.receiptName || "Receipt attached" : "No receipt"}
              </span>
              <Button type="button" variant="outline" disabled={uploading} onClick={() => fileRef.current?.click()} data-attr="admin-expense-receipt-choose">
                {draft.receiptPath ? "Replace" : "Choose file"}
              </Button>
              {draft.receiptPath ? (
                <Button type="button" variant="danger" disabled={uploading} onClick={() => set({ receiptPath: null, receiptName: "" })} data-attr="admin-expense-receipt-remove">
                  Remove
                </Button>
              ) : null}
            </div>
            {receiptError ? (
              <p role="alert" className="mt-2 text-sm font-semibold text-danger">
                {receiptError}
              </p>
            ) : null}
          </WizardSection>
        ) : null}

        {stepId === "review" ? (
          <div>
            <ReviewCard
              title="Details"
              status={detailsOk ? "complete" : "incomplete"}
              onEdit={() => set({ stepIdx: 0 })}
              facts={[
                { label: "Vendor", value: draft.vendor.trim() || "Not set", missing: !vendorOk },
                { label: "Category", value: draft.category ? expenseCategoryLabel(draft.category) : "Not set", missing: !draft.category },
                { label: "Amount", value: amountText, missing: amountCents === null },
                { label: "Date", value: draft.spentOn || "Not set" },
              ]}
            />
            <ReviewCard
              title="Repeat"
              status={endsOk ? "complete" : "incomplete"}
              onEdit={() => set({ stepIdx: 1 })}
              facts={[{ label: "Repeats", value: repeatText }]}
            />
            <ReviewCard
              title="Receipt"
              status="optional"
              onEdit={() => set({ stepIdx: 2 })}
              facts={[{ label: "Receipt", value: draft.receiptPath ? draft.receiptName || "Attached" : "None" }]}
            />
            {error ? (
              <p role="alert" className="mt-2 rounded-lg border px-3 py-2 text-sm font-semibold portal-banner-danger">
                {error}
              </p>
            ) : null}
          </div>
        ) : null}
      </AddWorkspace>
    </div>
  );
}
