"use client";

/**
 * The one question editor behind Edit application, Edit move-in form and the listing editor's inline
 * Application and Move-in cards.
 *
 * Each section appears once: a switch, its name, "N questions" and a chevron. Open a section and its
 * questions are listed (drag handle, question, type, Required / Optional, ⋯); click a question and it
 * opens in place. The editor owns only what is open; every edit goes out through `onChange` as a
 * `QuestionEditorChange` and the host writes it to its own storage.
 */
import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, FileText, GripVertical, MoreHorizontal } from "lucide-react";
import { PortalSettingsToggle } from "@/components/portal/portal-settings-ui";
import { linkedFormKey } from "@/lib/application-linked-forms";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { RECORD_ACTION_TRIGGER_BUTTON_CLASS, RECORD_ACTION_TRIGGER_ICON_CLASS } from "@/components/ui/record-action-menu";
import { cn } from "@/lib/utils";
import { QuestionInlineForm } from "./question-inline-form";
import {
  questionCountText,
  reorderedIds,
  type LinkedFormOption,
  type QuestionEditorChange,
  type QuestionEditorQuestion,
  type QuestionEditorSection,
  type QuestionEditorType,
} from "./question-editor-types";

export type { QuestionEditorChange, QuestionEditorQuestion, QuestionEditorSection, QuestionEditorType } from "./question-editor-types";

