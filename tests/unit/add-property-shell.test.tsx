// @vitest-environment jsdom
//
// Add property renders through the same shell as every other Add pop-up (upload-everywhere-1005):
// footer Delete . Back . Next, the last step "Create property" (an edit says "Save" and has no Delete),
// Delete on a new property confirms and then discards the draft (the x still keeps it), a progress bar
// above the step, and ONE header Upload icon on every step.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const saveDraft = vi.hoisted(() => vi.fn());
const deleteDraft = vi.hoisted(() => vi.fn());
vi.mock("@/lib/demo-admin-property-inventory", () => ({
  saveManagerPropertyDraftToServer: (...args: unknown[]) => saveDraft(...args),
  deleteManagerPropertyDraft: (...args: unknown[]) => deleteDraft(...args),
  publishManagerPropertyDraftToServer: vi.fn(),
}));
vi.mock("@/lib/demo-property-pipeline", () => ({
  submitManagerPendingPropertyToServer: vi.fn(),
  updateExtraListingFromSubmissionOnServer: vi.fn(),
}));
vi.mock("@/lib/manager-subscription-client", () => ({ loadManagerPaymentWaiverGrantedClient: vi.fn(async () => false) }));
vi.mock("@/lib/native/detect-native", () => ({ isNativeRuntimeSync: () => false }));
vi.mock("@/lib/analytics/track-client", () => ({ track: vi.fn() }));
vi.mock("@/lib/prepare-listing-submission-for-persist", () => ({
  prepareListingSubmissionForPersist: vi.fn(async (sub: unknown) => ({ submission: sub, droppedMediaCount: 0 })),
  listingSaveFailureMessage: (reason: string) => reason || "Could not save.",
}));

import { ListingWizardV2 } from "@/components/portal/listing-wizard-v2";
import { LISTING_V2_STEPS, ListingEditorV2 } from "@/components/portal/listing-wizard-v2/listing-editor";
import { IMPORT_FILE_ACCEPT } from "@/components/portal/listing-wizard-v2/import-upload-step";
import { PortalAssistantConfigProvider } from "@/lib/axis-assistant/portal-assistant-context";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";

const rail = (id: string) => document.querySelector(`[data-attr="listing-v2-rail-${id}"]`)!;
const button = (name: string | RegExp) => screen.queryByRole("button", { name });

function mountEditor(opts: { isEdit?: boolean; onDiscardDraft?: () => void; onPick?: (f: File) => void } = {}) {
  render(
    <PortalAssistantConfigProvider endpoint="/api/agent/chat" managerName={null}>
      <ListingEditorV2
        title="New listing"
        submission={createDefaultListingSubmission()}
        onChange={() => {}}
        onClose={() => {}}
        onPublish={() => {}}
        isEdit={opts.isEdit}
        onDiscardDraft={opts.onDiscardDraft}
        headerUpload={opts.onPick ? { accept: IMPORT_FILE_ACCEPT, onPick: opts.onPick } : undefined}
      />
    </PortalAssistantConfigProvider>,
  );
}

beforeEach(() => {
  saveDraft.mockReset().mockResolvedValue("draft-1");
  deleteDraft.mockReset().mockResolvedValue(true);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Add property footer", () => {
  it("is Delete . Next on Basics, Delete . Back . Next after it, and Create property on the last step", () => {
    mountEditor({ onDiscardDraft: vi.fn() });
    expect(button("Delete")).toBeTruthy();
    expect(button("Back")).toBeNull(); // nothing before Basics
    expect(button(/^Next: Rooms$/)?.textContent).toBe("Next");
    fireEvent.click(rail("rooms"));
    expect(button("Delete")).toBeTruthy();
    expect(button("Back")).toBeTruthy();
    expect(button("Create property")).toBeNull();
    fireEvent.click(rail("review"));
    expect(button("Create property")).toBeTruthy();
    expect(button(/^Next: /)).toBeNull();
    expect(button("Publish")).toBeNull();
    expect(button("Continue")).toBeNull();
    // Delete is first, Back before the primary: left to right.
    const footer = button("Delete")!.closest("div.border-t")!;
    const order = Array.from(footer.querySelectorAll("button")).map((b) => b.textContent);
    expect(order).toEqual(["Delete", "Back", "Create property"]);
    // No "Step n of N" counter between them.
    expect(footer.textContent).not.toMatch(/Step \d+ of \d+/);
  });

  it("a new property without a discard handler has no Delete; an edit says Save and never has Delete", () => {
    mountEditor();
    expect(button("Delete")).toBeNull();
    cleanup();
    mountEditor({ isEdit: true, onDiscardDraft: vi.fn() });
    expect(button("Delete")).toBeNull();
    fireEvent.click(rail("review"));
    expect(button("Save")).toBeTruthy();
    expect(button("Create property")).toBeNull();
  });

  it("draws a progress bar with one segment per step, filled up to the current one", () => {
    mountEditor();
    const segments = Array.from(document.querySelectorAll("[data-step-progress]"));
    expect(segments).toHaveLength(LISTING_V2_STEPS.length);
    expect(segments[0]!.className).toContain("bg-primary");
    expect(segments[1]!.className).toContain("bg-border");
    fireEvent.click(rail("rooms"));
    expect(document.querySelectorAll("[data-step-progress]")[1]!.className).toContain("bg-primary");
  });
});

