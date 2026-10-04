/**
 * The shape the shared question editor draws and the changes it reports. Both forms that use it (the
 * application and the move-in form) adapt their own stored questions to this and back, so the editor
 * itself knows nothing about either storage format.
 */

export type QuestionEditorType = { id: string; label: string };

/** What the manager may change on one question. Absent = allowed. */
export type QuestionEditorCan = {
  label?: boolean;
  type?: boolean;
  required?: boolean;
  options?: boolean;
  /** The choices can be reworded only: none added, removed or reordered (the system reads their stored values). */
  fixedOptions?: boolean;
  remove?: boolean;
  move?: boolean;
};

export type QuestionEditorQuestion = {
  id: string;
  label: string;
  type: string;
  required: boolean;
  options: string[];
  /** A PropLane question switched off for this form: drawn muted, with Add back. */
  off?: boolean;
  /** "Show only if": the question appears only while a sibling holds this answer. A hidden question is never required. */
  showIf?: { fieldKey: string; equals: string };
  /** Siblings this question can depend on (key + words). Absent or empty hides the control. */
  showIfCandidates?: { key: string; label: string }[];
  /** A problem with this question (empty words, duplicate key), shown in its open form. */
  error?: string | null;
  can?: QuestionEditorCan;
};

export type QuestionEditorSection = {
  id: string;
  name: string;
  /** Absent = the section has no switch (a move-in form's sections are always on). */
  enabled?: boolean;
  /** The name is an input inside the open section (move-in sections). */
  renamable?: boolean;
  /** A red Remove section sits at the foot of the open section. */
  removable?: boolean;
  questions: QuestionEditorQuestion[];
};

export type QuestionEditorPatch = Partial<Pick<QuestionEditorQuestion, "label" | "type" | "required" | "options" | "showIf">>;

export type QuestionEditorChange =
  | { kind: "toggle-section"; sectionId: string; enabled: boolean }
  | { kind: "add-section" }
  | { kind: "rename-section"; sectionId: string; name: string }
  | { kind: "remove-section"; sectionId: string }
  | { kind: "add-question"; sectionId: string }
  | { kind: "edit-question"; sectionId: string; questionId: string; patch: QuestionEditorPatch }
  | { kind: "duplicate-question"; sectionId: string; questionId: string }
  | { kind: "delete-question"; sectionId: string; questionId: string }
  | { kind: "restore-question"; sectionId: string; questionId: string }
  | { kind: "reorder"; sectionId: string; orderedIds: string[] };

export function questionCountText(count: number): string {
  return `${count} question${count === 1 ? "" : "s"}`;
}

/** The new order after dragging `dragId` onto `overId` (it takes the target's place). */
export function reorderedIds(ids: readonly string[], dragId: string, overId: string): string[] {
  const from = ids.indexOf(dragId);
  const to = ids.indexOf(overId);
  if (from < 0 || to < 0 || from === to) return [...ids];
  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, dragId);
  return next;
}
