"use client";

/**
 * Outgoing payments > Add expense / Edit expense pop-up (copies the Add property pop-up's shape:
 * a `PortalDialog` with labelled fields, the primary action is the data-commit). Amount, Date,
 * Category, the vendor's own Service (optional), Note and a private Receipt. The expense is saved
 * first, then the receipt is attached to it; a receipt that fails to attach leaves the saved
 * expense in place and says so.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Paperclip } from "lucide-react";
import { PortalDialog } from "@/components/portal/portal-dialog";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { Input } from "@/components/ui/input";
import {
  parseAmountToCents,
  todayLocalIso,
  VENDOR_EXPENSE_CATEGORIES,
  VENDOR_EXPENSE_MAX_CENTS,
  VENDOR_EXPENSE_MEMO_MAX,
  VENDOR_EXPENSE_RECEIPT_MAX_BYTES,
  type VendorExpense,
  type VendorExpenseCategory,
} from "@/lib/vendor-expenses";
import { readVendorDocumentDataUrl } from "@/lib/vendor-documents";

export type VendorExpenseServiceOption = { id: string; label: string };

function centsToField(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function VendorAddExpenseModal({
  open,
  expense,
  services,
  onClose,
  onSaved,
}: {
  open: boolean;
  /** The expense being edited; null adds a new one. */
  expense: VendorExpense | null;
  services: VendorExpenseServiceOption[];
  onClose: () => void;
  /** Called with the saved expense (receipt included) once everything that could be saved was. */
  onSaved: (expense: VendorExpense, note?: string) => void;
}) {
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(todayLocalIso());
  const [category, setCategory] = useState<VendorExpenseCategory>("materials");
  const [serviceId, setServiceId] = useState("");
  const [memo, setMemo] = useState("");
  const [receipt, setReceipt] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setAmount(expense ? centsToField(expense.amountCents) : "");
    setDate(expense?.expenseDate || todayLocalIso());
    setCategory(expense?.category ?? "materials");
    setServiceId(expense?.workOrderId ?? "");
    setMemo(expense?.memo ?? "");
    setReceipt(null);
    setError(null);
  }, [open, expense]);

  const serviceOptions = useMemo(() => {
    const options = [{ value: "", label: "No service" }, ...services.map((s) => ({ value: s.id, label: s.label }))];
    // An expense linked to a service that is no longer in the list still shows its link.
    if (expense?.workOrderId && !services.some((s) => s.id === expense.workOrderId)) {
      options.push({ value: expense.workOrderId, label: expense.workOrderTitle ?? "Linked service" });
    }
    return options;
  }, [services, expense]);

  async function save() {
    if (saving) return;
    const cents = parseAmountToCents(amount);
    if (cents === null) {
      setError("Enter an amount greater than zero, like 38.40.");
      return;
    }
    if (cents > VENDOR_EXPENSE_MAX_CENTS) {
      setError("That amount is too large.");
      return;
    }
    if (!date) {
      setError("Choose a date.");
      return;
    }
    if (receipt && receipt.size > VENDOR_EXPENSE_RECEIPT_MAX_BYTES) {
      setError("The receipt must be 5 MB or smaller.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(expense ? `/api/vendor/expenses/${encodeURIComponent(expense.id)}` : "/api/vendor/expenses", {
        method: expense ? "PATCH" : "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amountCents: cents,
          expenseDate: date,
          category,
          memo: memo.trim() || null,
          workOrderId: serviceId || null,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { expense?: VendorExpense; error?: string };
      if (!res.ok || !body.expense) {
        setError(body.error ?? "Could not save the expense.");
        return;
      }
      let saved = body.expense;
      let note: string | undefined;
      if (receipt) {
        try {
          const dataUrl = await readVendorDocumentDataUrl(receipt);
          const receiptRes = await fetch(`/api/vendor/expenses/${encodeURIComponent(saved.id)}/receipt`, {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ dataUrl }),
          });
          const receiptBody = (await receiptRes.json().catch(() => ({}))) as { error?: string };
          if (receiptRes.ok) saved = { ...saved, hasReceipt: true };
          else note = `Expense saved, but the receipt did not upload: ${receiptBody.error ?? "try again from the row menu."}`;
        } catch {
          note = "Expense saved, but the receipt did not upload. Add it again from the row menu.";
        }
      }
      onSaved(saved, note);
    } catch {
      setError("Could not save the expense.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <PortalDialog
      open={open}
      onClose={() => {
        if (!saving) onClose();
      }}
      title={expense ? "Edit expense" : "Add expense"}
      size="wizard"
      dataAttr="vendor-expense-dialog"
      dismissBlocked={saving}
      primaryAction={{
        label: saving ? "Saving…" : "Save",
        onClick: save,
        loading: saving,
        disabled: saving,
        dataAttr: "vendor-expense-save",
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs font-medium text-muted">
          Amount
          <Input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            placeholder="0.00"
            autoComplete="off"
            data-attr="vendor-expense-amount"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-muted">
          Date
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} data-attr="vendor-expense-date" />
        </label>
        <FieldSingleSelect
          label="Category"
          value={category}
          onChange={(next) => setCategory(next as VendorExpenseCategory)}
          options={VENDOR_EXPENSE_CATEGORIES.map((c) => ({ value: c.id, label: c.label }))}
          dataAttr="vendor-expense-category"
        />
        <FieldSingleSelect
          label="Service"
          value={serviceId}
          onChange={setServiceId}
          options={serviceOptions}
          dataAttr="vendor-expense-service"
        />
        <label className="flex flex-col gap-1 text-xs font-medium text-muted sm:col-span-2">
          Note
          <Input
            value={memo}
            maxLength={VENDOR_EXPENSE_MEMO_MAX}
            onChange={(e) => setMemo(e.target.value)}
            data-attr="vendor-expense-note"
          />
        </label>
        <div className="flex flex-col gap-1 text-xs font-medium text-muted sm:col-span-2">
          Receipt
          <button
            type="button"
            className="inline-flex h-10 items-center gap-2 rounded-lg border border-border bg-card px-3 text-left text-sm font-normal text-foreground hover:bg-accent/40"
            onClick={() => fileRef.current?.click()}
            data-attr="vendor-expense-receipt"
          >
            <Paperclip className="size-4 shrink-0 text-muted" aria-hidden />
            <span className="min-w-0 truncate">
              {receipt ? receipt.name : expense?.hasReceipt ? "Replace the receipt" : "Upload a photo or PDF"}
            </span>
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/pdf,image/jpeg,image/png,image/webp"
            className="hidden"
            data-attr="vendor-expense-receipt-input"
            onChange={(e) => {
              setReceipt(e.target.files?.[0] ?? null);
              e.target.value = "";
            }}
          />
        </div>
        {error ? (
          <p role="alert" className="text-sm text-danger sm:col-span-2" data-attr="vendor-expense-error">
            {error}
          </p>
        ) : null}
      </div>
    </PortalDialog>
  );
}
