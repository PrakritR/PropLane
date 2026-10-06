// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

afterEach(cleanup);
import { AddWorkspace } from "@/components/portal/add-workspace";
import { WorkspaceFileCard, acceptChips } from "@/components/portal/add-workspace/upload-action";

describe("WorkspaceFileCard (Start from a file)", () => {
  it("shows the title, the flow's chips and Choose file, and delivers the picked file once", () => {
    const onPick = vi.fn();
    render(<WorkspaceFileCard accept="application/pdf,.pdf" chips={[".pdf", "up to 8 MB"]} onPick={onPick} dataAttr="t-card" />);
    expect(screen.getByText("Start from a file")).toBeTruthy();
    expect(screen.getByText(".pdf")).toBeTruthy();
    expect(screen.getByText("up to 8 MB")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Choose file" })).toBeTruthy();
    const file = new File(["x"], "lease.pdf", { type: "application/pdf" });
    fireEvent.change(document.querySelector<HTMLInputElement>("[data-attr='t-card-input']")!, { target: { files: [file] } });
    expect(onPick).toHaveBeenCalledExactlyOnceWith(file);
  });

  it("takes several files when the upload is the record, and offers extra doors as buttons", () => {
    const onPickMany = vi.fn();
    const onSelect = vi.fn();
    render(<WorkspaceFileCard accept="" onPick={() => undefined} onPickMany={onPickMany} extraItems={[{ label: "Import a portfolio", onSelect }]} />);
    const files = [new File(["a"], "a.pdf"), new File(["b"], "b.png")];
    fireEvent.change(document.querySelector<HTMLInputElement>("input[type='file']")!, { target: { files } });
    expect(onPickMany).toHaveBeenCalledWith(files);
    fireEvent.click(screen.getByRole("button", { name: "Import a portfolio" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("derives chips from an accept string", () => {
    expect(acceptChips("application/pdf,image/png,image/jpeg,.csv", 5)).toEqual([".pdf", "images", ".csv", "up to 5 MB"]);
  });
});

describe("AddWorkspace headerUpload", () => {
  const steps = [{ id: "a", label: "Alpha" }, { id: "b", label: "Beta" }];
  const mount = (current: number) => render(
    <AddWorkspace title="Add thing" steps={steps} current={current} onJump={() => undefined} onClose={() => undefined} assistantContext="x" assistantScopeKey="x" lastLabel="Add" onFinish={() => undefined}
      headerUpload={{ accept: "application/pdf", chips: [".pdf"], onPick: () => undefined, dataAttr: "thing-upload" }}>
      <p>body</p>
    </AddWorkspace>,
  );
  it("draws the card on the first step and no header Upload icon", () => {
    mount(0);
    expect(document.querySelectorAll("[data-attr='thing-upload']")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Upload" })).toBeNull();
  });
  it("draws nothing on later steps", () => {
    mount(1);
    expect(document.querySelector("[data-attr='thing-upload']")).toBeNull();
  });
});
