// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { WorkspaceUploadAction } from "@/components/portal/add-workspace/upload-action";
import { ListingWorkspace, StepRail } from "@/components/portal/listing-wizard-v2/wizard-primitives";

afterEach(cleanup);

describe("workspace navigation", () => {
  it("routes the compact jump control through the same controlled step callback", () => {
    const onJump = vi.fn();
    render(<StepRail steps={[{ id: "contact", label: "Contact" }, { id: "review", label: "Review", attention: 1 }]} current={0} onJump={onJump} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Jump to step" }), { target: { value: "1" } });
    expect(onJump).toHaveBeenCalledWith(1);
    expect(screen.getByRole("button", { name: "Contact" }).getAttribute("aria-current")).toBe("step");
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
