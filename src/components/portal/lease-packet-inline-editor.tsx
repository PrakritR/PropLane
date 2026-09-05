"use client";

import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/input";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { LeaseSectionEditor } from "@/components/portal/lease-section-editor";
import { patchLeasePacketFromManager } from "@/lib/lease-packet-edit.client";
import {
  buildLeasePacketUpdateFromForm,
  leasePacketFormAutoLeaseEnd,
  leasePacketFormRegeneratesDocument,
  leasePacketFormValuesEqual,
  leasePacketFormValuesFromRow,
  LEASE_PACKET_TERM_OPTIONS,
  type LeasePacketFormValues,
} from "@/lib/lease-packet-edit-form";
import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";
import { shouldAutoComputeLeaseEnd } from "@/lib/rental-application/lease-dates";
import { SHORT_TERM_LEASE_TERM } from "@/lib/rental-application/lease-terms";
import { cn } from "@/lib/utils";

const fieldLabelClass = "mb-1.5 block text-xs font-semibold uppercase tracking-[0.12em] text-muted";

type TermsEditSection = "placement" | "terms" | "fees" | "notes";

type Props = {
  row: LeasePipelineRow;
  managerUserId?: string | null;
  onSaved: (row: LeasePipelineRow) => void;
  className?: string;
  layout?: "default" | "panel" | "manager-review";
  /** Debounced save when values change — no manual Save button. */
  autoSave?: boolean;
  onGenerateLease?: () => void;
  generateLeaseDisabled?: boolean;
  generateLeaseTitle?: string;
};

function patchFormValues(values: LeasePacketFormValues, patch: Partial<LeasePacketFormValues>): LeasePacketFormValues {
  const next = { ...values, ...patch };
  if (patch.leaseTerm !== undefined || patch.leaseStart !== undefined || patch.rentalType !== undefined) {
    if (shouldAutoComputeLeaseEnd(next.leaseTerm, next.rentalType)) {
      next.leaseEnd = leasePacketFormAutoLeaseEnd(next);
    }
  }
  if (patch.rentalType === "short_term" && next.leaseTerm !== SHORT_TERM_LEASE_TERM) {
    next.leaseTerm = SHORT_TERM_LEASE_TERM;
  }
  if (patch.rentalType === "standard" && next.leaseTerm === SHORT_TERM_LEASE_TERM) {
    next.leaseTerm = "";
  }
  return next;
}

function formatMoney(value: string): string {
  const n = Number.parseFloat(value.replace(/[^0-9.-]/g, ""));
  if (!Number.isFinite(n) || n === 0) return value.trim() || "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
}

function LeaseDoubleClickSection({
  title,
  summary,
  editing,
  onStartEdit,
  onEndEdit,
  sectionId,
  children,
}: {
  title: string;
  summary: ReactNode;
  editing: boolean;
  onStartEdit: () => void;
  onEndEdit: () => void;
  sectionId: string;
  children: ReactNode;
}) {
  return (
    <section id={sectionId} className="scroll-mt-2">
      {editing ? (
        <div className="space-y-3 rounded-xl border border-primary/25 bg-card p-3 shadow-sm">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-foreground">{title}</h3>
            <Button type="button" variant="outline" className="h-7 rounded-full px-3 text-xs" onClick={onEndEdit}>
              Done
            </Button>
          </div>
          {children}
        </div>
      ) : (
        <button
          type="button"
          className="w-full cursor-text rounded-xl border border-border bg-card px-3 py-3 text-left transition hover:border-primary/25 hover:bg-foreground/[0.02]"
          title="Double-click to edit"
          onDoubleClick={onStartEdit}
          data-attr={`lease-edit-dblclick-${sectionId}`}
        >
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          <div className="mt-1.5 text-sm leading-relaxed text-muted">{summary}</div>
        </button>
      )}
    </section>
  );
}

