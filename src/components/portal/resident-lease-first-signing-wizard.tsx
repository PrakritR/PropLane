"use client";

/**
 * Ida Cares lease-first (PLAN-0925, C274-C278): the resident's "Sign your
 * License agreement" step wizard, built from the property's imported lease
 * template (`row.signingTemplateSnapshot`, pinned at `begin_lease_first_signing`
 * time). Same visual shape as the applicant rental wizard — step header, one
 * card of questions per section, Back/Continue footer, save-and-resume — but
 * its own small stepper rather than a fork of `RentalApplicationWizard`,
 * because that component's steps are hard-wired to the fixed 11-item rental
 * application outline (`activeApplicationWizardSteps`) and has no notion of
 * an imported lease template's free-form sections.
 *
 * The actual signature is NOT collected here: the final "Sign" step hands off
 * to the existing `LeaseSigningModal` / `residentSignLease` path via
 * `onReachedSign` — this file never re-implements or forks the signing
 * mechanism (per the brief: "do not create a second signature mechanism").
 * This wizard's own writes (`signingAnswers`, and the `begin_lease_first_signing`
 * transition) are ordinary, non-signature field updates.
 */

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { CustomQuestionField } from "@/components/rental-application/custom-question-field";
import type { ManagerCustomApplicationField } from "@/lib/manager-listing-submission";
import {
  beginLeaseFirstSigning,
  updateLeasePipelineRow,
  type LeasePipelineRow,
} from "@/lib/lease-pipeline-storage";

const AUTHORIZATION_SECTION_RE = /authoriz|signature/i;

type ClauseStep = { kind: "clause"; id: string; title: string; fields: ManagerCustomApplicationField[] };
type ReviewStep = { kind: "review" };
type SignStep = { kind: "sign"; inviteFields: ManagerCustomApplicationField[] };
type WizardStep = ClauseStep | ReviewStep | SignStep;

function residentInitialsFromName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const initials = parts.map((p) => p[0]?.toUpperCase() ?? "").join("");
  return initials.slice(0, 4);
}

function buildSteps(fields: ManagerCustomApplicationField[], displayOrder: string[] | undefined): WizardStep[] {
  const ordered = displayOrder?.length
    ? [...fields].sort((a, b) => {
        const ai = displayOrder.indexOf(a.id);
        const bi = displayOrder.indexOf(b.id);
        return (ai === -1 ? fields.length : ai) - (bi === -1 ? fields.length : bi);
      })
    : fields;
  const bySection = new Map<string, ManagerCustomApplicationField[]>();
  const order: string[] = [];
  const authorizationFields: ManagerCustomApplicationField[] = [];
  for (const field of ordered) {
    const section = field.section?.trim() || "General";
    if (AUTHORIZATION_SECTION_RE.test(section)) {
      authorizationFields.push(field);
      continue;
    }
    if (!bySection.has(section)) {
      bySection.set(section, []);
      order.push(section);
    }
    bySection.get(section)!.push(field);
  }
  const clauseSteps: ClauseStep[] = order.map((section) => ({
    kind: "clause",
    id: section,
    title: section,
    fields: bySection.get(section) ?? [],
  }));
  // The primary licensee signature is a required text question in the
  // authorization section — that field is superseded by the real signing
  // path below and is never rendered as an ordinary input. Only the OPTIONAL
  // invite-by-email questions (representative / legal representative /
  // guarantor) carry forward onto the Sign step.
  const inviteFields = authorizationFields.filter((f) => !f.required);
  return [...clauseSteps, { kind: "review" }, { kind: "sign", inviteFields }];
}

function stepTitle(step: WizardStep): string {
  if (step.kind === "review") return "Review";
  if (step.kind === "sign") return "Sign";
  return step.title;
}

function ClauseInitialsRow({
  field,
  value,
  onChange,
}: {
  field: ManagerCustomApplicationField;
  value: string;
  onChange: (next: string) => void;
}) {
  const text = field.description?.trim() || field.label;
  return (
    <div className="rounded-xl border border-border bg-card p-4" data-attr={`lease-clause-${field.key}`}>
      <p className="text-sm leading-relaxed text-foreground">{text}</p>
      <div className="mt-3 flex items-center gap-2">
        <label
          htmlFor={`lease-clause-initials-${field.key}`}
          className="text-xs font-semibold uppercase tracking-wide text-muted"
        >
          Initials{field.required ? " *" : ""}
        </label>
        <input
          id={`lease-clause-initials-${field.key}`}
          value={value}
          maxLength={6}
          onChange={(e) => onChange(e.target.value.toUpperCase())}
          data-attr={`lease-clause-initials-${field.key}`}
          className="w-20 rounded-lg border border-border bg-card px-2 py-1.5 text-center text-sm font-semibold uppercase outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/20"
        />
      </div>
    </div>
  );
}

/**
 * Which phase (if any) of the lease-first signing flow this row is in, so the
 * parent panel can suppress its generic document-preview/sign UI while this
 * wizard owns the screen. `null` = not a lease-first row with an imported
 * template — the parent's ordinary lease UI applies unchanged.
 */
export function leaseFirstSigningPhase(row: LeasePipelineRow): "not-begun" | "in-progress" | null {
  if (row.leaseFirst !== true) return null;
  if (row.bucket === "manager" && row.status === "Draft") return "not-begun";
  if (
    row.bucket === "resident" &&
    row.status === "Resident Signature Pending" &&
    row.signingTemplateSnapshot &&
    !row.residentSignature
  ) {
    return "in-progress";
  }
  return null;
}

