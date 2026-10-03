"use client";

/**
 * The parts of the Edit resident wizard that show the resident's REAL record
 * instead of add-mode forms (studio-redesign C2-ER5 / ER7 / ER8):
 *
 *   Payments   their charges grouped Overdue / Pending / Paid, a "paid of" line,
 *              old → new on unpaid rent when Save will rebuild it, the rent
 *              schedule and the deposit
 *   Lease      who has signed and the lease document on file
 *   Application every section as a grouped card — status and household up top,
 *              what the listing charges and where they were placed at the foot
 *   Documents  the files on them, each with a ⋯ menu, and Add document
 *
 * Presentational only: the rows come from `ResidentEditRecord`
 * (`src/lib/resident-edit-record.ts`), the handlers from the Residents tab.
 */

import { useRef, type ReactNode } from "react";
import { AlertCircle, Check, Circle, FileText, MoreHorizontal } from "lucide-react";
import { StepColumn, StepHeading } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import { AddFoot, WizardChip, WizardLine, WizardSection, WizardSelect } from "@/components/portal/add-workspace/parts";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { formatPortalListDate } from "@/lib/portal-display-dates";
import {
  diffResidentEdit,
  type ResidentEditBaseline,
  type ResidentEditStage,
} from "@/lib/resident-edit-stage";
import {
  groupResidentEditCharges,
  residentEditAmountLabel,
  residentEditDepositLine,
  residentEditMoney,
  residentEditNewUnpaidRentCents,
  residentEditPaidOfLine,
  type ResidentEditCharge,
  type ResidentEditFact,
  type ResidentEditRecord,
} from "@/lib/resident-edit-record";
import type { ResidentWizardDerived } from "./derived";
import type { AddPersonForm } from "./state";

function dateLabel(iso: string | null | undefined): string {
  return iso ? formatPortalListDate(iso) : "";
}

function FactRows({ facts }: { facts: readonly ResidentEditFact[] }) {
  return (
    <>
      {facts.map((fact) => (
        <WizardLine key={fact.label} label={fact.label} control={<span className="text-[14px] font-normal text-foreground">{fact.value}</span>} />
      ))}
    </>
  );
}

/* ─────────────────────────────── Payments ─────────────────────────────── */

function ChargeMark({ charge }: { charge: ResidentEditCharge }) {
  if (charge.status === "paid") return <Check className="size-4 text-emerald-600" aria-label="Paid" />;
  if (charge.bucket === "overdue") return <AlertCircle className="size-4 text-red-600" aria-label="Overdue" />;
  return <Circle className="size-3.5 text-muted" aria-label="Pending" />;
}

function ChargeRow({ charge, newCents }: { charge: ResidentEditCharge; newCents: number | null }) {
  const paid = charge.status === "paid";
  return (
    <li
      className={`flex items-center gap-3 border-t border-border/60 py-2.5 text-[13.5px] ${paid ? "text-muted" : "text-foreground"}`}
      data-attr="residents-wizard-charge-row"
    >
      <span className="flex w-4 shrink-0 justify-center">
        <ChargeMark charge={charge} />
      </span>
      <span className="min-w-[5.5rem] shrink-0 text-[12.5px] text-muted">{charge.dueLabel}</span>
      <span className="min-w-0 flex-1 truncate">{charge.title}</span>
      <span className={`shrink-0 text-right tabular-nums ${paid ? "font-medium" : "font-bold"}`}>
        {residentEditAmountLabel(charge, newCents)}
      </span>
    </li>
  );
}

function ChargeGroup({
  label,
  charges,
  newCentsFor,
}: {
  label: string;
  charges: readonly ResidentEditCharge[];
  newCentsFor: (charge: ResidentEditCharge) => number | null;
}) {
  if (charges.length === 0) return null;
  return (
    <div data-attr={`residents-wizard-charges-${label.toLowerCase()}`}>
      <p className="mb-0.5 mt-3 text-[11px] font-bold uppercase tracking-wide text-muted first:mt-2">{label}</p>
      <ul>
        {charges.map((charge) => (
          <ChargeRow key={charge.id} charge={charge} newCents={newCentsFor(charge)} />
        ))}
      </ul>
    </div>
  );
}

