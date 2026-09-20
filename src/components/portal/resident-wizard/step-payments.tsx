"use client";

/**
 * Payments — every charge the lease would bill, with a checkbox for paid.
 *
 * Recurring months and one-time deposit / move-in fees sit in one list.
 * Checked = paid; unchecked = due. Amounts still edit on Lease.
 */

import { useMemo } from "react";
import { StepColumn, StepHeading } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import { WizardChip, WizardLine, WizardSection, WizardSelect } from "@/components/portal/add-workspace/parts";
import type { ResidentWizardDerived } from "./derived";
import { formatMoney, paymentSchedulePreview, type AddPersonForm, type PaymentMark } from "./state";

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
    const current: PaymentMark = form.paymentMarks[monthKey] ?? { status: "paid", paidOn: row.dueOn, method: "card" };
    patch({ paymentMarks: { ...form.paymentMarks, [monthKey]: { ...current, ...next } } });
  };
  const markFor = (monthKey: string, row: { dueOn: string; isCurrent: boolean }): PaymentMark =>
    form.paymentMarks[monthKey] ?? { status: row.isCurrent ? "due" : "paid", paidOn: row.dueOn, method: "card" };
  const visibleRows = form.billingStart === "next_due" ? [] : rows;

  type ChargeRow = {
    key: string;
    title: string;
    detail: string;
    amount: number;
    paid: boolean;
    current?: boolean;
    onPaidChange: (paid: boolean) => void;
    dataAttr: string;
  };

  const charges: ChargeRow[] = [];
  if (deposit > 0) {
    charges.push({
      key: "deposit",
      title: "Security deposit",
      detail: "one-time · from Lease",
      amount: deposit,
      paid: form.depositPaid,
      onPaidChange: (paid) => patch({ depositPaid: paid }),
      dataAttr: "residents-wizard-deposit-paid",
    });
  }
  if (moveInFee > 0) {
    charges.push({
      key: "move-in",
      title: "Move-in fee",
      detail: "one-time · from Lease",
      amount: moveInFee,
      paid: form.moveInFeePaid,
      onPaidChange: (paid) => patch({ moveInFeePaid: paid }),
      dataAttr: "residents-wizard-move-in-fee-paid",
    });
  }
  for (const row of visibleRows) {
    const mark = markFor(row.monthKey, row);
    charges.push({
      key: row.monthKey,
      title: row.label,
      detail: row.isCurrent ? `${row.detail} · current` : row.detail,
      amount: row.total,
      paid: mark.status === "paid",
      current: row.isCurrent,
      onPaidChange: (paid) =>
        setMark(row.monthKey, { status: paid ? "paid" : "due", paidOn: paid ? mark.paidOn || row.dueOn : mark.paidOn, method: mark.method || "card" }, row),
      dataAttr: `residents-wizard-payment-${row.monthKey}`,
    });
  }

  const paidTotal = charges.reduce((sum, row) => (row.paid ? sum + row.amount : sum), 0);
  const dueTotal = charges.reduce((sum, row) => (row.paid ? sum : sum + row.amount), 0);

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

      <WizardSection
        title="Potential payments"
        chip={<WizardChip>check = paid</WizardChip>}
        dataAttr="residents-wizard-payments-past"
      >
        {charges.length === 0 ? (
          <WizardLine label={form.billingStart === "next_due" ? "Nothing before the next due date is owed through PropLane." : form.moveInDate ? "Move-in is in the future — the schedule starts then." : "Set a move-in date on Lease to list the months."} />
        ) : (
          <ul className="divide-y divide-border/60">
            {charges.map((row) => (
              <li key={row.key}>
                <label className="flex items-start gap-3 py-3" data-attr={row.dataAttr}>
                  <input
                    type="checkbox"
                    checked={row.paid}
                    onChange={(e) => row.onPaidChange(e.target.checked)}
                    aria-label={`${row.title} paid`}
                    className="mt-1 size-4 accent-primary"
                    data-attr={`${row.dataAttr}-paid`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block font-bold text-foreground">
                      {row.title}
                      {row.current ? <WizardChip> current</WizardChip> : null}
                      <WizardChip>{row.detail}</WizardChip>
                    </span>
                  </span>
                  <span className="shrink-0 tabular-nums font-bold text-foreground">{formatMoney(row.amount)}</span>
                  <span
                    className={
                      row.paid
                        ? "shrink-0 rounded-full bg-[var(--status-confirmed-bg)] px-2 py-0.5 text-[11px] font-bold text-[var(--status-confirmed-fg)]"
                        : "shrink-0 rounded-full bg-[var(--status-pending-bg,#fdf0d5)] px-2 py-0.5 text-[11px] font-bold text-[var(--status-pending-fg,#a34a06)]"
                    }
                  >
                    {row.paid ? "Paid" : "Pending"}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
        {charges.length ? (
          <div className="mt-3 flex flex-wrap gap-2">
            <WizardChip tone="ok">{formatMoney(paidTotal)} recorded paid</WizardChip>
            <WizardChip tone={dueTotal > 0 ? "warn" : "ok"}>{dueTotal > 0 ? `${formatMoney(dueTotal)} due today` : "paid up"}</WizardChip>
          </div>
        ) : null}
      </WizardSection>
    </StepColumn>
  );
}
