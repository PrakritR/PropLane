"use client";

import { useRef } from "react";
import { FileText } from "lucide-react";
import { StepColumn, StepHeading } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { Input } from "@/components/ui/input";
import { RESIDENT_LEASE_TERM_CUSTOM, residentLeaseTermSelectValue } from "@/lib/resident-manual-lease-terms";
import { shortTermNightlyRate, shortTermStayChargeTitle, shortTermStayNightCount } from "@/lib/short-term-stay-pricing";
import {
  FieldMark,
  WizardChip,
  WizardField,
  WizardLine,
  WizardRow,
  WizardSection,
} from "@/components/portal/add-workspace/parts";
import type { ResidentWizardDerived } from "./derived";
import type { AddPersonForm, LeaseDocumentChoice } from "./state";

const LEASE_DOCUMENT_OPTIONS: { value: LeaseDocumentChoice; label: string; hint: string }[] = [
  { value: "signed", label: "Already signed", hint: "executed off-platform — upload it; the resident only activates their account" },
  { value: "draft", label: "Draft — I'll review first", hint: "filed for your review; the resident signs it in PropLane" },
  { value: "later", label: "Generate in PropLane later", hint: "no document yet; the lease stays pending" },
];

export function LeaseStep({
  form,
  patch,
  derived,
  onPickLeasePdf,
  busy,
}: {
  form: AddPersonForm;
  patch: (next: Partial<AddPersonForm>) => void;
  derived: ResidentWizardDerived;
  onPickLeasePdf: (file: File) => void;
  busy: boolean;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const clearMark = (key: string) => {
    if (!form.marks[key]) return form.marks;
    const next = { ...form.marks };
    delete next[key];
    return next;
  };
  const money = (key: "rent" | "utilities" | "moveInFee" | "securityDeposit" | "otherFeeAmount", label: string, placeholder: string, required = false) => (
    <WizardField label={label} required={required} mark={<FieldMark kind={form.marks[key]} />}>
      <span className="relative block">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[13px] text-muted">$</span>
        <Input
          inputMode="decimal"
          className="pl-6"
          value={form[key]}
          onChange={(e) => patch({ [key]: e.target.value, marks: clearMark(key) } as Partial<AddPersonForm>)}
          placeholder={placeholder}
          data-attr={`residents-wizard-${key}`}
        />
      </span>
    </WizardField>
  );
  const termSelectValue = residentLeaseTermSelectValue(form.leaseTerm, form.leaseTermCustomMode, derived.leaseTermPresetValues);
  const stayPreview = derived.isShortTerm
    ? (() => {
        const nights = shortTermStayNightCount(form.moveInDate, form.moveOutDate);
        const nightly = shortTermNightlyRate(form.rent);
        return nights && nightly ? shortTermStayChargeTitle(nights, nightly) : null;
      })()
    : null;

  return (
    <StepColumn>
      <StepHeading title="The lease" />
      <WizardSection title="Term" dataAttr="residents-wizard-lease-term">
        <WizardRow cols={3}>
          <div>
            <FieldSingleSelect
              label="Lease term *"
              value={termSelectValue}
              onChange={(selected) => {
                if (selected === RESIDENT_LEASE_TERM_CUSTOM) {
                  patch({ leaseTermCustomMode: true, leaseTerm: derived.leaseTermPresetValues.includes(form.leaseTerm) ? "" : form.leaseTerm });
                  return;
                }
                patch({ leaseTermCustomMode: false, leaseTerm: selected, marks: clearMark("leaseTerm") });
              }}
              options={[...derived.leaseTermOptions, { value: RESIDENT_LEASE_TERM_CUSTOM, label: "Custom…" }]}
              placeholder="Select…"
              dataAttr="residents-wizard-lease-term-select"
            />
            {termSelectValue === RESIDENT_LEASE_TERM_CUSTOM ? (
              <Input className="mt-2" value={form.leaseTerm} onChange={(e) => patch({ leaseTerm: e.target.value })} placeholder="e.g. 9 months" data-attr="residents-wizard-lease-term-custom" />
            ) : null}
          </div>
          <WizardField label="Move-in" required mark={<FieldMark kind={form.marks.moveInDate} />}>
            <Input type="date" className="portal-modal-date-input" value={form.moveInDate} onChange={(e) => patch({ moveInDate: e.target.value, marks: clearMark("moveInDate") })} data-attr="residents-wizard-move-in" />
          </WizardField>
          {!derived.isMonthToMonth || derived.isAirbnb ? (
            <WizardField label="Move-out" required={derived.isAirbnb} mark={<FieldMark kind={form.marks.moveOutDate} />}>
              <Input type="date" className="portal-modal-date-input" value={form.moveOutDate} onChange={(e) => patch({ moveOutDate: e.target.value, marks: clearMark("moveOutDate") })} data-attr="residents-wizard-move-out" />
            </WizardField>
          ) : null}
        </WizardRow>
      </WizardSection>

      {derived.isAirbnb ? (
        <WizardSection title="Money" chip={<WizardChip>calendar-only stay</WizardChip>}>
          <WizardLine label="Airbnb stays are calendar-only — PropLane does not bill rent or fees." />
        </WizardSection>
      ) : (
        <WizardSection title="Money" chip={derived.listingSays ? <WizardChip>defaults from the listing</WizardChip> : undefined} dataAttr="residents-wizard-lease-money">
          <WizardRow cols={3}>
            {money("rent", derived.isShortTerm ? "Rent per night" : "Monthly rent", derived.isShortTerm ? "85.00" : "875.00", true)}
            {!derived.isShortTerm ? money("utilities", "Monthly utilities", "175.00") : null}
            {!derived.isShortTerm ? (
              <FieldSingleSelect
                label="Rent due on"
                value={form.rentDueDay}
                onChange={(next) => patch({ rentDueDay: next === "15" ? "15" : next === "last" ? "last" : "1" })}
                options={[
                  { value: "1", label: "1st of the month" },
                  { value: "15", label: "15th of the month" },
                  { value: "last", label: "Last day of the month" },
                ]}
                dataAttr="residents-wizard-rent-due"
              />
            ) : null}
            {money("securityDeposit", derived.isShortTerm ? "Deposit" : "Security deposit", "875.00")}
            {money("moveInFee", "Move-in fee", "200.00")}
            {!derived.isShortTerm ? (
              <WizardField label="Other monthly fee">
                <Input value={form.otherFeeLabel} onChange={(e) => patch({ otherFeeLabel: e.target.value })} placeholder="Parking, pet rent…" data-attr="residents-wizard-other-fee-label" />
              </WizardField>
            ) : null}
            {!derived.isShortTerm ? money("otherFeeAmount", "Amount per month", "0.00") : null}
          </WizardRow>
          {stayPreview ? <div className="mt-3"><WizardLine label={stayPreview} chip={<WizardChip>stay total</WizardChip>} /></div> : null}
        </WizardSection>
      )}

      <WizardSection title="Lease document" dataAttr="residents-wizard-lease-document">
        <FieldSingleSelect
          label="This lease is"
          value={form.leaseDocument}
          onChange={(next) => patch({ leaseDocument: next === "draft" ? "draft" : next === "later" ? "later" : "signed" })}
          options={LEASE_DOCUMENT_OPTIONS}
          dataAttr="residents-wizard-lease-document-select"
        />
        {form.leaseDocument !== "later" ? (
          <div className="mt-3 rounded-xl border border-border">
            <input
              ref={fileRef}
              type="file"
              accept="application/pdf"
              className="sr-only"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) onPickLeasePdf(file);
                e.currentTarget.value = "";
              }}
              data-attr="residents-wizard-lease-pdf-input"
            />
            <div className="flex flex-wrap items-center gap-3 px-4 py-3 sm:flex-nowrap">
              <span className="grid h-11 w-9 shrink-0 place-items-center rounded-md bg-primary/[0.08] text-[var(--pl-blue-deep)]">
                <FileText className="h-4 w-4" aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] font-semibold text-foreground">{form.leaseFileName || "Upload the lease PDF"}</span>
                <span className="block text-[12px] text-muted">{form.leaseFileName ? "Read · term, dates, rent and deposit filled where blank" : "Up to 3.5 MB · we read the term, dates, rent and deposit from it"}</span>
              </span>
              {form.leaseFileName ? <WizardChip tone="ok">{form.leaseDocument === "signed" ? "Filed as signed" : "Filed for review"}</WizardChip> : null}
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={busy}
                data-attr="residents-wizard-lease-pdf-choose"
                className="min-h-[40px] w-full rounded-full border border-border bg-card px-5 text-[13.5px] font-bold text-foreground hover:bg-accent/40 disabled:opacity-50 sm:w-auto"
              >
                {form.leaseFileName ? "Replace" : "Choose file"}
              </button>
            </div>
          </div>
        ) : null}
      </WizardSection>
    </StepColumn>
  );
}
