"use client";

/**
 * The three pop-ups the manager Forms page opens, drawn for the home demo from fixture props:
 *
 *  - Send a move-in form (the round +): `SendMoveInFormPopup`'s one step. Resident, Form and Due on the
 *    centre, "What <first> gets" flush right, Cancel and Send in the footer.
 *  - A form's record (any row): `MoveInFormViewer`. Rail "Answers · Activity", the resident card, the
 *    answers (completed) or "Not submitted yet" with Remind (pending), "Filled PDF" / "Form" on the right,
 *    Done.
 *  - Edit form (⋯ > Edit on a pending row): `EditPendingMoveInFormPopup`. Details (Due, Blocks) and
 *    Questions (the real question editor), "Resident sees" flush right.
 *
 * The real components fetch the residents, the property's forms and the record, and mount the
 * assistant, so they cannot render on the public page; this file draws the same shell and fields from
 * the same pieces (`demo-popup.tsx`, the wizard kit, `MoveInQuestionsEditor`, `MoveInFormLivePreview`).
 * Nothing is sent or saved: the primary closes and the panel toasts "(sample)". Loaded on demand.
 */

import { useState, type ReactNode } from "react";
import { Download, ExternalLink, FileText } from "lucide-react";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { PanelSection } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import { WizardField, WizardSelect, WIZARD_LABEL_CLASS } from "@/components/portal/add-workspace/parts";
import { PropertyFormWizardCard, PropertyFormWizardRow } from "@/components/portal/property-form-wizard-kit";
import { MoveInQuestionsEditor } from "@/components/portal/move-in-forms/move-in-questions-editor";
import { MoveInFormLivePreview } from "@/components/portal/move-in-forms/move-in-form-live-preview";
import type { MoveInAnswerMap } from "@/components/portal/move-in-forms/move-in-form-model";
import { questionCountLabel } from "@/components/portal/move-in-forms/move-in-form-model";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { Input } from "@/components/ui/input";
import { MOVE_IN_FORM_BLOCKS, MOVE_IN_FORM_BLOCKS_LABELS, type MoveInFormBlocks, type MoveInFormQuestion } from "@/lib/move-in-forms/types";
import { DemoWorkspacePopup } from "@/components/marketing/site/product-mock/demo-popup";
import type { ManagerFormFixture } from "@/components/marketing/site/product-mock/fixtures-more";
import {
  DEMO_RESIDENCIES,
  DEMO_SENDABLE_FORMS,
  demoFormDetail,
  type DemoResidency,
} from "@/components/marketing/site/product-mock/fixtures-popups";

/** The resident card at the top of the rail (`MoveInFormResidentCard`): initials tile, name, property · room. */
function ResidentCard({ name, place }: { name: string; place: string }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");
  return (
    <div className="mb-3 rounded-2xl border border-border bg-card p-3.5" data-attr="move-in-form-resident-card">
      <div className="mb-2 grid size-11 place-items-center rounded-[10px] bg-primary/[0.08] text-[15px] font-extrabold text-primary" aria-hidden>
        {initials || "?"}
      </div>
      <p className="text-[14px] font-bold text-foreground">{name}</p>
      {place ? <p className="text-[12.5px] text-muted">{place}</p> : null}
    </div>
  );
}

function FormTile({ name, detail }: { name: string; detail: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="grid size-11 shrink-0 place-items-center rounded-[10px] bg-primary/[0.08] text-primary" aria-hidden>
        <FileText className="size-5" strokeWidth={1.6} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] font-semibold text-foreground">{name}</span>
        {detail ? <span className="block text-[12.5px] text-muted">{detail}</span> : null}
      </span>
    </div>
  );
}