export function EditPaymentsStep({
  form,
  patch,
  derived,
  stage,
  baseline,
  record,
}: {
  form: AddPersonForm;
  patch: (next: Partial<AddPersonForm>) => void;
  derived: ResidentWizardDerived;
  stage: ResidentEditStage;
  baseline: ResidentEditBaseline;
  record: ResidentEditRecord;
}) {
  if (derived.isAirbnb || derived.isShortTerm) {
    return (
      <StepColumn>
        <StepHeading title="Payments" />
        <WizardSection title={derived.isAirbnb ? "Calendar-only stay" : "Short-term stay"}>
          <WizardLine label={derived.isAirbnb ? "Airbnb stays are calendar-only — nothing is billed through PropLane." : "A short-term stay bills its total up front; nothing recurs."} />
        </WizardSection>
      </StepColumn>
    );
  }

  const diff = diffResidentEdit(baseline, { ...form, application: form.application as Record<string, unknown> });
  const groups = groupResidentEditCharges(record.charges);
  const paidOf = residentEditPaidOfLine(record.charges);
  const newCentsFor = (charge: ResidentEditCharge) =>
    residentEditNewUnpaidRentCents({ stage, diff, rent: form.rent, charge });
  const deposit = residentEditDepositLine(record.charges, dateLabel);
  const rentCents = Math.round((Number(form.rent.replace(/[^\d.]/g, "")) || 0) * 100);
  const dueOn = form.rentDueDay === "last" ? "Last day of the month" : form.rentDueDay === "15" ? "15th of the month" : "1st of the month";

  return (
    <StepColumn>
      <StepHeading title="Payments" />
      <WizardSection title="Charges" dataAttr="residents-wizard-payments-charges">
        {record.charges.length === 0 ? (
          <WizardLine label="No charges yet" />
        ) : (
          <>
            {paidOf ? <p className="text-[14px] font-bold text-foreground" data-attr="residents-wizard-payments-paid-of">{paidOf}</p> : null}
            <ChargeGroup label="Overdue" charges={groups.overdue} newCentsFor={newCentsFor} />
            <ChargeGroup label="Pending" charges={groups.pending} newCentsFor={newCentsFor} />
            <ChargeGroup label="Paid" charges={groups.paid} newCentsFor={newCentsFor} />
          </>
        )}
      </WizardSection>

      <WizardSection title="Rent schedule" dataAttr="residents-wizard-payments-schedule">
        <FactRows
          facts={[
            { label: "Amount", value: rentCents > 0 ? `${residentEditMoney(rentCents)} / mo` : "—" },
            { label: "Due on", value: dueOn },
            { label: "From", value: form.moveInDate || "—" },
          ]}
        />
      </WizardSection>

      <WizardSection title="Billing" dataAttr="residents-wizard-payments-billing">
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
                  { value: "move_in", label: "From move-in" },
                  { value: "next_due", label: "From the next due date" },
                ]}
                variant="cell"
                dataAttr="residents-wizard-billing-start"
              />
            </span>
          }
        />
        <WizardLine
          label={
            <span className="inline-flex items-center gap-2">
              {deposit.paid ? <Check className="size-4 text-emerald-600" aria-hidden /> : <Circle className="size-3.5 text-muted" aria-hidden />}
              {deposit.text}
            </span>
          }
        />
      </WizardSection>
    </StepColumn>
  );
}

/* ──────────────────────────────── Lease ──────────────────────────────── */

/** Status, who has signed, and the document on file — the top of the Lease step in edit mode. */
export function EditLeaseRecordCards({
  record,
  action,
}: {
  record: ResidentEditRecord;
  /** "New terms" on a signed lease. */
  action?: ReactNode;
}) {
  return (
    <>
      {record.leaseStatusText ? (
        <WizardSection title="Lease" dataAttr="residents-wizard-lease-status">
          <WizardLine label={record.leaseStatusText} control={action} />
        </WizardSection>
      ) : null}
      {record.signers.length > 0 ? (
        <WizardSection title="Who has signed" dataAttr="residents-wizard-lease-signers">
          {record.signers.map((signer) => (
            <WizardLine
              key={signer.id}
              label={
                <span className="inline-flex items-center gap-2">
                  {signer.signedAtIso ? <Check className="size-4 text-emerald-600" aria-hidden /> : <Circle className="size-3.5 text-muted" aria-hidden />}
                  <span>
                    <b className="font-bold">{signer.name}</b> · {signer.role}
                  </span>
                </span>
              }
              control={
                <span className="text-[12.5px] font-normal text-muted">
                  {signer.signedAtIso ? `Signed ${dateLabel(signer.signedAtIso)}` : signer.waitText}
                </span>
              }
            />
          ))}
        </WizardSection>
      ) : null}
      {record.leaseDocument ? (
        <WizardSection title="Lease document" dataAttr="residents-wizard-lease-document-on-file">
          <WizardLine
            label={
              <span className="inline-flex items-center gap-2">
                <FileText className="size-4 text-muted" aria-hidden />
                {record.leaseDocument.name}
              </span>
            }
            control={record.leaseDocument.date ? <span className="text-[12.5px] font-normal text-muted">{dateLabel(record.leaseDocument.date)}</span> : null}
          />
        </WizardSection>
      ) : null}
    </>
  );
}

