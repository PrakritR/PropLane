// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

afterEach(cleanup);
import { AddWorkspace } from "@/components/portal/add-workspace";
import { WorkspaceFileCard, fileMatchesAccept } from "@/components/portal/add-workspace/upload-action";

describe("WorkspaceFileCard (Start from a file)", () => {
  it("shows the title and Choose file with no format chips, and delivers the picked file once", () => {
    const onPick = vi.fn();
    render(<WorkspaceFileCard accept="application/pdf,.pdf" onPick={onPick} dataAttr="t-card" />);
    expect(screen.getByText("Start from a file")).toBeTruthy();
    expect(screen.queryByText(".pdf")).toBeNull();
    expect(screen.queryByText(/up to \d/)).toBeNull();
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

  it("refuses a wrong type with a visible error and never hands it to the reader", () => {
    const onPick = vi.fn();
    render(<WorkspaceFileCard accept="application/pdf,.pdf" onPick={onPick} dataAttr="t-card" />);
    const input = document.querySelector<HTMLInputElement>("[data-attr='t-card-input']")!;
    fireEvent.change(input, { target: { files: [new File(["x"], "photo.png", { type: "image/png" })] } });
    expect(onPick).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/isn't supported/);
    fireEvent.change(input, { target: { files: [new File(["x"], "lease.pdf", { type: "application/pdf" })] } });
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("matches a file against MIME types, wildcards and extensions", () => {
    expect(fileMatchesAccept({ name: "a.pdf", type: "application/pdf" }, "application/pdf,image/*")).toBe(true);
    expect(fileMatchesAccept({ name: "a.heic", type: "image/heic" }, "application/pdf,image/*")).toBe(true);
    expect(fileMatchesAccept({ name: "a.csv", type: "" }, ".csv,.xlsx")).toBe(true);
    expect(fileMatchesAccept({ name: "a.exe", type: "application/x-msdownload" }, "application/pdf,image/*")).toBe(false);
    expect(fileMatchesAccept({ name: "a.anything", type: "" }, "")).toBe(true);
  });
});

describe("AddWorkspace headerUpload", () => {
  const steps = [{ id: "a", label: "Alpha" }, { id: "b", label: "Beta" }];
  const mount = (current: number) => render(
    <AddWorkspace title="Add thing" steps={steps} current={current} onJump={() => undefined} onClose={() => undefined} assistantContext="x" assistantScopeKey="x" lastLabel="Add" onFinish={() => undefined}
      headerUpload={{ accept: "application/pdf", onPick: () => undefined, dataAttr: "thing-upload" }}>
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
