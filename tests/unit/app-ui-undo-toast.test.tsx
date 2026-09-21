// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AppUiProvider, useAppUi } from "@/components/providers/app-ui-provider";

afterEach(() => cleanup());

function Trigger({ undo }: { undo?: () => void }) {
  const { showToast } = useAppUi();
  return (
    <button type="button" onClick={() => showToast("Marked as paid.", undo ? { undo } : undefined)}>
      Fire
    </button>
  );
}

describe("Undo-capable toast (AGENTS.md § The pop-up: one line, bottom center, Undo when reversible)", () => {
  it("a plain toast shows the message and no Undo button", () => {
    render(
      <AppUiProvider>
        <Trigger />
      </AppUiProvider>,
    );
    fireEvent.click(screen.getByText("Fire"));
    expect(screen.getByText("Marked as paid.")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("a reversible toast shows exactly one Undo button — never a second button", () => {
    render(
      <AppUiProvider>
        <Trigger undo={() => {}} />
      </AppUiProvider>,
    );
    fireEvent.click(screen.getByText("Fire"));
    const undoButtons = screen.getAllByRole("button", { name: "Undo" });
    expect(undoButtons).toHaveLength(1);
  });

  it("clicking Undo calls the undo function and dismisses the toast", () => {
    const undo = vi.fn();
    render(
      <AppUiProvider>
        <Trigger undo={undo} />
      </AppUiProvider>,
    );
    fireEvent.click(screen.getByText("Fire"));
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(undo).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Marked as paid.")).toBeNull();
  });
});
