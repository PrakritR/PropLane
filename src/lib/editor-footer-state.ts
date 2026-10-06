/**
 * The footer of the two popup editors (Edit / Add application and Edit / Add move-in form) is one shared shell
 * (`AddWorkspace`): Delete on the left; on the right Back (never on step 1) then Next, and on the last step Next
 * becomes Save (edit) or Create (add). Pure, so both editors and the test read one rule.
 */
export type EditorFooterMode = "add" | "edit";

export type EditorFooterState = {
  /** Back is drawn (not on the first step, and never on a tab rail). */
  showBack: boolean;
  /** The primary button commits instead of advancing. */
  isLast: boolean;
  /** "Next", or the commit word on the last step. */
  primaryLabel: string;
};

/** The commit word on the last step: Create when adding, Save when editing. */
export function editorFinishLabel(mode: EditorFooterMode): string {
  return mode === "add" ? "Create" : "Save";
}

export function editorFooterState(input: {
  /** A step exists before this one. */
  hasPrev: boolean;
  /** A step exists after this one. */
  hasNext: boolean;
  /** The commit word for the last step; defaults to "Save". */
  lastLabel?: string;
  /** A tab rail has no steps to walk: the primary is always the commit and Back is not drawn. */
  tabRail?: boolean;
}): EditorFooterState {
  const isLast = Boolean(input.tabRail) || !input.hasNext;
  return {
    showBack: !input.tabRail && input.hasPrev,
    isLast,
    primaryLabel: isLast ? (input.lastLabel ?? "Save") : "Next",
  };
}

/** The same rule for a plain 0-based step index over `steps` steps. */
export function editorFooterStateForStep(input: {
  step: number;
  steps: number;
  lastLabel?: string;
  tabRail?: boolean;
}): EditorFooterState {
  return editorFooterState({ hasPrev: input.step > 0, hasNext: input.step < input.steps - 1, lastLabel: input.lastLabel, tabRail: input.tabRail });
}