export function ResidentLeaseFirstSigningWizard({
  row,
  onSaved,
  onReachedSign,
}: {
  row: LeasePipelineRow;
  onSaved?: () => void;
  onReachedSign: () => void;
}) {
  const { showToast } = useAppUi();
  const [beginning, setBeginning] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>(() => ({ ...(row.signingAnswers ?? {}) }));

  const notYetBegun = row.leaseFirst === true && row.bucket === "manager" && row.status === "Draft";
  const inProgress =
    row.leaseFirst === true &&
    row.bucket === "resident" &&
    row.status === "Resident Signature Pending" &&
    Boolean(row.signingTemplateSnapshot) &&
    !row.residentSignature;

  const steps = useMemo(
    () =>
      row.signingTemplateSnapshot
        ? buildSteps(row.signingTemplateSnapshot.customApplicationFields, row.signingTemplateSnapshot.questionDisplayOrder)
        : [],
    [row.signingTemplateSnapshot],
  );
  const step = steps[stepIndex];

  if (!notYetBegun && !inProgress) return null;

  if (notYetBegun) {
    return (
      <div className="mb-4 rounded-2xl border border-border bg-card p-4" data-attr="lease-first-begin-signing">
        <p className="text-sm font-semibold text-foreground">Sign your License agreement</p>
        <p className="mt-1 text-sm text-muted">
          Your manager has the license agreement ready. Sign it first — the intake form comes next.
        </p>
        <div className="mt-3">
          <Button
            type="button"
            data-attr="lease-first-begin-signing-button"
            disabled={beginning}
            onClick={async () => {
              setBeginning(true);
              const result = await beginLeaseFirstSigning(row.id);
              setBeginning(false);
              if (result.ok) {
                onSaved?.();
              } else {
                showToast(result.error);
              }
            }}
          >
            {beginning ? "Starting…" : "Begin signing"}
          </Button>
        </div>
      </div>
    );
  }

  if (!step) return null;

  const answerFor = (field: ManagerCustomApplicationField): string => {
    if (field.key in answers) return answers[field.key] ?? "";
    if (field.type === "initials") return residentInitialsFromName(row.residentName);
    return "";
  };

  const setAnswer = (key: string, value: string) => {
    setAnswers((prev) => ({ ...prev, [key]: value }));
  };

  const saveAnswers = (next: Record<string, string>) => {
    updateLeasePipelineRow(row.id, { signingAnswers: next });
  };

  const stepFields = step.kind === "clause" ? step.fields : step.kind === "sign" ? step.inviteFields : [];
  const missingRequired =
    step.kind === "clause" &&
    step.fields.some((f) => f.required && f.filledBy !== "manager" && !answerFor(f).trim());

  const goNext = () => {
    saveAnswers(answers);
    setStepIndex((i) => Math.min(i + 1, steps.length - 1));
  };
  const goBack = () => setStepIndex((i) => Math.max(i - 1, 0));

  return (
    <div className="mb-4 rounded-2xl border border-border bg-card p-4" data-attr="lease-first-signing-wizard">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted">Sign your License agreement</p>
      <p className="mt-1 text-lg font-bold text-foreground">{stepTitle(step)}</p>

      <div className="mt-4 space-y-3">
        {step.kind === "review" ? (
          <div
            className="max-h-[60vh] overflow-y-auto rounded-xl border border-border bg-accent/10 p-4 text-sm leading-relaxed text-foreground [&_h1]:mb-2 [&_h1]:text-lg [&_h1]:font-bold [&_h2]:mb-1 [&_h2]:mt-4 [&_h2]:text-sm [&_h2]:font-bold [&_h2]:uppercase [&_h2]:tracking-wide [&_h2]:text-muted [&_p]:mb-2"
            data-attr="lease-first-review-document"
            dangerouslySetInnerHTML={{ __html: row.generatedHtml ?? "" }}
          />
        ) : (
          stepFields.map((field) =>
            field.type === "initials" ? (
              <ClauseInitialsRow
                key={field.key}
                field={field}
                value={answerFor(field)}
                onChange={(next) => setAnswer(field.key, next)}
              />
            ) : (
              <CustomQuestionField
                key={field.key}
                field={field}
                value={answerFor(field)}
                onChange={(next) => setAnswer(field.key, next)}
                readOnly={field.filledBy === "manager"}
              />
            ),
          )
        )}
        {step.kind === "sign" && stepFields.length === 0 ? (
          <p className="text-sm text-muted">No optional co-signers to invite for this agreement.</p>
        ) : null}
      </div>

      <div className="mt-4 flex items-center justify-between gap-3">
        <Button type="button" variant="ghost" onClick={goBack} disabled={stepIndex === 0} data-attr="lease-first-back">
          Back
        </Button>
        {step.kind === "sign" ? (
          <Button
            type="button"
            data-attr="lease-first-continue-to-sign"
            onClick={() => {
              saveAnswers(answers);
              onReachedSign();
            }}
          >
            Continue to sign
          </Button>
        ) : (
          <Button type="button" data-attr="lease-first-continue" disabled={missingRequired} onClick={goNext}>
            Continue
          </Button>
        )}
      </div>
    </div>
  );
}