export function LeasePacketInlineEditor({
  row,
  managerUserId,
  onSaved,
  className,
  layout = "default",
  autoSave = false,
  onGenerateLease,
  generateLeaseDisabled = false,
  generateLeaseTitle,
}: Props) {
  const { showToast } = useAppUi();
  const baseline = useMemo(() => leasePacketFormValuesFromRow(row), [row]);
  const [values, setValues] = useState<LeasePacketFormValues>(baseline);
  const [saving, setSaving] = useState(false);
  const [editingSection, setEditingSection] = useState<TermsEditSection | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const autoSaveSkipRef = useRef(true);

  useEffect(() => {
    setValues(leasePacketFormValuesFromRow(row));
    setEditingSection(null);
    autoSaveSkipRef.current = true;
  }, [row]);

  const dirty = !leasePacketFormValuesEqual(values, baseline);
  const willRegenerate = dirty && leasePacketFormValuesRegeneratesDocument(baseline, values);
  const leaseEndAuto = shouldAutoComputeLeaseEnd(values.leaseTerm, values.rentalType);
  const isPanel = layout === "panel";
  const isManagerReview = layout === "manager-review";

  const update = (patch: Partial<LeasePacketFormValues>) => {
    setValues((cur) => patchFormValues(cur, patch));
  };

  const reset = () => setValues(baseline);

  const save = async (options?: { silent?: boolean }) => {
    const built = buildLeasePacketUpdateFromForm(row.id, values, baseline);
    if (!built.ok) {
      if (!options?.silent) showToast(built.error);
      return;
    }
    setSaving(true);
    try {
      const result = await patchLeasePacketFromManager(built.input, managerUserId);
      if (!result.ok) {
        if (!options?.silent) showToast(result.error);
        return;
      }
      if (!options?.silent) {
        showToast(willRegenerate ? "Lease updated and document regenerated." : "Lease updated.");
      }
      onSaved(result.row);
      setEditingSection(null);
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    if (!autoSave || !dirty) return;
    if (autoSaveSkipRef.current) {
      autoSaveSkipRef.current = false;
      return;
    }
    const timer = window.setTimeout(() => {
      void save({ silent: true });
    }, 900);
    return () => window.clearTimeout(timer);
  }, [autoSave, dirty, values, baseline, row.id, managerUserId]);

  const termOptions =
    values.rentalType === "short_term"
      ? [SHORT_TERM_LEASE_TERM]
      : LEASE_PACKET_TERM_OPTIONS.filter((t) => t !== SHORT_TERM_LEASE_TERM);

  const placementSummary =
    values.unit.trim() || values.roomChoice.trim()
      ? [values.unit.trim(), values.roomChoice.trim()].filter(Boolean).join(" · ")
      : "Double-click to set unit and room.";

  const termsSummary =
    values.leaseStart || values.leaseTerm
      ? `${values.rentalType === "short_term" ? "Short-term" : "Long-term"} · ${values.leaseTerm || "No term"} · ${values.leaseStart || "—"} → ${values.leaseEnd || "—"}`
      : "Double-click to set lease dates and term.";

  const feesSummary =
    values.monthlyRent.trim() ||
    values.monthlyUtilities.trim() ||
    values.securityDeposit.trim() ||
    values.moveInFee.trim()
      ? `Rent ${formatMoney(values.monthlyRent)} · Utils ${formatMoney(values.monthlyUtilities)} · Deposit ${formatMoney(values.securityDeposit)} · Move-in ${formatMoney(values.moveInFee)}`
      : "Double-click to set fees.";

  const notesSummary = values.notes.trim() ? values.notes.trim() : "Double-click to add internal notes.";

  return (
    <form
      className={cn(
        "flex min-h-0 flex-col",
        isPanel ? "h-full gap-0" : "gap-4",
        className,
      )}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      data-attr="lease-packet-inline-editor"
    >
      {isPanel ? (
        <div className="shrink-0 border-b border-border pb-3">
          <p className="text-sm font-semibold text-foreground">{row.residentName || "Resident"}</p>
        </div>
      ) : null}

      {willRegenerate ? (
        <p
          className={cn(
            "rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950",
            isPanel ? "mx-0 mt-3 shrink-0" : "",
          )}
        >
          Term or fee changes will regenerate the lease document. It stays in manager review until you send it.
        </p>
      ) : null}

      <div
        ref={scrollRef}
        className={cn(
          "min-h-0 flex-1 overflow-y-auto overscroll-contain pr-0.5 [-webkit-overflow-scrolling:touch]",
          isPanel || isManagerReview ? "mt-3 space-y-3 pb-2" : "space-y-3",
        )}
      >
        {isManagerReview ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className={fieldLabelClass} htmlFor="lease-mgr-review-rent">
                Monthly rent
              </label>
              <Input
                id="lease-mgr-review-rent"
                inputMode="decimal"
                value={values.monthlyRent}
                onChange={(e) => update({ monthlyRent: e.target.value })}
                placeholder="0"
                data-attr="lease-mgr-review-rent"
              />
            </div>
            <div>
              <label className={fieldLabelClass} htmlFor="lease-mgr-review-deposit">
                Security deposit
              </label>
              <Input
                id="lease-mgr-review-deposit"
                inputMode="decimal"
                value={values.securityDeposit}
                onChange={(e) => update({ securityDeposit: e.target.value })}
                placeholder="0"
                data-attr="lease-mgr-review-deposit"
              />
            </div>
            <div>
              <label className={fieldLabelClass} htmlFor="lease-mgr-review-term">
                Lease term (in months)
              </label>
              <Select
                id="lease-mgr-review-term"
                value={values.leaseTerm}
                onChange={(e) => update({ leaseTerm: e.target.value })}
                data-attr="lease-mgr-review-term"
              >
                <option value="">Select term</option>
                {termOptions.map((term) => (
                  <option key={term} value={term}>
                    {term}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <label className={fieldLabelClass} htmlFor="lease-mgr-review-start">
                Start date
              </label>
              <Input
                id="lease-mgr-review-start"
                type="date"
                value={values.leaseStart}
                onChange={(e) => update({ leaseStart: e.target.value })}
                data-attr="lease-mgr-review-start"
              />
            </div>
          </div>
        ) : null}

        {!isManagerReview ? (
        <>
        <LeaseDoubleClickSection
          title="Placement"
          summary={placementSummary}
          editing={editingSection === "placement"}
          onStartEdit={() => setEditingSection("placement")}
          onEndEdit={() => setEditingSection(null)}
          sectionId="lease-section-placement"
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className={fieldLabelClass} htmlFor="lease-edit-unit">
                Unit label
              </label>
              <Input
                id="lease-edit-unit"
                value={values.unit}
                onChange={(e) => update({ unit: e.target.value })}
                placeholder="e.g. Room A · 123 Main St"
                data-attr="lease-edit-unit"
              />
            </div>
            <div>
              <label className={fieldLabelClass} htmlFor="lease-edit-room">
                Room
              </label>
              <Input
                id="lease-edit-room"
                value={values.roomChoice}
                onChange={(e) => update({ roomChoice: e.target.value })}
                placeholder="Room on lease"
                data-attr="lease-edit-room"
              />
            </div>
          </div>
        </LeaseDoubleClickSection>

        <LeaseDoubleClickSection
          title="Lease terms"
          summary={termsSummary}
          editing={editingSection === "terms"}
          onStartEdit={() => setEditingSection("terms")}
          onEndEdit={() => setEditingSection(null)}
          sectionId="lease-section-terms"
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className={fieldLabelClass} htmlFor="lease-edit-stay-type">
                Stay type
              </label>
              <Select
                id="lease-edit-stay-type"
                value={values.rentalType}
                onChange={(e) => update({ rentalType: e.target.value as LeasePacketFormValues["rentalType"] })}
                data-attr="lease-edit-stay-type"
              >
                <option value="standard">Long-term</option>
                <option value="short_term">Short-term</option>
              </Select>
            </div>
            <div>
              <label className={fieldLabelClass} htmlFor="lease-edit-term">
                Lease term
              </label>
              <Select
                id="lease-edit-term"
                value={values.leaseTerm}
                onChange={(e) => update({ leaseTerm: e.target.value })}
                data-attr="lease-edit-term"
              >
                <option value="">Select term</option>
                {termOptions.map((term) => (
                  <option key={term} value={term}>
                    {term}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <label className={fieldLabelClass} htmlFor="lease-edit-start">
                Start date
              </label>
              <Input
                id="lease-edit-start"
                type="date"
                value={values.leaseStart}
                onChange={(e) => update({ leaseStart: e.target.value })}
                data-attr="lease-edit-start"
              />
            </div>
            <div>
              <label className={fieldLabelClass} htmlFor="lease-edit-end">
                End date
              </label>
              <Input
                id="lease-edit-end"
                type="date"
                value={values.leaseEnd}
                onChange={(e) => update({ leaseEnd: e.target.value })}
                disabled={leaseEndAuto}
                data-attr="lease-edit-end"
              />
              {leaseEndAuto ? <p className="mt-1 text-xs text-muted">Calculated from start date and term.</p> : null}
            </div>
          </div>
        </LeaseDoubleClickSection>

        <LeaseDoubleClickSection
          title="Fees"
          summary={feesSummary}
          editing={editingSection === "fees"}
          onStartEdit={() => setEditingSection("fees")}
          onEndEdit={() => setEditingSection(null)}
          sectionId="lease-section-fees"
        >
          <div className="grid gap-3 sm:grid-cols-2">
            {(
              [
                ["monthlyRent", "Monthly rent", "lease-edit-rent"],
                ["monthlyUtilities", "Monthly utilities", "lease-edit-utilities"],
                ["securityDeposit", "Security deposit", "lease-edit-deposit"],
                ["moveInFee", "Move-in fee", "lease-edit-move-in"],
              ] as const
            ).map(([key, label, attr]) => (
              <div key={key}>
                <label className={fieldLabelClass} htmlFor={attr}>
                  {label}
                </label>
                <Input
                  id={attr}
                  inputMode="decimal"
                  value={values[key]}
                  onChange={(e) => update({ [key]: e.target.value })}
                  placeholder="0"
                  data-attr={attr}
                />
              </div>
            ))}
          </div>
        </LeaseDoubleClickSection>

        <LeaseDoubleClickSection
          title="Internal notes"
          summary={notesSummary}
          editing={editingSection === "notes"}
          onStartEdit={() => setEditingSection("notes")}
          onEndEdit={() => setEditingSection(null)}
          sectionId="lease-section-notes"
        >
          <Textarea
            id="lease-edit-notes"
            value={values.notes}
            onChange={(e) => update({ notes: e.target.value })}
            rows={4}
            placeholder="Notes visible to managers only"
            data-attr="lease-edit-notes"
          />
        </LeaseDoubleClickSection>

        <LeaseSectionEditor
          row={row}
          managerUserId={managerUserId}
          onSaved={onSaved}
          embedded
          fullHeight
          className="scroll-mt-2 border-t border-border pt-4"
        />
        </>
        ) : null}
      </div>

      {isManagerReview ? (
        <div className="mt-3 flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border pt-3">
          {autoSave && saving ? (
            <span className="text-xs text-muted" data-attr="lease-mgr-review-autosave">
              Saving…
            </span>
          ) : autoSave && dirty ? (
            <span className="text-xs text-muted">Unsaved changes…</span>
          ) : autoSave ? (
            <span className="text-xs text-muted">All changes saved</span>
          ) : null}
          {onGenerateLease ? (
            <Button
              type="button"
              variant="primary"
              className="rounded-full"
              disabled={generateLeaseDisabled || saving}
              title={generateLeaseTitle}
              data-attr="lease-mgr-review-generate"
              onClick={onGenerateLease}
            >
              Generate lease
            </Button>
          ) : null}
        </div>
      ) : (
      <div
        className={cn(
          "flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border bg-card pt-3",
          isPanel && dirty ? "shadow-[0_-4px_12px_-4px_rgba(0,0,0,0.08)]" : "",
          isPanel ? "mt-2" : "",
        )}
      >
        <Button type="button" variant="outline" className="rounded-full" disabled={!dirty || saving} onClick={reset}>
          Reset
        </Button>
        <Button
          type="submit"
          variant="primary"
          className="rounded-full"
          loading={saving}
          disabled={!dirty || saving}
          data-attr="lease-edit-save"
        >
          {saving ? "Saving…" : "Save changes"}
        </Button>
      </div>
      )}
    </form>
  );
}

function leasePacketFormValuesRegeneratesDocument(before: LeasePacketFormValues, after: LeasePacketFormValues): boolean {
  return leasePacketFormRegeneratesDocument(before, after);
}