/* ───────────────────────────── Application ───────────────────────────── */

/** Status and household: the first two cards of the Application step. */
export function EditApplicationTopCards({ record }: { record: ResidentEditRecord }) {
  const application = record.application;
  if (!application) {
    return (
      <WizardSection title="Status" dataAttr="residents-wizard-app-status">
        <WizardLine label="No application on file" />
      </WizardSection>
    );
  }
  return (
    <>
      <WizardSection title="Status" dataAttr="residents-wizard-app-status">
        <WizardLine label={application.statusText} />
      </WizardSection>
      <WizardSection title="Household" dataAttr="residents-wizard-app-household">
        <FactRows facts={application.household} />
      </WizardSection>
    </>
  );
}

/** What the listing charges and where the manager placed them: the last cards before Notes. */
export function EditApplicationBottomCards({ record }: { record: ResidentEditRecord }) {
  const application = record.application;
  if (!application) return null;
  return (
    <>
      {application.housingCharges.length > 0 ? (
        <WizardSection title="Housing charges (listing)" dataAttr="residents-wizard-app-housing">
          <FactRows facts={application.housingCharges} />
        </WizardSection>
      ) : null}
      {application.placement.length > 0 ? (
        <WizardSection title="Manager final placement" dataAttr="residents-wizard-app-placement">
          <FactRows facts={application.placement} />
        </WizardSection>
      ) : null}
    </>
  );
}

/* ───────────────────────────── Documents ───────────────────────────── */

export function EditDocumentsStep({
  record,
  busy,
  onUpload,
  onDownload,
  onRemove,
}: {
  record: ResidentEditRecord;
  busy: boolean;
  onUpload?: (file: File) => void | Promise<void>;
  onDownload?: (id: string) => void;
  onRemove?: (id: string) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <StepColumn>
      <StepHeading title="Documents" />
      <input
        ref={fileRef}
        type="file"
        accept="application/pdf,image/*"
        className="sr-only"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void onUpload?.(file);
          event.currentTarget.value = "";
        }}
        data-attr="residents-wizard-documents-input"
      />
      <WizardSection title="Files" chip={<WizardChip>private · you and this resident only</WizardChip>} dataAttr="residents-wizard-documents">
        {record.documents.length === 0 ? (
          <WizardLine label="Nothing attached yet" />
        ) : (
          record.documents.map((doc) => (
            <div key={doc.id} className="flex items-center gap-3 border-b border-border/60 py-3 first:pt-0 last:border-b-0 last:pb-0" data-attr="residents-wizard-document-row">
              <span className="grid h-11 w-9 shrink-0 place-items-center rounded-md bg-primary/[0.08] text-[var(--pl-blue-deep)]">
                <FileText className="h-4 w-4" aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] font-semibold text-foreground">{doc.name}</span>
                <span className="block truncate text-[12px] text-muted">
                  {[doc.date ? dateLabel(doc.date) : "", doc.kindLabel].filter(Boolean).join(" · ")}
                </span>
              </span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label={`Actions for ${doc.name}`}
                    data-attr="residents-wizard-document-menu"
                    className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-muted hover:bg-accent/50"
                  >
                    <MoreHorizontal className="h-4 w-4" aria-hidden />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem data-attr="residents-wizard-document-download" onSelect={() => onDownload?.(doc.id)}>
                    Download
                  </DropdownMenuItem>
                  <DropdownMenuItem data-attr="residents-wizard-document-remove" onSelect={() => onRemove?.(doc.id)}>
                    Remove
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ))
        )}
        <AddFoot label="+ Add document" onClick={() => !busy && fileRef.current?.click()} dataAttr="residents-wizard-documents-add" />
      </WizardSection>
    </StepColumn>
  );
}
