// @vitest-environment jsdom
/**
 * Edit / Add application, Edit / Add lease, Edit / Add move-in form and the room pricing popup share ONE
 * frame (`AddWorkspace`): the same header words, step rail, progress bar, step heading, preview-card title
 * and footer. The rules are proved on the frame itself; the four popups are proved to use its shared parts.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { AddWorkspace, workspaceSaveState } from "@/components/portal/add-workspace";
import { AppUiProvider } from "@/components/providers/app-ui-provider";

afterEach(() => cleanup());

const src = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

const POPUPS = {
  application: "src/components/portal/pro-application-questions-editor-modal.tsx",
  lease: "src/components/portal/property-lease-form-modal.tsx",
  moveIn: "src/components/portal/move-in-forms/move-in-form-editor-modal.tsx",
  pricing: "src/components/portal/property-room-pricing-workspace.tsx",
} as const;

function frame(steps: { id: string; label: string; summary?: string }[], extra: Partial<Parameters<typeof AddWorkspace>[0]> = {}) {
  return render(
    <AppUiProvider>
      <AddWorkspace
        title="Edit thing"
        steps={steps}
        current={0}
        onJump={() => {}}
        onClose={() => {}}
        assistantContext="Edit thing"
        assistantScopeKey="edit-thing"
        lastLabel="Save"
        onFinish={() => {}}
        {...extra}
      >
        <p>Body</p>
      </AddWorkspace>
    </AppUiProvider>,
  );
}

describe("the frame", () => {
  it("a one-step popup draws no rail and no progress bar; a multi-step one draws both", () => {
    frame([{ id: "pricing", label: "Pricing" }]);
    expect(document.querySelector('[aria-label="Step progress"]')).toBeNull();
    expect(document.querySelector('[data-rail="none"]')).not.toBeNull();
    cleanup();
    frame([{ id: "a", label: "First", summary: "One line" }, { id: "b", label: "Second", summary: "Another line" }]);
    expect(document.querySelectorAll('[aria-label="Step progress"] [data-step-progress]')).toHaveLength(2);
    expect(document.querySelector('[data-rail="none"]')).toBeNull();
    expect(screen.getAllByText("One line").length).toBeGreaterThan(0);
  });

  it("the footer is red Delete text at the left (edit only), Back, and the primary at the right", () => {
    const onDelete = vi.fn();
    frame([{ id: "a", label: "First" }, { id: "b", label: "Second" }], { current: 1, onDelete, deleteDataAttr: "thing-delete" });
    const del = document.querySelector('[data-workspace-delete]') as HTMLElement;
    expect(del.textContent).toBe("Delete");
    expect(del.className).toContain("text-danger");
    expect(del.className).not.toMatch(/\bborder\b|rounded-full|\bbg-/);
    const buttons = Array.from(document.querySelectorAll<HTMLElement>("button")).filter((b) => ["Delete", "Back", "Save"].includes(b.textContent ?? ""));
    expect(buttons.map((b) => b.textContent)).toEqual(["Delete", "Back", "Save"]);
    cleanup();
    frame([{ id: "a", label: "First" }, { id: "b", label: "Second" }], { current: 1 });
    expect(document.querySelector("[data-workspace-delete]")).toBeNull();
  });

  it("the header says Saved / Not saved yet the same way for every popup", () => {
    expect(workspaceSaveState({ dirty: false })).toBe("Saved");
    expect(workspaceSaveState({ dirty: true })).toBe("Not saved yet");
    expect(workspaceSaveState({ dirty: false, isNew: true })).toBe("Not saved yet");
    expect(workspaceSaveState({ dirty: true, busy: true })).toBe("Saving…");
  });
});

describe("the four popups use the shared frame parts", () => {
  it("each one composes AddWorkspace and none draws its own bordered Delete or progress bar", () => {
    for (const [name, file] of Object.entries(POPUPS)) {
      const body = src(file);
      expect(body, name).toContain("<AddWorkspace");
      expect(body, name).not.toContain("border-red-200");
      expect(body, name).not.toContain("Step progress");
    }
  });

  it("application, lease and move-in delete through the frame's Delete; the header words come from one helper", () => {
    for (const name of ["application", "lease", "moveIn"] as const) {
      const body = src(POPUPS[name]);
      expect(body, name).toContain("onDelete=");
      expect(body, name).not.toContain("dangerAction=");
      expect(body, name).toContain("workspaceSaveState(");
    }
    expect(src(POPUPS.pricing)).toContain("workspaceSaveState(");
  });

  it("every step heading is the same StepHeading, including the single-step pricing popup", () => {
    for (const [name, file] of Object.entries(POPUPS)) expect(src(file), name).toContain("<StepHeading");
  });

  it("the preview card titles share one style: Applicant sees, Resident sees, Lease preview, What a resident pays", () => {
    expect(src("src/components/portal/application-form-builder.tsx")).toContain("<WorkspacePreviewTitle>Applicant sees</WorkspacePreviewTitle>");
    expect(src("src/components/portal/move-in-forms/move-in-form-live-preview.tsx")).toContain("<WorkspacePreviewTitle>Resident sees</WorkspacePreviewTitle>");
    expect(src(POPUPS.lease)).toContain("<WorkspacePreviewTitle>Lease preview</WorkspacePreviewTitle>");
    // The pricing receipt titles its card with PanelSection, which draws the identical heading style.
    const frameStyle = /text-\[11\.5px\] font-bold uppercase tracking-\[0\.06em\] text-muted/;
    expect(src("src/components/portal/add-workspace/frame.tsx")).toMatch(frameStyle);
    expect(src("src/components/portal/listing-wizard-v2/wizard-primitives.tsx")).toMatch(frameStyle);
    expect(src("src/components/portal/listing-wizard-v2/listing-side-panel.tsx")).toContain('<PanelSection title="What a resident pays">');
  });
});
