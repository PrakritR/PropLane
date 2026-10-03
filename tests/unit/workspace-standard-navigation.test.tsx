// @vitest-environment jsdom
import React, { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { WorkspaceUploadAction } from "@/components/portal/add-workspace/upload-action";
import { ListingWorkspace, StepRail } from "@/components/portal/listing-wizard-v2/wizard-primitives";

afterEach(cleanup);

describe("workspace navigation", () => {
  it("routes the compact jump control through the same controlled step callback", () => {
    const onJump = vi.fn();
    render(<StepRail steps={[{ id: "contact", label: "Contact" }, { id: "review", label: "Review", attention: 1 }]} current={0} onJump={onJump} />);
    fireEvent.click(screen.getByRole("button", { name: "Contact" }));
    const review = screen.getAllByRole("option").find((o) => o.textContent?.includes("Review"));
    expect(review).toBeTruthy();
    fireEvent.click(review!);
    expect(onJump).toHaveBeenCalledWith(1);
    expect(screen.getByRole("button", { name: "Contact" }).getAttribute("aria-current")).toBe("step");
  });

  it("changing the anchored step picker keeps the workspace and typed fields mounted", () => {
    function Harness() {
      const [current, setCurrent] = useState(0);
      return <ListingWorkspace title="Editor" footer={null} rail={<StepRail steps={[{ id: "one", label: "One" }, { id: "two", label: "Two" }]} current={current} onJump={setCurrent} />}>
        <input aria-label="Retained name" defaultValue="" />
      </ListingWorkspace>;
    }
    render(<Harness />);
    const input = screen.getByRole("textbox", { name: "Retained name" });
    fireEvent.change(input, { target: { value: "Casey" } });
    fireEvent.click(screen.getByRole("button", { name: "One" }));
    const two = screen.getAllByRole("option").find((o) => o.textContent?.includes("Two"));
    expect(two).toBeTruthy();
    fireEvent.click(two!);
    expect(screen.getByRole("textbox", { name: "Retained name" })).toBe(input);
    expect((input as HTMLInputElement).value).toBe("Casey");
    expect(screen.getByRole("button", { name: "Two" }).getAttribute("aria-current")).toBe("step");
  });

  it("Enter advances a text input without submitting textareas or picker controls", () => {
    const onContinue = vi.fn();
    render(<ListingWorkspace title="Add resident" rail={null} footer={null} onContinue={onContinue}>
      <input aria-label="Name" />
      <textarea aria-label="Notes" />
      <input aria-label="Address search" role="combobox" aria-expanded="false" aria-controls="address-options" />
    </ListingWorkspace>);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Notes" }), { key: "Enter" });
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Address search" }), { key: "Enter" });
    expect(onContinue).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Name" }), { key: "Enter" });
    expect(onContinue).toHaveBeenCalledTimes(1);
  });
});


describe("workspace uploads", () => {
  it("moves the real file input to the header and delivers the selected file once", () => {
    const onPick = vi.fn();
    render(<ListingWorkspace title="Add resident" rail={null} footer={null}>
      <WorkspaceUploadAction accept="application/pdf,image/*" dataAttr="test-upload" onPick={onPick} />
    </ListingWorkspace>);
    const input = screen.getByLabelText("Start from a file", { selector: "input" });
    expect(input.closest("main")).toBeNull();
    const file = new File(["sample"], "application.pdf", { type: "application/pdf" });
    fireEvent.change(input, { target: { files: [file] } });
    expect(onPick).toHaveBeenCalledExactlyOnceWith(file);
    expect(screen.getByLabelText("Take photo").getAttribute("capture")).toBe("environment");
  });
});

// The workspace owns attempted validation; each door still owns its domain gate.
import { AddWorkspace } from "@/components/portal/add-workspace";

describe("workspace required fields", () => {
  it("an unavailable Continue can report Required without advancing; hidden steps do not block", () => {
    const onJump = vi.fn();
    const before = vi.fn(() => true);
    const props = { title: "Test editor", steps: [{ id: "name", label: "Name" }, { id: "review", label: "Review" }], current: 0, onJump, onClose: vi.fn(), assistantContext: "Test editor", assistantScopeKey: "test", lastLabel: "Create", onFinish: vi.fn(), onBeforeNext: before };
    const { rerender } = render(<AddWorkspace {...props} nextDisabled>
      <label>Name<input required /></label>
      <div hidden><input required aria-label="Other step" /></div>
    </AddWorkspace>);
    fireEvent.click(screen.getByRole("button", { name: "Continue to Review" }));
    expect(screen.getByRole("alert").textContent).toContain("Required");
    expect(onJump).not.toHaveBeenCalled();
    expect(before).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Casey" } });
    rerender(<AddWorkspace {...props}>
      <label>Name<input required defaultValue="Casey" /></label>
      <div hidden><input required aria-label="Other step" /></div>
    </AddWorkspace>);
    fireEvent.click(screen.getByRole("button", { name: "Continue to Review" }));
    expect(before).toHaveBeenCalledTimes(1);
    expect(onJump).toHaveBeenCalledExactlyOnceWith(1);
  });
});
