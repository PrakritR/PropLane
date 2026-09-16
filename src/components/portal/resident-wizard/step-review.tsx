"use client";

import { useMemo } from "react";
import { StepColumn, StepHeading } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import { MessageStep, ReviewCard, WizardChip, WizardLine, WizardSection, type MessageDraft } from "@/components/portal/add-workspace/parts";
import type { ResidentWizardDerived } from "./derived";
import { formatMoney, monthKeyLabel, paymentSchedulePreview, thingsToFinish, type AddPersonForm } from "./state";

function moneyOr0(raw: string): number {
  const n = Number(raw.replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

export function ReviewStep({
  form,
  patch,
  derived,
  propertyLabel,
  goTo,
}: {
  form: AddPersonForm;
  patch: (next: Partial<AddPersonForm>) => void;
  derived: ResidentWizardDerived;
  propertyLabel: string | null;
  goTo: (stepId: string) => void;
}) {
  const todo = useMemo(() => thingsToFinish(form), [form]);
  const prospect = form.kind === "prospect";
  const missing = (step: string) => todo.some((t) => t.step === step);
  const a = form.application;
  const rows = useMemo(() => (prospect || form.billingStart === "next_due" ? [] : paymentSchedulePreview(form)), [form, prospect]);
  const paid = rows.filter((r) => (form.paymentMarks[r.monthKey]?.status ?? (r.isCurrent ? "due" : "paid")) === "paid");
  const due = rows.filter((r) => (form.paymentMarks[r.monthKey]?.status ?? (r.isCurrent ? "due" : "paid")) !== "paid");
  const paidTotal = paid.reduce((s, r) => s + r.total, 0);
  const message = form.message;
  const emailAvailable = form.email.includes("@");
  const smsAvailable = Boolean(form.phone.trim());
  const onMessage = (next: MessageDraft) => patch({ message: next });

  return (
    <StepColumn>
      <StepHeading title="Review" />
      {todo.length ? (
        <WizardSection title={`${todo.length} ${todo.length === 1 ? "thing" : "things"} to finish`} chip={<WizardChip tone="warn">before adding</WizardChip>} dataAttr="residents-wizard-review-todo">
          {todo.map((t, i) => (
            <WizardLine
              key={`${t.step}-${i}`}
              label={t.label}
              control={
                <button type="button" className="text-[13px] font-bold text-primary" onClick={() => goTo(t.step)}>
                  Fix
                </button>
              }
            />
          ))}
        </WizardSection>
      ) : null}

      <ReviewCard
        title={prospect ? "Prospect" : "Resident"}
        status={missing("contact") ? "incomplete" : "complete"}
        onEdit={() => goTo("contact")}
        dataAttr="residents-wizard-review-contact"
        facts={[
          { label: "Name", value: form.name.trim() || "Required", missing: !form.name.trim() },
          { label: "Email", value: form.email.trim() || (prospect ? "—" : "Required"), missing: !prospect && !form.email.trim() },
          { label: "Phone", value: form.phone.trim() || "—" },
          { label: "Prefers", value: form.preferredContact === "sms" ? "Text" : "Email" },
        ]}
      />
      <ReviewCard
        title={prospect ? "Interested in" : "Home"}
        status={missing("home") ? "incomplete" : prospect && !form.propertyId ? "optional" : "complete"}
        onEdit={() => goTo("home")}
        dataAttr="residents-wizard-review-home"
        facts={[
          { label: "Property", value: propertyLabel ?? (prospect ? "—" : "Required"), missing: !prospect && !form.propertyId },
          { label: prospect ? "Room" : "Placement", value: derived.listingSays ?? (form.bundleId ? "Bundle" : "—") },
          ...(prospect ? [{ label: "Wants", value: [form.wantedMoveIn ? `move-in ${form.wantedMoveIn}` : null, form.budget ? `up to $${form.budget}/mo` : null].filter(Boolean).join(" · ") || "—" }] : []),
        ]}
      />
      {prospect ? (
        <ReviewCard
          title="Tour"
          status={form.tourFormat === "none" ? "optional" : missing("tour") ? "incomplete" : "complete"}
          onEdit={() => goTo("tour")}
          dataAttr="residents-wizard-review-tour"
          facts={[
            { label: "When", value: form.tourFormat === "none" ? "No tour yet" : form.tourDate && form.tourStart ? `${form.tourDate} · ${form.tourStart} · ${form.tourDurationMinutes} min` : "Date and time required", missing: form.tourFormat !== "none" && missing("tour") },
            { label: "Format", value: form.tourFormat === "virtual" ? "Virtual" : form.tourFormat === "none" ? "—" : "In person" },
          ]}
        />
      ) : (
        <>
          <ReviewCard
            title="Application"
            status="optional"
            onEdit={() => goTo("application")}
            dataAttr="residents-wizard-review-application"
            facts={[
              { label: "About", value: [a.dateOfBirth ? `DOB ${a.dateOfBirth}` : null, `${Math.max(1, Number(a.occupancyCount) || 1)} ${Number(a.occupancyCount) === 1 || !a.occupancyCount ? "person" : "people"}`, a.pets ? a.pets : "no pets"].filter(Boolean).join(" · ") },
              { label: "Employment", value: a.notEmployed ? "Not currently employed" : a.employer ? `${a.employer}${a.monthlyIncome ? ` · $${a.monthlyIncome}/mo` : ""}` : "Not entered" },
              { label: "Current address", value: a.currentStreet ? `${a.currentStreet}${a.currentCity ? `, ${a.currentCity}` : ""}` : "Not entered" },
              { label: "References · disclosures", value: `${a.ref1Name || "—"} · ${a.evictionHistory || "No"} · ${a.bankruptcyHistory || "No"} · ${a.criminalHistory || "No"}` },
            ]}
          />
          <ReviewCard
            title="Lease"
            status={missing("lease") ? "incomplete" : "complete"}
            onEdit={() => goTo("lease")}
            dataAttr="residents-wizard-review-lease"
            facts={[
              { label: "Term", value: form.leaseTerm && form.moveInDate ? `${form.leaseTerm} · ${form.moveInDate}${form.moveOutDate ? ` → ${form.moveOutDate}` : ""}` : "Term and move-in required", missing: !form.leaseTerm || !form.moveInDate },
              { label: "Monthly", value: derived.isAirbnb ? "Calendar-only" : `${formatMoney(moneyOr0(form.rent))} rent${moneyOr0(form.utilities) ? ` + ${formatMoney(moneyOr0(form.utilities))} utilities` : ""}`, missing: !derived.isAirbnb && !form.rent.trim() },
              { label: "One-time", value: [moneyOr0(form.securityDeposit) ? `${formatMoney(moneyOr0(form.securityDeposit))} deposit` : null, moneyOr0(form.moveInFee) ? `${formatMoney(moneyOr0(form.moveInFee))} move-in fee` : null].filter(Boolean).join(" · ") || "—" },
              { label: "Document", value: form.leaseDocument === "later" ? "Generate later" : `${form.leaseDocument === "signed" ? "Already signed" : "Draft for review"} · ${form.leaseFileName || "upload required"}`, missing: form.leaseDocument !== "later" && !form.leaseFileName },
            ]}
          />
          <ReviewCard
            title="Payments"
            status="complete"
            onEdit={() => goTo("payments")}
            dataAttr="residents-wizard-review-payments"
            facts={[
              { label: "Recurring", value: derived.isAirbnb ? "Nothing billed" : `${formatMoney(moneyOr0(form.rent) + moneyOr0(form.utilities) + moneyOr0(form.otherFeeAmount))}/mo ${form.billingStart === "next_due" ? "from the next due date" : form.moveInDate ? `from ${form.moveInDate}` : ""}` },
              { label: "Recorded", value: rows.length ? `${paid.map((r) => monthKeyLabel(r.monthKey).split(" ")[0]).join(" · ") || "none"} paid (${formatMoney(paidTotal)})${due.length ? ` · ${due.map((r) => monthKeyLabel(r.monthKey).split(" ")[0]).join(" · ")} due` : ""}` : "—" },
              { label: "One-time", value: [moneyOr0(form.securityDeposit) ? `Deposit ${form.depositPaid ? "paid" : "due"}` : null, moneyOr0(form.moveInFee) ? `move-in fee ${form.moveInFeePaid ? "paid" : "due"}` : null].filter(Boolean).join(" · ") || "—" },
              { label: "Balance today", value: due.length ? `${formatMoney(due.reduce((s, r) => s + r.total, 0))} due` : "paid up" },
            ]}
          />
          <ReviewCard
            title="Documents"
            status="optional"
            onEdit={() => goTo("documents")}
            dataAttr="residents-wizard-review-documents"
            facts={[{ label: "Attached", value: form.documents.length ? form.documents.map((d) => d.file.name).join(" · ") : "None" }]}
          />
        </>
      )}

      <MessageStep who={prospect ? "prospect" : "resident"} draft={message} onChange={onMessage} emailAvailable={emailAvailable} smsAvailable={smsAvailable} linkLabel={prospect ? "Copy the application link" : "Copy their account link"} dataAttr="residents-wizard-message" />
    </StepColumn>
  );
}