const longDate = (iso: string) =>
  new Date(`${iso}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

/* ─────────────────────────── Send a move-in form ─────────────────────────── */

export function DemoSendFormPopup({ onClose, onSent, presetResidentId }: { onClose: () => void; onSent: () => void; presetResidentId?: string }) {
  const [residentId, setResidentId] = useState(presetResidentId ?? DEMO_RESIDENCIES[0]!.id);
  const [formId, setFormId] = useState(DEMO_SENDABLE_FORMS[0]!.id);
  const [dueOverride, setDueOverride] = useState<string | null>(null);
  const resident = DEMO_RESIDENCIES.find((r) => r.id === residentId) ?? DEMO_RESIDENCIES[0]!;
  const form = DEMO_SENDABLE_FORMS.find((f) => f.id === formId) ?? DEMO_SENDABLE_FORMS[0]!;
  const due = dueOverride ?? form.due;
  const first = resident.name.split(/\s+/)[0] ?? "the resident";

  return (
    <DemoWorkspacePopup
      title="Send a move-in form"
      steps={[{ id: "send", label: "Send a form" }]}
      railHeader={<ResidentCard name={resident.name} place={resident.place} />}
      sidePanel={
        <PanelSection title={`What ${first} gets`}>
          <FormTile name={form.name} detail={due ? `Due ${longDate(due)}` : "No due date"} />
        </PanelSection>
      }
      footer={{
        kind: "done",
        label: "Send",
        onDone: onSent,
        left: (
          <button type="button" onClick={onClose} className="min-h-[44px] rounded-full px-6 text-[13.5px] font-semibold text-muted hover:bg-foreground/5" data-attr="move-in-form-send-cancel">
            Cancel
          </button>
        ),
      }}
      onClose={onClose}
      dataAttr="move-in-form-send-popup"
    >
      {() => (
        <div className="max-w-[560px] space-y-4">
          <WizardSelect
            label="Resident"
            value={resident.id}
            onChange={(next) => {
              setResidentId(next);
              setDueOverride(null);
            }}
            options={DEMO_RESIDENCIES.map((r: DemoResidency) => ({ value: r.id, label: `${r.name} · ${r.place}` }))}
            dataAttr="move-in-form-send-resident"
          />
          <WizardSelect
            label="Form"
            value={form.id}
            onChange={(next) => {
              setFormId(next);
              setDueOverride(null);
            }}
            options={DEMO_SENDABLE_FORMS.map((f) => ({ value: f.id, label: f.name }))}
            dataAttr="move-in-form-send-form"
          />
          <WizardField label="Due">
            <Input type="date" className="portal-modal-date-input" value={due} onChange={(e) => setDueOverride(e.target.value)} data-attr="move-in-form-send-due" />
          </WizardField>
        </div>
      )}
    </DemoWorkspacePopup>
  );
}

/* ─────────────────────────── A form's record (the viewer) ─────────────────────────── */

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

const VIEWER_STEPS = [
  { id: "answers", label: "Answers" },
  { id: "activity", label: "Activity" },
] as const;

export function DemoFormViewerPopup({ form, onClose, onRemind }: { form: ManagerFormFixture; onClose: () => void; onRemind: (first: string) => void }) {
  const detail = demoFormDetail(form);
  const submitted = form.bucket === "completed";
  const first = form.resident.split(/\s+/)[0] || "the resident";
  const place = form.place;
  const groups = new Map<string, MoveInFormQuestion[]>();
  for (const question of detail.questions) {
    const title = question.section?.trim() || "Answers";
    groups.set(title, [...(groups.get(title) ?? []), question]);
  }
  const activity = [
    { label: "Sent", value: detail.sent },
    { label: "Due", value: detail.due },
    { label: "Last reminder", value: detail.reminded ?? "" },
    { label: "Opened by you", value: detail.opened ?? "" },
    { label: "Submitted", value: detail.submitted ?? "" },
  ].filter((row) => row.value);
  const submittedOn = detail.submitted ? detail.submitted.split(",").slice(0, 2).join(",") : "";

  return (
    <DemoWorkspacePopup
      title={`${form.title} · ${form.resident}`}
      subtitle={place}
      saveState={submitted ? (submittedOn ? `Submitted ${submittedOn}` : "Submitted") : "Waiting"}
      headerActions={
        submitted ? (
          <>
            <PortalIconAction icon={Download} label="Download PDF" data-attr="move-in-form-viewer-download" />
            <PortalIconAction icon={ExternalLink} label="Open in new tab" data-attr="move-in-form-viewer-new-tab" />
          </>
        ) : null
      }
      steps={VIEWER_STEPS}
      showProgress={false}
      railHeader={<ResidentCard name={form.resident} place={place} />}
      sidePanel={
        <PanelSection title={submitted ? "Filled PDF" : "Form"}>
          <div className="flex items-center gap-3">
            <span className="grid size-11 shrink-0 place-items-center rounded-[10px] bg-primary/[0.08] text-primary" aria-hidden>
              <FileText className="size-5" strokeWidth={1.6} />
            </span>
            <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-foreground">{submitted ? (detail.pdfName ?? `${form.title}.pdf`) : form.title}</span>
            {submitted ? <PortalIconAction icon={Download} label="Download PDF" data-attr="move-in-form-panel-download" /> : null}
          </div>
        </PanelSection>
      }
      footer={{ kind: "done", onDone: onClose }}
      onClose={onClose}
      dataAttr="move-in-form-viewer"
    >
      {(step) =>
        step === 1 ? (
          <AnswerCard title="History">
            {activity.map((row) => (
              <Row key={row.label} label={row.label}>
                {row.value}
              </Row>
            ))}
          </AnswerCard>
        ) : submitted ? (
          <>
            {detail.pdfName ? (
              <AnswerCard title="Document">
                <Row label="Signed PDF">{detail.pdfName} · 1 page</Row>
              </AnswerCard>
            ) : null}
            {[...groups.entries()].map(([title, questions]) => (
              <AnswerCard key={title} title={title}>
                {questions.map((question) => (
                  <Row key={question.key} label={question.label}>
                    {question.type === "signature" ? (
                      <div>
                        <p className="font-[cursive] text-[22px] leading-none text-foreground" aria-hidden>
                          {detail.answers?.[question.key]}
                        </p>
                        <p className="text-[13px] font-semibold text-foreground">{detail.answers?.[question.key]}</p>
                        <p className="text-[12.5px] text-muted">{detail.submitted}</p>
                      </div>
                    ) : (
                      (detail.answers?.[question.key] ?? <span className="text-muted">No answer</span>)
                    )}
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
                Sent {detail.sent.split(",").slice(0, 2).join(",")} · due {detail.due}
              </p>
              <button
                type="button"
                onClick={() => onRemind(first)}
                className="mt-4 min-h-9 rounded-full bg-primary px-5 text-[13.5px] font-bold text-white"
                data-attr="move-in-form-viewer-remind"
              >
                Remind {first}
              </button>
            </div>
            <AnswerCard title={`${first} will answer`}>
              {detail.questions.map((question) => (
                <Row key={question.key} label={question.label}>
                  <span className="text-muted">{question.required ? "Required" : "Optional"}</span>
                </Row>
              ))}
            </AnswerCard>
          </>
        )
      }
    </DemoWorkspacePopup>
  );
}

/* ─────────────────────────── Edit a pending form ─────────────────────────── */

const BLOCK_OPTIONS = MOVE_IN_FORM_BLOCKS.map((value) => ({ value, label: MOVE_IN_FORM_BLOCKS_LABELS[value] }));

export function DemoEditPendingFormPopup({ form, onClose, onSaved }: { form: ManagerFormFixture; onClose: () => void; onSaved: () => void }) {
  const detail = demoFormDetail(form);
  const initialBlocks: MoveInFormBlocks = form.blocks.includes("Move-in details") ? "move_in_details" : form.blocks.includes("Lease signing") ? "lease_signing" : "nothing";
  const [questions, setQuestions] = useState<MoveInFormQuestion[]>(() => structuredClone(detail.questions));
  const [blocks, setBlocks] = useState<MoveInFormBlocks>(initialBlocks);
  const [due, setDue] = useState("2025-09-27");
  const [previewIndex, setPreviewIndex] = useState(0);
  const [previewAnswers, setPreviewAnswers] = useState<MoveInAnswerMap>({});
  const dirty = blocks !== initialBlocks || due !== "2025-09-27" || JSON.stringify(questions) !== JSON.stringify(detail.questions);

  const steps = [
    { id: "details", label: "Details", summary: `${MOVE_IN_FORM_BLOCKS_LABELS[blocks]}${due ? "" : " · No due date"}` },
    { id: "questions", label: "Questions", summary: questionCountLabel(questions.length) },
  ];

  return (
    <DemoWorkspacePopup
      title={`Edit ${form.title}`}
      steps={steps}
      showProgress
      saveState={dirty ? "Not saved yet" : "Saved"}
      railHeader={<ResidentCard name={form.resident} place={form.place} />}
      sidePanel={
        <MoveInFormLivePreview
          name={form.title}
          source="built"
          questions={questions}
          pdfUrl={null}
          index={previewIndex}
          onIndexChange={setPreviewIndex}
          answers={previewAnswers}
          onAnswersChange={setPreviewAnswers}
        />
      }
      footer={{ kind: "wizard", lastLabel: "Save", onFinish: onSaved, hideStepCount: true }}
      onClose={onClose}
      dataAttr="move-in-form-edit-popup"
    >
      {(step) =>
        step === 0 ? (
          <PropertyFormWizardCard dataAttr="move-in-form-edit-details-card">
            <PropertyFormWizardRow label="Due">
              <Input type="date" className="portal-modal-date-input min-w-[200px] max-w-[280px]" value={due} onChange={(event) => setDue(event.target.value)} data-attr="move-in-form-edit-due" />
            </PropertyFormWizardRow>
            <PropertyFormWizardRow label="Blocks">
              <FieldSingleSelect
                hideLabel
                label="Blocks"
                labelClassName={WIZARD_LABEL_CLASS}
                variant="cell"
                className="min-w-[200px] max-w-[280px]"
                value={blocks}
                onChange={(value) => setBlocks(value as MoveInFormBlocks)}
                options={BLOCK_OPTIONS}
                dataAttr="move-in-form-edit-blocks"
              />
            </PropertyFormWizardRow>
          </PropertyFormWizardCard>
        ) : (
          <MoveInQuestionsEditor questions={questions} onChange={setQuestions} />
        )
      }
    </DemoWorkspacePopup>
  );
}
