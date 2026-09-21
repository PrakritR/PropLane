import { describe, expect, it, vi } from "vitest";
import { runRecordActionGate } from "@/lib/portals/record-action-gate";

function fakeUi() {
  const toasts: { message: string; undo?: () => void | Promise<void> }[] = [];
  const confirmResult = { value: true };
  return {
    toasts,
    ui: {
      confirm: vi.fn(async () => confirmResult.value),
      showToast: vi.fn((message: string, options?: { undo?: () => void | Promise<void> }) => {
        toasts.push({ message, undo: options?.undo });
      }),
    },
    setConfirmResult: (value: boolean) => {
      confirmResult.value = value;
    },
  };
}

describe("runRecordActionGate", () => {
  it("reversible: runs immediately, never asks confirm, and shows an Undo-capable toast", async () => {
    const { toasts, ui } = fakeUi();
    const run = vi.fn();
    const undo = vi.fn();
    const ok = await runRecordActionGate(
      { reversible: true, run, undo, message: "Marked as paid." },
      ui,
    );
    expect(ok).toBe(true);
    expect(ui.confirm).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(1);
    expect(toasts).toEqual([{ message: "Marked as paid.", undo }]);
  });

  it("not reversible: asks confirm first, runs and shows a plain toast only once confirmed", async () => {
    const { toasts, ui } = fakeUi();
    const run = vi.fn();
    const ok = await runRecordActionGate(
      { run, message: "Deleted.", confirmRequest: { description: "Delete this?" } },
      ui,
    );
    expect(ok).toBe(true);
    expect(ui.confirm).toHaveBeenCalledWith({ description: "Delete this?" });
    expect(run).toHaveBeenCalledTimes(1);
    expect(toasts).toEqual([{ message: "Deleted.", undo: undefined }]);
  });

  it("not reversible: a declined confirm never runs the action or shows a toast", async () => {
    const { toasts, ui, setConfirmResult } = fakeUi();
    setConfirmResult(false);
    const run = vi.fn();
    const ok = await runRecordActionGate(
      { run, message: "Deleted.", confirmRequest: { description: "Delete this?" } },
      ui,
    );
    expect(ok).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(toasts).toEqual([]);
  });

  it("not reversible with no confirmRequest: runs straight through (an action with no meaningful confirm copy)", async () => {
    const { toasts, ui } = fakeUi();
    const run = vi.fn();
    const ok = await runRecordActionGate({ run, message: "Done." }, ui);
    expect(ok).toBe(true);
    expect(ui.confirm).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(1);
    expect(toasts).toEqual([{ message: "Done.", undo: undefined }]);
  });

  it("reversible with no undo function: still shows the toast, just without an Undo button", async () => {
    const { toasts, ui } = fakeUi();
    await runRecordActionGate({ reversible: true, run: () => {}, message: "Archived." }, ui);
    expect(toasts).toEqual([{ message: "Archived.", undo: undefined }]);
  });
});