export function QuestionSectionsEditor({
  sections,
  onChange,
  allowedTypes,
  linkedFormOptions,
  onRestoreDefaults,
  restoreLabel = "Restore PropLane defaults",
  canAddSection = true,
  onSectionOpen,
  onQuestionOpen,
  dataAttrPrefix = "question-editor",
}: {
  sections: readonly QuestionEditorSection[];
  onChange: (change: QuestionEditorChange) => void;
  allowedTypes: readonly QuestionEditorType[];
  /** Forms a question can link. Absent hides the Linked forms block and the row facts. */
  linkedFormOptions?: readonly LinkedFormOption[];
  /** Sections holding a question PropLane always asks (name, email): the switch is on, disabled and carries a lock. */
  onRestoreDefaults?: () => void;
  restoreLabel?: string;
  /** False when there is no section left to add (every section already on). */
  canAddSection?: boolean;
  /** The preview follows the section the manager opens. */
  onSectionOpen?: (sectionId: string) => void;
  onQuestionOpen?: (sectionId: string, questionId: string) => void;
  dataAttrPrefix?: string;
}) {
  // A form with one section has nothing to choose between: its questions are listed straight away.
  const [openSections, setOpenSections] = useState<ReadonlySet<string>>(() => new Set(sections.length === 1 ? [sections[0]!.id] : []));
  const [openQuestionId, setOpenQuestionId] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const pendingNewQuestion = useRef<string | null>(null);
  const knownIds = useRef<Set<string>>(new Set(sections.flatMap((section) => section.questions.map((q) => q.id))));

  // A question added or duplicated opens straight away, in the section it was added to.
  useEffect(() => {
    const ids = new Set(sections.flatMap((section) => section.questions.map((q) => q.id)));
    if (pendingNewQuestion.current) {
      const created = sections
        .flatMap((section) => section.questions.map((q) => ({ id: q.id, sectionId: section.id })))
        .find((q) => !knownIds.current.has(q.id));
      if (created) {
        pendingNewQuestion.current = null;
        setOpenQuestionId(created.id);
        setOpenSections((prev) => new Set(prev).add(created.sectionId));
        onQuestionOpen?.(created.sectionId, created.id);
      }
    }
    knownIds.current = ids;
  }, [sections, onQuestionOpen]);

  const setSectionOpen = (sectionId: string, open: boolean) => {
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (open) next.add(sectionId);
      else next.delete(sectionId);
      return next;
    });
    if (open) onSectionOpen?.(sectionId);
  };

  const openQuestion = (sectionId: string, questionId: string | null) => {
    setOpenQuestionId(questionId);
    if (questionId) onQuestionOpen?.(sectionId, questionId);
  };

  return (
    <div data-attr={dataAttrPrefix}>
      {onRestoreDefaults ? (
        <div className="mb-2 flex justify-end">
          <button
            type="button"
            className="text-xs font-semibold text-primary underline-offset-2 hover:underline"
            onClick={onRestoreDefaults}
            data-attr={`${dataAttrPrefix}-restore`}
          >
            {restoreLabel}
          </button>
        </div>
      ) : null}
      <div className="divide-y divide-border/70 rounded-2xl border border-border bg-card">
        {sections.map((section) => {
          const open = openSections.has(section.id);
          const active = section.questions.filter((q) => !q.off);
          const off = section.questions.filter((q) => q.off);
          const hasSwitch = section.enabled !== undefined;
          const title = section.name || "Questions";
          return (
            <section key={section.id} data-attr={`${dataAttrPrefix}-section-${section.id}`} data-section-id={section.id}>
              <div className="flex items-center gap-3 px-4">
                {hasSwitch ? (
                  <PortalSettingsToggle
                    checked={section.enabled === true}
                    onChange={(next) => onChange({ kind: "toggle-section", sectionId: section.id, enabled: next })}
                    label={`${title} on`}
                    dataAttr={`${dataAttrPrefix}-section-switch-${section.id}`}
                  />
                ) : null}
                <button
                  type="button"
                  className="flex min-h-[52px] min-w-0 flex-1 items-center gap-3 text-left"
                  aria-expanded={open}
                  onClick={() => setSectionOpen(section.id, !open)}
                  data-attr={`${dataAttrPrefix}-section-toggle-${section.id}`}
                >
                  <span className={cn("min-w-0 flex-1 truncate text-[14px] font-semibold", section.enabled === false ? "text-muted" : "text-foreground")}>{title}</span>
                  <span className="shrink-0 text-xs text-muted">{questionCountText(active.length)}</span>
                  {open ? <ChevronDown className="h-4 w-4 shrink-0 text-muted" aria-hidden /> : <ChevronRight className="h-4 w-4 shrink-0 text-muted" aria-hidden />}
                </button>
              </div>
              {open ? (
                <div className="border-t border-border/70 px-4 pb-3" data-attr={`${dataAttrPrefix}-section-body-${section.id}`}>
                  {section.renamable ? (
                    <div className="py-3">
                      <SectionNameInput
                        name={section.name}
                        onRename={(name) => onChange({ kind: "rename-section", sectionId: section.id, name })}
                        dataAttr={`${dataAttrPrefix}-section-name`}
                      />
                    </div>
                  ) : null}
                  <ul className="divide-y divide-border/60">
                    {active.map((question) => (
                      <li
                        key={question.id}
                        data-question-id={question.id}
                        onDragOver={(event) => {
                          if (dragId && dragId !== question.id) event.preventDefault();
                        }}
                        onDrop={(event) => {
                          event.preventDefault();
                          if (!dragId || dragId === question.id) return;
                          const ids = active.map((q) => q.id);
                          if (!ids.includes(dragId)) return;
                          onChange({ kind: "reorder", sectionId: section.id, orderedIds: reorderedIds(ids, dragId, question.id) });
                          setDragId(null);
                        }}
                      >
                        {openQuestionId === question.id ? (
                          <QuestionInlineForm
                            question={question}
                            allowedTypes={allowedTypes}
                            linkedFormOptions={linkedFormOptions}
                            dataAttrPrefix={dataAttrPrefix}
                            onPatch={(patch) => onChange({ kind: "edit-question", sectionId: section.id, questionId: question.id, patch })}
                            onDone={() => openQuestion(section.id, null)}
                            onDelete={
                              question.can?.remove === false
                                ? undefined
                                : () => {
                                    openQuestion(section.id, null);
                                    onChange({ kind: "delete-question", sectionId: section.id, questionId: question.id });
                                  }
                            }
                          />
                        ) : (
                          <QuestionRow
                            question={question}
                            allowedTypes={allowedTypes}
                            linkedFormOptions={linkedFormOptions}
                            siblingCount={active.length}
                            dataAttrPrefix={dataAttrPrefix}
                            onOpen={() => openQuestion(section.id, question.id)}
                            onDuplicate={() => {
                              pendingNewQuestion.current = section.id;
                              onChange({ kind: "duplicate-question", sectionId: section.id, questionId: question.id });
                            }}
                            onDelete={() => onChange({ kind: "delete-question", sectionId: section.id, questionId: question.id })}
                            onDragStart={() => setDragId(question.id)}
                            onDragEnd={() => setDragId(null)}
                            onMove={(direction) => {
                              const ids = active.map((q) => q.id);
                              const over = ids[ids.indexOf(question.id) + direction];
                              if (over) onChange({ kind: "reorder", sectionId: section.id, orderedIds: reorderedIds(ids, question.id, over) });
                            }}
                          />
                        )}
                      </li>
                    ))}
                    {off.map((question) => (
                      <li key={question.id} className="flex min-h-[48px] items-center gap-3 py-1" data-question-id={question.id} data-off="true">
                        <span className="min-w-0 flex-1 truncate text-sm text-muted">{question.label || "Untitled question"}</span>
                        <span className="shrink-0 text-xs text-muted">Off</span>
                        <button
                          type="button"
                          className="min-h-11 shrink-0 text-[13px] font-semibold text-primary hover:underline"
                          onClick={() => onChange({ kind: "restore-question", sectionId: section.id, questionId: question.id })}
                          data-attr={`${dataAttrPrefix}-question-restore`}
                        >
                          Add back
                        </button>
                      </li>
                    ))}
                  </ul>
                  <div className="flex items-center justify-between gap-3 pt-2">
                    <button
                      type="button"
                      className="min-h-11 text-[13px] font-semibold text-primary hover:underline"
                      onClick={() => {
                        pendingNewQuestion.current = section.id;
                        onChange({ kind: "add-question", sectionId: section.id });
                      }}
                      data-attr={`${dataAttrPrefix}-add-question`}
                    >
                      + Add question
                    </button>
                    {section.removable ? (
                      <button
                        type="button"
                        className="min-h-11 text-[13px] font-semibold text-danger hover:underline"
                        onClick={() => onChange({ kind: "remove-section", sectionId: section.id })}
                        data-attr={`${dataAttrPrefix}-section-remove`}
                      >
                        Remove section
                      </button>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </section>
          );
        })}
      </div>
      {canAddSection ? (
        <button
          type="button"
          className="mt-3 flex min-h-[44px] w-full items-center justify-center rounded-xl border border-dashed border-border bg-card text-sm font-semibold text-primary"
          onClick={() => onChange({ kind: "add-section" })}
          data-attr={`${dataAttrPrefix}-add-section`}
        >
          + Add section
        </button>
      ) : null}
    </div>
  );
}

function QuestionRow({
  question,
  allowedTypes,
  linkedFormOptions,
  siblingCount,
  dataAttrPrefix,
  onOpen,
  onDuplicate,
  onDelete,
  onDragStart,
  onDragEnd,
  onMove,
}: {
  question: QuestionEditorQuestion;
  allowedTypes: readonly QuestionEditorType[];
  linkedFormOptions?: readonly LinkedFormOption[];
  siblingCount: number;
  dataAttrPrefix: string;
  onOpen: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onMove: (direction: -1 | 1) => void;
}) {
  const movable = question.can?.move !== false && siblingCount > 1;
  const typeLabel = allowedTypes.find((type) => type.id === question.type)?.label ?? question.type;
  const title = question.label.trim() || "Untitled question";
  const linkedNames = linkedFormOptions
    ? [...new Set((question.linkedForms ?? []).map((rule) => linkedFormOptions.find((option) => linkedFormKey(option.ref) === linkedFormKey(rule.formRef))?.label).filter((name): name is string => Boolean(name)))]
    : [];
  return (
    <div className="flex min-h-[52px] items-center gap-2" data-attr={`${dataAttrPrefix}-question-row`}>
      <button
        type="button"
        className={cn("flex h-9 w-6 shrink-0 cursor-grab items-center justify-center text-muted", !movable && "invisible")}
        aria-label={`Reorder ${title}`}
        draggable={movable}
        disabled={!movable}
        onDragStart={(event) => {
          event.dataTransfer?.setData("text/plain", question.id);
          onDragStart();
        }}
        onDragEnd={onDragEnd}
        onKeyDown={(event) => {
          if (event.key === "ArrowUp") {
            event.preventDefault();
            onMove(-1);
          } else if (event.key === "ArrowDown") {
            event.preventDefault();
            onMove(1);
          }
        }}
        data-attr={`${dataAttrPrefix}-question-handle`}
      >
        <GripVertical className="h-4 w-4" aria-hidden />
      </button>
      <button
        type="button"
        className="flex min-h-[52px] min-w-0 flex-1 items-center gap-3 text-left"
        onClick={onOpen}
        data-attr={`${dataAttrPrefix}-question-open`}
      >
        <span className={cn("min-w-0 flex-1 truncate text-sm", question.label.trim() ? "text-foreground" : "text-muted")}>{title}</span>
        {linkedNames.length > 0 ? (
          <span className="hidden min-w-0 max-w-[40%] shrink items-center gap-1 truncate text-xs text-muted sm:inline-flex" data-attr={`${dataAttrPrefix}-question-linked-forms`}>
            <FileText className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span className="truncate">{linkedNames.join(", ")}</span>
          </span>
        ) : null}
        <span className="hidden shrink-0 text-xs text-muted sm:inline">{typeLabel}</span>
        <span className="shrink-0 text-xs text-muted">{question.required ? "Required" : "Optional"}</span>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            aria-label={`Actions for ${title}`}
            className={RECORD_ACTION_TRIGGER_BUTTON_CLASS}
            data-attr={`${dataAttrPrefix}-question-menu`}
          >
            <MoreHorizontal className={RECORD_ACTION_TRIGGER_ICON_CLASS} aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" backdrop={false} className="z-[10060]">
          <DropdownMenuItem onSelect={onOpen} data-attr={`${dataAttrPrefix}-menu-edit`}>Edit</DropdownMenuItem>
          <DropdownMenuItem onSelect={onDuplicate} data-attr={`${dataAttrPrefix}-menu-duplicate`}>Duplicate</DropdownMenuItem>
          {question.can?.remove === false ? null : (
            <DropdownMenuItem className="text-danger" onSelect={onDelete} data-attr={`${dataAttrPrefix}-menu-delete`}>Delete</DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** Keeps what is being typed (a trailing space) until the field loses focus; the stored name is trimmed. */
function SectionNameInput({ name, onRename, dataAttr }: { name: string; onRename: (name: string) => void; dataAttr: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <Input
      value={draft ?? name}
      onChange={(event) => {
        setDraft(event.target.value);
        onRename(event.target.value);
      }}
      onBlur={() => setDraft(null)}
      placeholder="Section name"
      aria-label="Section name"
      data-attr={dataAttr}
    />
  );
}
