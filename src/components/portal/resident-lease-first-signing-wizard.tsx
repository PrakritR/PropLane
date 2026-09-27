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
import { TriangleAlert } from "lucide-react";
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
const INVITE_EMAIL_RE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;
/**
 * C276 — buildable in full now that a lease template's "House rules
 * addendum" section carries its real, individually-classified clauses
 * (C282's `looksLikeSectionHeader` groups an imported PDF's own headings; the
 * section title itself is never one of its own fields — same convention as
 * every other imported section), AND each clause's own red-flag emphasis
 * (`field.flagged`), read straight off the PDF's own detected fill color
 * (`lease-template-pdf-import.ts`'s `isPredominantlyRed`, fed by
 * `pdf-source.server.ts`'s `colorRuns`) — never guessed from keywords.
 */
const HOUSE_RULES_SECTION_RE = /house rules/i;

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
 * C278 — the Sign step's optional representative / legal representative /
 * personal-guarantee fields are invite-by-email: the resident enters that
 * person's email (stored as the field's answer, same as any other typed
 * field) and sends them a one-way informational notice
 * (`/api/resident/lease-signer-invite`). There is no portal access, account,
 * or second signature for the invited party — the notice only tells them
 * they were named.
 */
function InviteSignerRow({
  field,
  value,
  onChange,
  onSend,
  sending,
  sent,
  error,
}: {
  field: ManagerCustomApplicationField;
  value: string;
  onChange: (next: string) => void;
  onSend: () => void;
  sending: boolean;
  sent: boolean;
  error?: string;
}) {
  const emailLooksValid = INVITE_EMAIL_RE.test(value.trim());
  return (
    <div className="rounded-xl border border-border bg-card p-4" data-attr={`lease-sign-invite-${field.key}`}>
      <label htmlFor={`lease-sign-invite-email-${field.key}`} className="text-sm font-semibold text-foreground">
        {field.label}
      </label>
      <div className="mt-2 flex items-center gap-2">
        <input
          id={`lease-sign-invite-email-${field.key}`}
          type="email"
          inputMode="email"
          placeholder="email@example.com"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          data-attr={`lease-sign-invite-email-input-${field.key}`}
          className="min-w-0 flex-1 rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/20"
        />
        <Button
          type="button"
          variant="outline"
          disabled={!emailLooksValid || sending}
          onClick={onSend}
          data-attr={`lease-sign-invite-send-${field.key}`}
        >
          {sending ? "Sending…" : sent ? "Invited" : "Send invite"}
        </Button>
      </div>
      {error ? (
        <p className="mt-2 text-xs text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * One numbered, read-only rule from the imported "House rules addendum"
 * section (C276). `flagged` (a PDF-detected red-flag clause) renders in the
 * design system's danger token — never a raw hex — plus a non-color
 * `TriangleAlert` cue with its own accessible label, so the emphasis still
 * reaches a resident who cannot perceive color.
 */
function HouseRuleClauseRow({ index, text, flagged }: { index: number; text: string; flagged?: boolean }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4" data-attr={`lease-house-rule-${index}`}>
      <p className={`text-sm leading-relaxed ${flagged ? "font-semibold text-danger" : "text-foreground"}`}>
        <span className={`mr-2 font-semibold ${flagged ? "text-danger" : "text-muted"}`}>{index}.</span>
        {flagged ? (
          <TriangleAlert
            role="img"
            aria-label="Important"
            data-attr={`lease-house-rule-flag-${index}`}
            className="mr-1 inline-block h-4 w-4 -translate-y-0.5 text-danger"
          />
        ) : null}
        {text}
      </p>
    </div>
  );
}

/**
 * The house rules section's single final "I have read and understand" step
 * (C276) — initials AND a date, not initials alone. The date answer rides in
 * `signingAnswers` under `${field.key}__date`, alongside the field's own
 * initials answer under `${field.key}` — additive to the existing JSON blob,
 * no schema change.
 */
function HouseRulesAcknowledgmentRow({
  field,
  initials,
  date,
  onInitialsChange,
  onDateChange,
}: {
  field: ManagerCustomApplicationField;
  initials: string;
  date: string;
  onInitialsChange: (next: string) => void;
  onDateChange: (next: string) => void;
}) {
  const text = field.description?.trim() || field.label;
  return (
    <div className="rounded-xl border border-border bg-card p-4" data-attr={`lease-house-rules-ack-${field.key}`}>
      <p className="text-sm leading-relaxed text-foreground">{text}</p>
      <div className="mt-3 flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <label
            htmlFor={`lease-house-rules-initials-${field.key}`}
            className="text-xs font-semibold uppercase tracking-wide text-muted"
          >
            Initials{field.required ? " *" : ""}
          </label>
          <input
            id={`lease-house-rules-initials-${field.key}`}
            value={initials}
            maxLength={6}
            onChange={(e) => onInitialsChange(e.target.value.toUpperCase())}
            data-attr={`lease-house-rules-initials-${field.key}`}
            className="w-20 rounded-lg border border-border bg-card px-2 py-1.5 text-center text-sm font-semibold uppercase outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/20"
          />
        </div>
        <div className="flex items-center gap-2">
          <label
            htmlFor={`lease-house-rules-date-${field.key}`}
            className="text-xs font-semibold uppercase tracking-wide text-muted"
          >
            Date{field.required ? " *" : ""}
          </label>
          <input
            id={`lease-house-rules-date-${field.key}`}
            type="date"
            value={date}
            onChange={(e) => onDateChange(e.target.value)}
            data-attr={`lease-house-rules-date-${field.key}`}
            className="rounded-lg border border-border bg-card px-2 py-1.5 text-sm outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/20"
          />
        </div>
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
  // C278 — per-field invite state for the Sign step's optional invite-by-email fields.
  const [inviteSending, setInviteSending] = useState<string | null>(null);
  const [invited, setInvited] = useState<Set<string>>(new Set());
  const [inviteErrors, setInviteErrors] = useState<Record<string, string>>({});

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

  const sendSignerInvite = async (field: ManagerCustomApplicationField) => {
    const inviteEmail = answerFor(field).trim();
    if (!inviteEmail) return;
    setInviteSending(field.key);
    setInviteErrors((prev) => ({ ...prev, [field.key]: "" }));
    try {
      const res = await fetch("/api/resident/lease-signer-invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leaseId: row.id, roleLabel: field.label, inviteEmail }),
      });
      const payload = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setInviteErrors((prev) => ({ ...prev, [field.key]: payload.error || "Could not send the invite." }));
        return;
      }
      setInvited((prev) => new Set(prev).add(field.key));
      showToast(`Invite sent to ${inviteEmail}`);
    } catch {
      setInviteErrors((prev) => ({ ...prev, [field.key]: "Could not send the invite. Try again." }));
    } finally {
      setInviteSending(null);
    }
  };

  const stepFields = step.kind === "clause" ? step.fields : step.kind === "sign" ? step.inviteFields : [];
  const isHouseRulesStep = step.kind === "clause" && HOUSE_RULES_SECTION_RE.test(step.title);
  const missingRequired =
    step.kind === "clause" &&
    step.fields.some((f) => {
      if (f.filledBy === "manager" || !f.required) return false;
      if (!answerFor(f).trim()) return true;
      // The house rules step's acknowledgment needs BOTH initials and a date (C276) —
      // every other clause step keeps today's initials-only requirement.
      return isHouseRulesStep && f.type === "initials" && !(answers[`${f.key}__date`] ?? "").trim();
    });

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
        ) : step.kind === "sign" ? (
          stepFields.map((field) => (
            <InviteSignerRow
              key={field.key}
              field={field}
              value={answerFor(field)}
              onChange={(next) => { setAnswer(field.key, next); setInvited((prev) => { if (!prev.has(field.key)) return prev; const next2 = new Set(prev); next2.delete(field.key); return next2; }); }}
              onSend={() => void sendSignerInvite(field)}
              sending={inviteSending === field.key}
              sent={invited.has(field.key)}
              error={inviteErrors[field.key]}
            />
          ))
        ) : isHouseRulesStep ? (
          <>
            {stepFields
              .filter((field) => !field.required)
              .map((field, index) => (
                <HouseRuleClauseRow
                  key={field.key}
                  index={index + 1}
                  text={field.description?.trim() || field.label}
                  flagged={field.flagged === true}
                />
              ))}
            {stepFields
              .filter((field) => field.required)
              .map((field) => (
                <HouseRulesAcknowledgmentRow
                  key={field.key}
                  field={field}
                  initials={answerFor(field)}
                  date={answers[`${field.key}__date`] ?? ""}
                  onInitialsChange={(next) => setAnswer(field.key, next)}
                  onDateChange={(next) => setAnswer(`${field.key}__date`, next)}
                />
              ))}
          </>
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