describe("Delete on a new property", () => {
  function mountWizard(over: { initialDraftId?: string | null } = {}) {
    const onClose = vi.fn();
    const onDiscarded = vi.fn();
    render(
      <ListingWizardV2
        onClose={onClose}
        onDiscarded={onDiscarded}
        userId="mgr-1"
        skuTier="starter"
        showToast={vi.fn()}
        initialDraftId={over.initialDraftId ?? null}
        initialSubmission={over.initialDraftId ? { ...createDefaultListingSubmission(), address: "142 Ash St" } : null}
      />,
    );
    return { onClose, onDiscarded };
  }

  it("asks first; cancel keeps everything", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const { onClose, onDiscarded } = mountWizard({ initialDraftId: "draft-1" });
    fireEvent.click(button("Delete")!);
    await waitFor(() => expect(window.confirm).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(deleteDraft).not.toHaveBeenCalled();
    expect(onDiscarded).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("deletes the saved draft row after the confirm, then hands control to the host (not onClose)", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { onClose, onDiscarded } = mountWizard({ initialDraftId: "draft-1" });
    fireEvent.click(button("Delete")!);
    await waitFor(() => expect(onDiscarded).toHaveBeenCalledTimes(1));
    expect(deleteDraft).toHaveBeenCalledWith("draft-1", "mgr-1");
    expect(saveDraft).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("a property that was never saved just closes: nothing to delete", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { onDiscarded } = mountWizard();
    fireEvent.click(button("Delete")!);
    await waitFor(() => expect(onDiscarded).toHaveBeenCalledTimes(1));
    expect(deleteDraft).not.toHaveBeenCalled();
    expect(saveDraft).not.toHaveBeenCalled();
  });

  it("a failed delete keeps the editor open and says so", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    deleteDraft.mockResolvedValue(false);
    const showToast = vi.fn();
    const onDiscarded = vi.fn();
    render(
      <ListingWizardV2
        onClose={vi.fn()}
        onDiscarded={onDiscarded}
        userId="mgr-1"
        skuTier="starter"
        showToast={showToast}
        initialDraftId="draft-1"
        initialSubmission={{ ...createDefaultListingSubmission(), address: "142 Ash St" }}
      />,
    );
    fireEvent.click(button("Delete")!);
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.stringContaining("Could not delete the draft")));
    expect(onDiscarded).not.toHaveBeenCalled();
  });

  it("closing with the x still keeps the draft: it saves and never deletes", async () => {
    const onClose = vi.fn();
    render(
      <ListingWizardV2
        onClose={onClose}
        onDiscarded={vi.fn()}
        userId="mgr-1"
        skuTier="starter"
        showToast={vi.fn()}
        initialSubmission={null}
      />,
    );
    fireEvent.click(document.querySelector("[data-attr='listing-v2-kind-house']")!);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(saveDraft).toHaveBeenCalled();
    expect(deleteDraft).not.toHaveBeenCalled();
  });
});

describe("the Start from a file card", () => {
  it("tops the first step of Add property, exactly once, with its chips; no other step and no edit has one", () => {
    mountEditor({ onPick: vi.fn() });
    expect(document.querySelectorAll("[data-attr='listing-v2-header-upload']")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Choose file" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Upload" })).toBeNull();
    expect(screen.getByText("Start from a file")).toBeTruthy();
    for (const step of LISTING_V2_STEPS.slice(1)) {
      fireEvent.click(rail(step.id));
      expect(document.querySelector("[data-attr='listing-v2-header-upload']")).toBeNull();
    }
    cleanup();
    mountEditor({ isEdit: true, onPick: vi.fn() });
    expect(document.querySelector("[data-attr='listing-v2-header-upload']")).toBeNull();
  });

  it("a file picked on the card reaches the reader and stays on Basics", () => {
    const onPick = vi.fn();
    mountEditor({ onPick });
    expect(rail("basics").getAttribute("aria-current")).toBe("step");
    const input = document.querySelector<HTMLInputElement>("[data-attr='import-upload-file-input']")!;
    const file = new File(["a,b"], "rent-roll.csv", { type: "text/csv" });
    fireEvent.change(input, { target: { files: [file] } });
    expect(onPick).toHaveBeenCalledWith(file);
    expect(rail("basics").getAttribute("aria-current")).toBe("step");
  });
});
