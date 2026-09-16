"use client";

/**
 * Payments — what the lease bills and what has already been paid.
 *
 * The recurring schedule and the one-time charges are derived from the Lease
 * step (amounts edit there). The months between move-in and today are listed
 * for the manager to mark paid, due or partial; those marks are applied to the
 * charges the generator writes at commit, and every paid row reaches the
 * ledger through the mirror's write-through path.
 */

import { useMemo } from "react";
import { StepColumn, StepHeading } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import { Input } from "@/components/ui/input";
import { WizardChip, WizardLine, WizardSection,
  WizardSelect,
} from "@/components/portal/add-workspace/parts";
import type { ResidentWizardDerived } from "./derived";
import { formatMoney, PAYMENT_METHOD_OPTIONS, paymentSchedulePreview, type AddPersonForm, type PaymentMark, type PaymentRowStatus } from "./state";

const STATUS_OPTIONS: { value: PaymentRowStatus; label: string }[] = [
  { value: "paid", label: "Paid" },
  { value: "due", label: "Due" },
  { value: "partial", label: "Partial" },
];

function moneyOr0(raw: string): number {
  const n = Number(raw.replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

export function PaymentsStep({
  form,
  patch,
  derived,
}: {
  form: AddPersonForm;
  patch: (next: Partial<AddPersonForm>) => void;
  derived: ResidentWizardDerived;
}) {
  const rows = useMemo(() => paymentSchedulePreview(form), [form]);
  const rent = moneyOr0(form.rent);
  const utilities = moneyOr0(form.utilities);
  const other = moneyOr0(form.otherFeeAmount);
  const deposit = moneyOr0(form.securityDeposit);
  const moveInFee = moneyOr0(form.moveInFee);
  const dueLabel = form.rentDueDay === "last" ? "last day" : form.rentDueDay === "15" ? "15th" : "1st";
  const termLabel = form.moveInDate && form.moveOutDate ? `${form.moveInDate} → ${form.moveOutDate}` : form.moveInDate ? `from ${form.moveInDate}` : "dates on Lease";
  const setMark = (monthKey: string, next: Partial<PaymentMark>, row: { dueOn: string }) => {
    const current: PaymentMark = form.paymentMarks[monthKey] ?? { status: "paid", paidOn: row.dueOn, method: "zelle" };
    patch({ paymentMarks: { ...form.paymentMarks, [monthKey]: { ...current, ...next } } });
  };
  const markFor = (monthKey: string, row: { dueOn: string; isCurrent: boolean }): PaymentMark =>
    form.paymentMarks[monthKey] ?? { status: row.isCurrent ? "due" : "paid", paidOn: row.dueOn, method: "zelle" };
  const visibleRows = form.billingStart === "next_due" ? [] : rows;
  const paidTotal = visibleRows.reduce((sum, r) => (markFor(r.monthKey, r).status === "paid" ? sum + r.total : sum), 0);
  const dueTotal = visibleRows.reduce((sum, r) => {
    const m = markFor(r.monthKey, r);
    if (m.status === "due") return sum + r.total;
    if (m.status === "partial") return sum + Math.max(0, r.total - moneyOr0(m.partialAmount ?? ""));
    return sum;
  }, 0);

  if (derived.isAirbnb || derived.isShortTerm) {
    return (
      <StepColumn>
        <StepHeading title="Payments" />
        <WizardSection title={derived.isAirbnb ? "Calendar-only stay" : "Short-term stay"} chip={<WizardChip>from Lease</WizardChip>}>
          <WizardLine label={derived.isAirbnb ? "Airbnb stays are calendar-only — nothing is billed through PropLane." : "A short-term stay bills its total up front; nothing recurs."} />
        </WizardSection>
      </StepColumn>
    );
  }

  return (
    <StepColumn>
      <StepHeading title="Payments" />
      <WizardSection title="Recurring — from the lease" chip={<WizardChip>edit amounts on Lease</WizardChip>} dataAttr="residents-wizard-payments-recurring">
        {rent > 0 ? <WizardLine label={<>Rent · {formatMoney(rent)} every month on the {dueLabel} · {termLabel}</>} chip={<WizardChip tone="ok">recurring</WizardChip>} /> : <WizardLine label="Rent not set — enter it on Lease" chip={<WizardChip tone="warn">missing</WizardChip>} />}
        {utilities > 0 ? <WizardLine label={<>Utilities · {formatMoney(utilities)} every month with rent</>} chip={<WizardChip tone="ok">recurring</WizardChip>} /> : null}
        {other > 0 ? <WizardLine label={<>{form.otherFeeLabel.trim() || "Other fee"} · {formatMoney(other)} every month with rent</>} chip={<WizardChip tone="ok">recurring</WizardChip>} /> : null}
        <WizardLine
          label="Billing starts"
          control={
            <span className="w-[220px]">
              <WizardSelect
                label="Billing starts"
                hideLabel
                value={form.billingStart}
                onChange={(next) => patch({ billingStart: next === "next_due" ? "next_due" : "move_in" })}
                options={[
                  { value: "move_in", label: "From move-in", hint: "past months listed below" },
                  { value: "next_due", label: "Next due date", hint: "nothing before it" },
                ]}
                variant="cell"
                dataAttr="residents-wizard-billing-start"
              />
            </span>
          }
        />
      </WizardSection>

      {deposit > 0 || moveInFee > 0 ? (
        <WizardSection title="One-time — from the lease" dataAttr="residents-wizard-payments-one-time">
          {deposit > 0 ? (
            <WizardLine
              label={<>Security deposit · {formatMoney(deposit)}</>}
              control={
                <span className="w-[140px]">
                  <WizardSelect label="Deposit" hideLabel value={form.depositPaid ? "paid" : "due"} onChange={(next) => patch({ depositPaid: next === "paid" })} options={[{ value: "paid", label: "Paid" }, { value: "due", label: "Due" }]} variant="cell" dataAttr="residents-wizard-deposit-status" />
                </span>
              }
            />
          ) : null}
          {moveInFee > 0 ? (
            <WizardLine
              label={<>Move-in fee · {formatMoney(moveInFee)}</>}
              control={
                <span className="w-[140px]">
                  <WizardSelect label="Move-in fee" hideLabel value={form.moveInFeePaid ? "paid" : "due"} onChange={(next) => patch({ moveInFeePaid: next === "paid" })} options={[{ value: "paid", label: "Paid" }, { value: "due", label: "Due" }]} variant="cell" dataAttr="residents-wizard-move-in-fee-status" />
                </span>
              }
            />
          ) : null}
          {form.depositPaid || form.moveInFeePaid ? (
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1.5 block text-[12.5px] font-bold text-foreground">Paid on</span>
                <Input type="date" className="portal-modal-date-input" value={form.oneTimePaidOn || form.moveInDate} onChange={(e) => patch({ oneTimePaidOn: e.target.value })} data-attr="residents-wizard-one-time-paid-on" />
              </label>
              <WizardSelect label="Method" value={form.oneTimeMethod} onChange={(next) => patch({ oneTimeMethod: next })} options={PAYMENT_METHOD_OPTIONS} dataAttr="residents-wizard-one-time-method" />
            </div>
          ) : null}
        </WizardSection>
      ) : null}

      <WizardSection
        title="Past & current payments"
        chip={<WizardChip>{visibleRows.length ? `${visibleRows[0]!.label} → today` : form.moveInDate ? "nothing yet" : "set move-in on Lease"}</WizardChip>}
        dataAttr="residents-wizard-payments-past"
      >
        {visibleRows.length === 0 ? (
          <WizardLine label={form.billingStart === "next_due" ? "Nothing before the next due date is owed through PropLane." : form.moveInDate ? "Move-in is in the future — the schedule starts then." : "Set a move-in date on Lease to list the months."} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-[13.5px]">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-[0.04em] text-muted">
                  <th className="pb-2 pr-2 font-bold">For</th>
                  <th className="pb-2 pr-2 font-bold">Amount</th>
                  <th className="pb-2 pr-2 font-bold">Paid on</th>
                  <th className="pb-2 pr-2 font-bold">Method</th>
                  <th className="pb-2 font-bold">Status</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row) => {
                  const mark = markFor(row.monthKey, row);
                  return (
                    <tr key={row.monthKey} className="border-t border-border/60" data-attr={`residents-wizard-payment-${row.monthKey}`}>
                      <td className="py-2 pr-2 align-middle">
                        <span className="block font-bold text-foreground">
                          {row.label}
                          {row.isCurrent ? <WizardChip> current</WizardChip> : null}
                        </span>
                        <span className="block text-[12px] text-muted">{row.detail}</span>
                      </td>
                      <td className="py-2 pr-2 align-middle tabular-nums text-foreground">{formatMoney(row.total)}</td>
                      <td className="py-2 pr-2 align-middle">
                        {mark.status !== "due" ? (
                          <Input type="date" className="portal-modal-date-input min-h-[34px] text-[13px]" value={mark.paidOn} onChange={(e) => setMark(row.monthKey, { paidOn: e.target.value }, row)} aria-label={`${row.label} paid on`} />
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                      </td>
                      <td className="py-2 pr-2 align-middle">
                        {mark.status !== "due" ? (
                          <WizardSelect label="Method" hideLabel value={mark.method} onChange={(next) => setMark(row.monthKey, { method: next }, row)} options={PAYMENT_METHOD_OPTIONS} variant="cell" dataAttr={`residents-wizard-payment-method-${row.monthKey}`} />
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                      </td>
                      <td className="py-2 align-middle">
                        <WizardSelect label="Status" hideLabel value={mark.status} onChange={(next) => setMark(row.monthKey, { status: next as PaymentRowStatus }, row)} options={STATUS_OPTIONS} variant="cell" dataAttr={`residents-wizard-payment-status-${row.monthKey}`} />
                        {mark.status === "partial" ? (
                          <span className="relative mt-1 block">
                            <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[12px] text-muted">$</span>
                            <Input inputMode="decimal" className="min-h-[34px] pl-5 text-[13px]" value={mark.partialAmount ?? ""} onChange={(e) => setMark(row.monthKey, { partialAmount: e.target.value }, row)} placeholder="received" aria-label={`${row.label} amount received`} />
                          </span>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {visibleRows.length ? (
          <div className="mt-3 flex flex-wrap gap-2">
            <WizardChip tone="ok">{formatMoney(paidTotal)} recorded paid</WizardChip>
            <WizardChip tone={dueTotal > 0 ? "warn" : "ok"}>{dueTotal > 0 ? `${formatMoney(dueTotal)} due today` : "paid up"}</WizardChip>
          </div>
        ) : null}
      </WizardSection>
    </StepColumn>
  );
}
