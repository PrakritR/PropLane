"use client";

/**
 * Opens one move-in form in the house workspace popup: the resident card on the rail, the
 * resident's answers read-only in the centre (photos and the signature through server-signed
 * URLs), and the filled PDF on the right. A form that has not come back yet reads
 * "Not submitted yet" with Remind, and shows the questions the resident will be asked.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Download, ExternalLink, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { PanelSection, StepHeading, StepRail } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import { MoveInFormFrame, MoveInFormResidentCard } from "@/components/portal/move-in-forms/move-in-form-frame";
import { moveInFormPdfFileName, type MoveInFormRowActionHandlers } from "@/components/portal/move-in-forms/move-in-form-row-actions";
import {
  getMoveInForm,
  MOVE_IN_FORMS_CHANGED,
  moveInFormFileUrl,
  moveInFormUrl,
} from "@/lib/move-in-forms/client";
import {
  formatMoveInDate,
  formatMoveInStamp,
  groupMoveInAnswers,
  moveInFormPlaceLine,
  type MoveInAnswerView,
} from "@/lib/move-in-forms/manager-rows";
import type { MoveInFormRecord, MoveInFormSummary } from "@/lib/move-in-forms/types";
import { cn } from "@/lib/utils";

const STEPS = [
  { id: "answers", label: "Answers" },
  { id: "activity", label: "Activity" },
] as const;

function AnswerValue({ view, formId }: { view: MoveInAnswerView; formId: string }) {
  if (view.kind === "empty") return <span className="text-muted">No answer</span>;
  if (view.kind === "text") return <span className="whitespace-pre-wrap break-words">{view.text}</span>;
  if (view.kind === "files") {
    return (
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
        {view.paths.map((path, index) => {
          const url = moveInFormFileUrl("manager", formId, path);
          return (
            <a key={path} href={url} target="_blank" rel="noreferrer" data-attr="move-in-form-photo" className="block overflow-hidden rounded-lg border border-border bg-accent/40">
              {/* eslint-disable-next-line @next/next/no-img-element -- a short-lived signed URL, not a static asset */}
              <img src={url} alt={`Photo ${index + 1}`} className="aspect-square w-full object-cover" loading="lazy" />
            </a>
          );
        })}
      </div>
    );
  }
  const url = moveInFormFileUrl("manager", formId, view.storagePath);
  const stamp = formatMoveInStamp(view.signedAt);
  return (
    <div>
      {/* eslint-disable-next-line @next/next/no-img-element -- a short-lived signed URL, not a static asset */}
      <img src={url} alt={`Signature of ${view.signedName}`} className="h-14 max-w-[240px] object-contain" data-attr="move-in-form-signature" />
      <p className="text-[13px] font-semibold text-foreground">{view.signedName}</p>
      {stamp ? <p className="text-[12.5px] text-muted">{stamp}</p> : null}
    </div>
  );
}

function AnswerCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-4 overflow-hidden rounded-2xl border border-border bg-card" data-attr="move-in-form-answer-section">
      <div className="border-b border-border/60 px-4 py-3">
        <h3 className="text-[14px] font-bold tracking-tight text-foreground">{title}</h3>
      </div>
      <dl className="divide-y divide-border/60">{children}</dl>
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 px-4 py-3 text-[13.5px] sm:grid-cols-[minmax(0,220px)_minmax(0,1fr)] sm:gap-4">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 font-medium text-foreground">{children}</dd>
    </div>
  );
}

