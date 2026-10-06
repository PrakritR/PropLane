/**
 * The two popup editors (application, move-in form) share one footer: Delete on the left; Back (not on step 1) then
 * Next on the right; Save (edit) / Create (add) on the last step. One pure rule, read by the shared shell.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { editorFinishLabel, editorFooterState, editorFooterStateForStep } from "@/lib/editor-footer-state";

const read = (path: string) => readFileSync(path, "utf8");

describe("editor footer state", () => {
  it("step 1 shows no Back and a Next", () => {
    expect(editorFooterStateForStep({ step: 0, steps: 3, lastLabel: "Save" })).toEqual({ showBack: false, isLast: false, primaryLabel: "Next" });
  });

  it("a middle step shows Back and Next", () => {
    expect(editorFooterStateForStep({ step: 1, steps: 3, lastLabel: "Save" })).toEqual({ showBack: true, isLast: false, primaryLabel: "Next" });
  });

  it("the last step shows Back and Save when editing, Create when adding", () => {
    expect(editorFooterStateForStep({ step: 2, steps: 3, lastLabel: editorFinishLabel("edit") })).toEqual({ showBack: true, isLast: true, primaryLabel: "Save" });
    expect(editorFooterStateForStep({ step: 2, steps: 3, lastLabel: editorFinishLabel("add") })).toEqual({ showBack: true, isLast: true, primaryLabel: "Create" });
  });

  it("a two-step editor (application) walks Next then Save with Back on step 2 only", () => {
    expect(editorFooterStateForStep({ step: 0, steps: 2 })).toMatchObject({ showBack: false, primaryLabel: "Next" });
    expect(editorFooterStateForStep({ step: 1, steps: 2 })).toMatchObject({ showBack: true, primaryLabel: "Save" });
  });

  it("a one-step popup has neither Back nor Next, only the commit", () => {
    expect(editorFooterStateForStep({ step: 0, steps: 1, lastLabel: "Create" })).toEqual({ showBack: false, isLast: true, primaryLabel: "Create" });
  });

  it("a tab rail is always the commit, with no Back", () => {
    expect(editorFooterState({ hasPrev: true, hasNext: true, lastLabel: "Save", tabRail: true })).toEqual({ showBack: false, isLast: true, primaryLabel: "Save" });
  });

  it("off-path skipping decides Back and Next from the path, not the raw step", () => {
    expect(editorFooterState({ hasPrev: false, hasNext: false, lastLabel: "Add resident" })).toMatchObject({ showBack: false, isLast: true, primaryLabel: "Add resident" });
  });
});

describe("both editors use the one footer", () => {
  const shell = read("src/components/portal/add-workspace/index.tsx");
  const application = read("src/components/portal/pro-application-questions-editor-modal.tsx");
  const moveIn = read("src/components/portal/move-in-forms/move-in-form-editor-modal.tsx");

  it("the shell draws the footer once, from editorFooterState, with no Continue", () => {
    expect(shell).toContain("editorFooterState(");
    expect(shell.match(/data-attr=\{`\$\{dataAttrPrefix\}-back`\}/g)).toHaveLength(1);
    expect(shell).not.toMatch(/>\s*Continue\s*</);
    expect(shell).not.toContain("Continue to");
  });

  it("the application editor and the move-in form editor both mount the shell and name their last step with editorFinishLabel", () => {
    for (const source of [application, moveIn]) {
      expect(source).toContain("<AddWorkspace");
      expect(source).toContain("editorFinishLabel(");
      // Neither draws a footer of its own.
      expect(source).not.toMatch(/>\s*Continue\s*</);
    }
  });

  it("the move-in editor's Resident sees pane is the application editor's card, not a phone frame", () => {
    const preview = read("src/components/portal/move-in-forms/move-in-form-live-preview.tsx");
    expect(preview).toContain("rounded-2xl border border-border bg-card p-3.5");
    expect(preview).toContain("Resident sees");
    expect(preview).not.toContain("border-[7px]");
    expect(preview).not.toContain("Next question");
    expect(preview).not.toContain("Previous question");
  });
});
