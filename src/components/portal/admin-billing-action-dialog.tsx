"use client";

import { useEffect, useState, type ReactNode } from "react";
import { PortalDialog } from "@/components/portal/portal-dialog";
import { Input } from "@/components/ui/input";

/** Longest reason the audit trail keeps (`MAX_REASON_CHARS` in admin-billing-audit.server). */
const REASON_MAX = 280;

/**
 * The small popup every staff billing change opens: the change's own fields, then a REQUIRED
 * one-line Reason, and one primary that names the outcome. The reason is the part a future reader
 * of the audit trail needs, so the primary stays off until there is one.
 *
 * `onSubmit` receives the trimmed reason and returns an error sentence to show in place (the popup
 * stays open with what was typed) or `null` once the change landed.
 */
export function AdminBillingActionDialog({
  open,
  title,
  submitLabel,
  onClose,
  onSubmit,
  canSubmit = true,
  dataAttr,
  children,
}: {
  open: boolean;
  title: string;
  /** Names the outcome — "Extend trial", "Apply code". Never "Save". */
  submitLabel: string;
  onClose: () => void;
  onSubmit: (reason: string) => Promise<string | null>;
  /** False until the dialog's own fields are valid. */
  canSubmit?: boolean;
  dataAttr: string;
  children?: ReactNode;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    queueMicrotask(() => {
      setReason("");
      setError(null);
      setBusy(false);
    });
  }, [open]);

  const trimmed = reason.trim();

  const submit = async () => {
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const failure = await onSubmit(trimmed);
      if (failure) setError(failure);
      else onClose();
    } catch {
      setError("Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <PortalDialog
      open={open}
      onClose={() => {
        if (!busy) onClose();
      }}
      dismissBlocked={busy}
      title={title}
      fullScreenMobile={false}
      dataAttr={dataAttr}
      primaryAction={{
        label: submitLabel,
        onClick: () => void submit(),
        disabled: !canSubmit || !trimmed || busy,
        loading: busy,
        dataAttr: `${dataAttr}-submit`,
      }}
    >
      <div className="flex flex-col gap-4">
        {children}
        <div className="flex flex-col gap-1.5">
          <label className="text-[13px] font-medium text-foreground" htmlFor={`${dataAttr}-reason`}>
            Reason
          </label>
          <Input
            id={`${dataAttr}-reason`}
            value={reason}
            maxLength={REASON_MAX}
            disabled={busy}
            required
            autoComplete="off"
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void submit();
              }
            }}
            data-attr={`${dataAttr}-reason`}
          />
        </div>
        {error ? (
          <p role="alert" className="text-[13px] text-[var(--status-overdue-fg)]" data-attr={`${dataAttr}-error`}>
            {error}
          </p>
        ) : null}
      </div>
    </PortalDialog>
  );
}
