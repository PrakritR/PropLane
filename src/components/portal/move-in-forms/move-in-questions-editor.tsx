"use client";

/**
 * A move-in form's questions, edited in place: sections that expand, the shared question row
 * (`BuilderQuestionCard`, the same row the application editor draws), add / move / remove.
 *
 * The move-in form editor modal's Questions step and the listing editor's inline Move-in step both
 * draw this one component, so the two can never edit a question differently.
 */
import { useState } from "react";
import { Plus } from "lucide-react";
import { BuilderQuestionCard } from "@/components/portal/application-form-builder";
import type { ExtraQuestionType } from "@/components/portal/application-question-edit-modal";
import {
  addMoveInQuestion,
  addMoveInSection,
  groupQuestionsBySection,
  moveMoveInQuestion,
  questionCountLabel,
  removeMoveInQuestion,
  removeMoveInSection,
  renameMoveInSection,
  updateMoveInQuestion,
} from "@/components/portal/move-in-forms/move-in-form-model";
import { PORTAL_EDIT_ROW_ICON_BUTTON_CLASS, PortalCollapsibleEditRow } from "@/components/portal/portal-collapsible-edit-row";
import { Input } from "@/components/ui/input";
import type { ManagerCustomApplicationFieldType } from "@/lib/manager-listing-submission";
import type { ResolvedApplicationField } from "@/lib/rental-application/application-field-catalog";
import type { MoveInFormQuestion } from "@/lib/move-in-forms/types";

/** What move-in forms add to the application's answer types. */
const MOVE_IN_EXTRA_TYPES: readonly ExtraQuestionType[] = [
  { id: "photos", label: "Photos" },
  { id: "signature", label: "Signature" },
];

/** The shared question row speaks the application's field shape; a move-in question is that plus a signature type. */
function asField(question: MoveInFormQuestion): ResolvedApplicationField {
  return { ...question, type: question.type as ManagerCustomApplicationFieldType, isStandard: false };
}

export function MoveInQuestionsEditor({
  questions,
  onChange,
  onFocusQuestion,
}: {
  questions: MoveInFormQuestion[];
  onChange: (next: MoveInFormQuestion[]) => void;
  /** The modal points its live preview at the question being edited. */
  onFocusQuestion?: (key: string) => void;
}) {
  const [expandedQuestionIds, setExpandedQuestionIds] = useState<ReadonlySet<string>>(new Set());
  const [collapsedSections, setCollapsedSections] = useState<ReadonlySet<string>>(new Set());
  const sections = groupQuestionsBySection(questions);

  const toggleQuestion = (id: string) =>
    setExpandedQuestionIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const addQuestionTo = (sectionName: string) => {
    const next = addMoveInQuestion(questions, sectionName);
    const created = next.find((q) => !questions.some((existing) => existing.id === q.id));
    onChange(next);
    if (created) {
      setExpandedQuestionIds((prev) => new Set(prev).add(created.id));
      setCollapsedSections((prev) => {
        const out = new Set(prev);
        out.delete(sectionName);
        return out;
      });
    }
  };

  return (
    <div className="space-y-2" data-attr="move-in-questions-editor">
      {sections.map((section, sectionIndex) => {
        const sectionKey = section.name;
        const expanded = !collapsedSections.has(sectionKey);
        return (
          <PortalCollapsibleEditRow
            key={sectionIndex}
            title={section.name || "Questions"}
            subtitle={questionCountLabel(section.questions.length)}
            expanded={expanded}
            onExpandedChange={(next) =>
              setCollapsedSections((prev) => {
                const out = new Set(prev);
                if (next) out.delete(sectionKey);
                else out.add(sectionKey);
                return out;
              })
            }
            onRemove={sections.length > 1 || section.name ? () => onChange(removeMoveInSection(questions, section.name)) : undefined}
            removeIconOnly
            removeTitle="Remove section"
            removeDataAttr="move-in-form-section-remove"
            headerActions={
              <button
                type="button"
                className={PORTAL_EDIT_ROW_ICON_BUTTON_CLASS}
                title="Add question"
                aria-label="Add question"
                data-attr="move-in-form-add-question"
                onClick={() => addQuestionTo(section.name)}
              >
                <Plus className="h-4 w-4" strokeWidth={2.25} aria-hidden />
              </button>
            }
            toggleDataAttr={`move-in-form-section-toggle-${sectionIndex}`}
            contentClassName="space-y-2"
          >
            {sections.length > 1 || section.name ? (
              <Input
                value={section.name}
                onChange={(event) => onChange(renameMoveInSection(questions, section.name, event.target.value))}
                placeholder="Section name"
                aria-label="Section name"
                data-attr="move-in-form-section-name"
              />
            ) : null}
            {section.questions.map((question, index) => (
              <div key={question.id} onFocusCapture={() => onFocusQuestion?.(question.key)}>
                <BuilderQuestionCard
                  field={asField(question)}
                  allFields={questions.map(asField)}
                  expanded={expandedQuestionIds.has(question.id)}
                  onToggleExpand={() => toggleQuestion(question.id)}
                  onRemove={() => onChange(removeMoveInQuestion(questions, question.id))}
                  onPatch={(change) =>
                    onChange(updateMoveInQuestion(questions, question.id, change as Parameters<typeof updateMoveInQuestion>[2]))
                  }
                  canMoveUp={index > 0}
                  canMoveDown={index < section.questions.length - 1}
                  onMoveUp={() => onChange(moveMoveInQuestion(questions, question.id, "up"))}
                  onMoveDown={() => onChange(moveMoveInQuestion(questions, question.id, "down"))}
                  availableSections={[]}
                  onMoveToSection={() => {}}
                  extraTypes={MOVE_IN_EXTRA_TYPES}
                  sampleLabel="Resident sees"
                  hideSampleForTypes={["signature"]}
                />
              </div>
            ))}
          </PortalCollapsibleEditRow>
        );
      })}
      {questions.length === 0 ? (
        <button
          type="button"
          className="flex min-h-[44px] w-full items-center justify-center rounded-xl border border-dashed border-border bg-card text-sm font-semibold text-primary"
          data-attr="move-in-form-add-first-question"
          onClick={() => addQuestionTo("")}
        >
          + Add question
        </button>
      ) : null}
      <button
        type="button"
        className="flex min-h-[44px] w-full items-center justify-center rounded-xl border border-dashed border-border bg-card text-sm font-semibold text-primary"
        data-attr="move-in-form-add-section"
        onClick={() => onChange(addMoveInSection(questions))}
      >
        + Add section
      </button>
    </div>
  );
}