export function MoveInFormViewer({
  form,
  actions,
  onClose,
}: {
  /** The list row that was opened; the full record (questions, answers) is read from the server. */
  form: MoveInFormSummary;
  actions: Pick<MoveInFormRowActionHandlers, "remind" | "download">;
  onClose: () => void;
}) {
  const [record, setRecord] = useState<MoveInFormRecord | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [step, setStep] = useState(0);
  const [reminding, setReminding] = useState(false);
  const announced = useRef(false);

  useEffect(() => {
    let cancelled = false;
    // Reading the record subscribes this popup to an external server snapshot.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setError("");
    getMoveInForm(form.id)
      .then(({ form: loaded }) => {
        if (cancelled) return;
        setRecord(loaded);
        // The server stamps "opened" on the first read of a submitted form; tell the sidebar count.
        if (loaded.status === "submitted" && !loaded.managerViewedAt && !announced.current) {
          announced.current = true;
          window.dispatchEvent(new Event(MOVE_IN_FORMS_CHANGED));
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Couldn't open this form");
      });
    return () => {
      cancelled = true;
    };
  }, [form.id, attempt]);

  const submitted = form.status === "submitted";
  const first = form.residentName.trim().split(/\s+/)[0] || "the resident";
  const place = moveInFormPlaceLine(form);
  const groups = record ? groupMoveInAnswers(record.snapshot.questions, record.answers) : [];
  const pdfUrl = moveInFormUrl("manager", `/${encodeURIComponent(form.id)}/pdf`);
  const submittedOn = formatMoveInDate(form.submittedAt);

  const activity: Array<{ label: string; value: string }> = [
    { label: "Sent", value: formatMoveInStamp(form.sentAt) },
    { label: "Due", value: formatMoveInDate(form.dueAt) },
    { label: "Last reminder", value: formatMoveInStamp(record?.remindedAt ?? form.remindedAt) },
    { label: "Opened by you", value: formatMoveInStamp(record?.managerViewedAt ?? form.managerViewedAt) },
    { label: "Submitted", value: formatMoveInStamp(form.submittedAt) },
  ].filter((row) => row.value);

  const remind = async () => {
    setReminding(true);
    try {
      await actions.remind(form);
      onClose();
    } finally {
      setReminding(false);
    }
  };

  const body = error ? (
    <div role="alert" className="rounded-2xl border border-border bg-card p-6 text-center" data-attr="move-in-form-viewer-error">
      <p className="mb-3 text-sm font-semibold text-foreground">Couldn&apos;t open this form</p>
      <Button variant="outline" onClick={() => setAttempt((n) => n + 1)} data-attr="move-in-form-viewer-retry">
        Try again
      </Button>
    </div>
  ) : !record ? (
    <div role="status" aria-label="Loading form" className="space-y-3">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-24 animate-pulse rounded-2xl bg-accent/50 motion-reduce:animate-none" />
      ))}
    </div>
  ) : step === 1 ? (
    <>
      <StepHeading title="Activity" />
      <AnswerCard title="History">
        {activity.map((row) => (
          <Row key={row.label} label={row.label}>
            {row.value}
          </Row>
        ))}
      </AnswerCard>
    </>
  ) : submitted ? (
    <>
      <StepHeading title="Answers" />
      {record.snapshot.pdf ? (
        <AnswerCard title="Document">
          <Row label="Signed PDF">
            {record.snapshot.pdf.fileName} · {record.snapshot.pdf.pageCount} {record.snapshot.pdf.pageCount === 1 ? "page" : "pages"}
          </Row>
        </AnswerCard>
      ) : null}
      {groups.map((group) => (
        <AnswerCard key={group.title} title={group.title}>
          {group.rows.map(({ question, view }) => (
            <Row key={question.key} label={question.label}>
              <AnswerValue view={view} formId={form.id} />
            </Row>
          ))}
        </AnswerCard>
      ))}
    </>
  ) : (
    <>
      <div className="mb-5 rounded-2xl border border-dashed border-border bg-card/40 px-6 py-8 text-center" data-attr="move-in-form-not-submitted">
        <p className="text-base font-semibold text-foreground">Not submitted yet</p>
        <p className="mt-1 text-[13px] text-muted">
          Sent {formatMoveInDate(form.sentAt)}
          {form.dueAt ? ` · due ${formatMoveInDate(form.dueAt)}` : ""}
        </p>
        <Button variant="primary" className="mt-4 rounded-full" loading={reminding} onClick={() => void remind()} data-attr="move-in-form-viewer-remind">
          Remind {first}
        </Button>
      </div>
      <AnswerCard title={`${first} will answer`}>
        {record.snapshot.questions.map((question) => (
          <Row key={question.key} label={question.label}>
            <span className="text-muted">{question.required ? "Required" : "Optional"}</span>
          </Row>
        ))}
      </AnswerCard>
    </>
  );

  return (
    <MoveInFormFrame
      title={`${form.formName} · ${form.residentName}`}
      subtitle={place}
      saveState={submitted ? (submittedOn ? `Submitted ${submittedOn}` : "Submitted") : "Waiting"}
      onClose={onClose}
      assistantContext={`Move-in form ${form.formName}`}
      assistantScopeKey="Move-in form"
      dataAttr="move-in-form-viewer"
      headerActions={
        submitted ? (
          <>
            <PortalIconAction icon={Download} label="Download PDF" data-attr="move-in-form-viewer-download" onClick={() => void actions.download(form)} />
            <PortalIconAction
              icon={ExternalLink}
              label="Open in new tab"
              data-attr="move-in-form-viewer-new-tab"
              onClick={() => window.open(pdfUrl, "_blank", "noopener")}
            />
          </>
        ) : null
      }
      railHeader={<MoveInFormResidentCard name={form.residentName} place={place} />}
      rail={<StepRail steps={STEPS} current={step} onJump={setStep} />}
      sidePanel={
        <PanelSection title={submitted ? "Filled PDF" : "Form"}>
          <div className="flex items-center gap-3">
            <span className={cn("grid size-11 shrink-0 place-items-center rounded-[10px] bg-primary/[0.08] text-primary")} aria-hidden>
              <FileText className="size-5" strokeWidth={1.6} />
            </span>
            <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-foreground">
              {submitted ? moveInFormPdfFileName(form) : form.formName}
            </span>
            {submitted ? (
              <PortalIconAction icon={Download} label="Download PDF" data-attr="move-in-form-panel-download" onClick={() => void actions.download(form)} />
            ) : null}
          </div>
        </PanelSection>
      }
      footer={
        <>
          <span aria-hidden />
          <Button
            type="button"
            variant="primary"
            className="min-h-[44px] rounded-full px-7 text-[14px] font-bold"
            onClick={onClose}
            data-attr="move-in-form-viewer-done"
          >
            Done
          </Button>
        </>
      }
    >
      {body}
    </MoveInFormFrame>
  );
}
