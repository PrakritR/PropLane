// @vitest-environment jsdom
// The x keeps what was typed: a form that keeps its draft closes without a Discard question, says
// "Draft saved", and the same form opens on its answers again. Discard draft forgets them.
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { AddWorkspace } from "@/components/portal/add-workspace";
import { AppUiProvider } from "@/components/providers/app-ui-provider";
import { readSavedWizardDraft, useWizardDraft } from "@/hooks/use-wizard-draft";
import { clearWizardDraft, hasWizardDraft, readWizardDraft, writeWizardDraft } from "@/lib/wizard-draft-memory";

beforeEach(() => clearWizardDraft("t"));
afterEach(cleanup);

describe("wizard draft memory", () => {
  it("keeps, reads and forgets a draft by key", () => {
    expect(hasWizardDraft("t")).toBe(false);
    writeWizardDraft("t", { name: "Casey" });
    expect(readWizardDraft<{ name: string }>("t")).toEqual({ name: "Casey" });
    clearWizardDraft("t");
    expect(readWizardDraft("t")).toBeUndefined();
  });

  it("useWizardDraft writes while dirty, clears when the form goes clean, and never erases an untouched restore", () => {
    writeWizardDraft("t", { v: 1 });
    // A fresh, clean mount must not erase the draft it is about to restore.
    const { rerender } = renderHook(({ v, dirty }) => useWizardDraft("t", { v }, dirty), { initialProps: { v: 1, dirty: false } });
    expect(readSavedWizardDraft<{ v: number }>("t")).toEqual({ v: 1 });
    rerender({ v: 2, dirty: true });
    expect(readSavedWizardDraft<{ v: number }>("t")).toEqual({ v: 2 });
    rerender({ v: 0, dirty: false });
    expect(readSavedWizardDraft("t")).toBeUndefined();
  });

  it("discard forgets the draft", () => {
    const { result } = renderHook(() => useWizardDraft("t", { v: 3 }, true));
    expect(hasWizardDraft("t")).toBe(true);
    act(() => result.current.discard());
    expect(hasWizardDraft("t")).toBe(false);
  });
});

function Harness({ keepsDraft, onClose, onDiscardDraft }: { keepsDraft: boolean; onClose: () => void; onDiscardDraft?: () => void }) {
  const [step, setStep] = useState(0);
  return (
    <AppUiProvider>
      <AddWorkspace
        title="Add thing"
        steps={[{ id: "a", label: "A" }, { id: "review", label: "Review" }]}
        current={step}
        onJump={setStep}
        onClose={onClose}
        dirty
        keepsDraft={keepsDraft}
        onDiscardDraft={onDiscardDraft}
        assistantContext="Add thing"
        assistantScopeKey="add-thing"
        lastLabel="Add thing"
        onFinish={() => undefined}
      >
        <p>Body</p>
      </AddWorkspace>
    </AppUiProvider>
  );
}

describe("AddWorkspace keepsDraft", () => {
  it("closes on the x with no Discard question and says Draft saved", () => {
    const onClose = vi.fn();
    render(<Harness keepsDraft onClose={onClose} />);
    expect(screen.getByTestId("listing-wizard-autosave-status").textContent).toContain("Draft saved");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Discard this?")).toBeNull();
  });

  it("without keepsDraft a dirty form still asks before it closes", async () => {
    const onClose = vi.fn();
    render(<Harness keepsDraft={false} onClose={onClose} />);
    expect(screen.getByTestId("listing-wizard-autosave-status").textContent).toContain("Not saved yet");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).not.toHaveBeenCalled();
    expect(await screen.findByText("Discard this?")).toBeTruthy();
  });

  it("offers Discard draft, which forgets the draft after a tap and closes", async () => {
    const onClose = vi.fn();
    const onDiscardDraft = vi.fn();
    render(<Harness keepsDraft onClose={onClose} onDiscardDraft={onDiscardDraft} />);
    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
    await vi.waitFor(() => expect(onDiscardDraft).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
