// @vitest-environment jsdom
import { useState, type ReactNode, type InputHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EMPTY_DRAFT, type PromotionDraft } from "@/components/portal/promotion-form";
import type { PromotionTextGenerateOptions } from "@/components/portal/promotion-text-generate-modal";

const mocks = vi.hoisted(() => ({ confirm: vi.fn(), generate: vi.fn(), toast: vi.fn() }));
vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => mocks.confirm,
  useAppUi: () => ({ showToast: mocks.toast }),
}));
// Exercise the real composer state and imperative handle; dropdown rendering is
// covered in the browser spec using the shared FieldSingleSelect helper.
vi.mock("@/components/ui/input", () => ({
  Input: (props: InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  Select: (props: SelectHTMLAttributes<HTMLSelectElement>) => <select {...props} />,
  Textarea: (props: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...props} />,
}));
vi.mock("@/components/portal/add-workspace", () => ({
  AddWorkspace: ({ children, current, onJump, onFinish, onClose }: {
    children: ReactNode; current: number; onJump: (index: number) => void;
    onFinish: () => void; onClose: () => void;
  }) => <div>
    <button onClick={() => onJump(0)}>Go to Kind</button>
    <button onClick={() => onJump(1)}>Go to Content</button>
    <button onClick={() => onJump(2)}>Go to Preview</button>
    <button onClick={onClose}>Close workspace</button>
    {children}
    {current === 2 ? <button onClick={onFinish}>Generate promotion text</button> : null}
  </div>,
}));
vi.mock("@/components/portal/add-workspace/parts", () => ({
  PreviewPanel: () => null,
  WizardSelect: ({ label, value, options, onChange }: {
    label: string; value: string; options: { value: string; label: string }[];
    onChange: (value: string) => void;
  }) => <label>{label}<select value={value} onChange={(event) => onChange(event.target.value)}>
    {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
  </select></label>,
}));
vi.mock("@/components/portal/listing-wizard-v2/wizard-primitives", () => ({
  StepColumn: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  StepHeading: ({ title }: { title: string }) => <h2>{title}</h2>,
}));
vi.mock("@/components/portal/promotion-form", async () => ({
  ...await vi.importActual<typeof import("@/components/portal/promotion-form")>("@/components/portal/promotion-form"),
  PromotionForm: () => <div>Flyer content</div>,
}));
vi.mock("@/components/portal/promotion-ai-draft-card", () => ({
  PromotionAiDraftPhotoPicker: ({ images, onRemovePhoto }: { images: string[]; onRemovePhoto: (index: number) => void }) => <div>
    <output aria-label="Selected photos">{JSON.stringify(images)}</output>
    <button onClick={() => onRemovePhoto(0)}>Remove first photo</button>
  </div>,
}));
vi.mock("@/components/portal/promotion-upload-composer", () => ({ PromotionUploadComposer: () => null }));

import { PromotionNewModal } from "@/components/portal/promotion-new-modal";
const seedImages = ["first-real-photo", "second-real-photo"];

function Harness() {
  const [open, setOpen] = useState(true);
  const [draft, setDraft] = useState<PromotionDraft>(EMPTY_DRAFT);
  const [created, setCreated] = useState<PromotionTextGenerateOptions[]>([]);
  return <>
    <button onClick={() => setOpen(true)}>Reopen workspace</button>
    <output aria-label="Created assets">{created.length}</output>
    <PromotionNewModal open={open} onClose={() => setOpen(false)} initialKind="text" initialStepId="content"
      draft={draft} setDraft={setDraft} listings={[]} onSelectProperty={() => {}}
      onGenerateFlyer={() => {}} textInitialFormat="listing_blurb" textInitialTone="Calm & professional"
      textInitialImages={seedImages} onGenerateText={(options) => { mocks.generate(options); setCreated(rows => [...rows, options]); }} />
  </>;
}
const notes = "Keep the supplied facts and emphasize the private balcony.";
function editText() {
  fireEvent.change(screen.getByLabelText("Channel / format"), { target: { value: "email_blast" } });
  fireEvent.change(screen.getByLabelText("Tone"), { target: { value: "Bold & energetic" } });
  fireEvent.change(screen.getByLabelText(/Notes/), { target: { value: notes } });
  fireEvent.click(screen.getByRole("button", { name: "Remove first photo" }));
}
function expectEdited() {
  expect(screen.getByLabelText("Channel / format")).toHaveValue("email_blast");
  expect(screen.getByLabelText("Tone")).toHaveValue("Bold & energetic");
  expect(screen.getByLabelText(/Notes/)).toHaveValue(notes);
  expect(screen.getByLabelText("Selected photos")).toHaveTextContent(JSON.stringify([seedImages[1]]));
}
function expectSeed() {
  expect(screen.getByLabelText("Channel / format")).toHaveValue("listing_blurb");
  expect(screen.getByLabelText("Tone")).toHaveValue("Calm & professional");
  expect(screen.getByLabelText(/Notes/)).toHaveValue("");
  expect(screen.getByLabelText("Selected photos")).toHaveTextContent(JSON.stringify(seedImages));
}
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("promotion text composer through wizard steps", () => {
  it("retains one composer and exact options through Preview and generates one asset", () => {
    render(<Harness />);
    editText();
    const format = screen.getByLabelText("Channel / format");
    fireEvent.click(screen.getByRole("button", { name: "Go to Preview" }));
    expect(format).not.toBeVisible();
    expect(screen.queryByRole("combobox", { name: "Channel / format" })).toBeNull();
    expect(mocks.generate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Go to Content" }));
    expect(screen.getByLabelText("Channel / format")).toBe(format);
    expectEdited();
    fireEvent.click(screen.getByRole("button", { name: "Go to Preview" }));
    fireEvent.click(screen.getByRole("button", { name: "Generate promotion text" }));
    expect(mocks.generate).toHaveBeenCalledExactlyOnceWith({ format: "email_blast", tone: "Bold & energetic", extraInstructions: notes, images: [seedImages[1]] });
    expect(screen.getByLabelText("Created assets")).toHaveTextContent("1");
  });

  it("preserves text when a type switch is cancelled and resets only after confirmed discard", async () => {
    mocks.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    render(<Harness />);
    editText();
    fireEvent.click(screen.getByRole("button", { name: "Go to Kind" }));
    fireEvent.change(screen.getByLabelText("Promotion type"), { target: { value: "flyer" } });
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
    expect(screen.getByLabelText("Promotion type")).toHaveValue("text");
    fireEvent.click(screen.getByRole("button", { name: "Go to Content" }));
    expectEdited();
    fireEvent.click(screen.getByRole("button", { name: "Go to Kind" }));
    fireEvent.change(screen.getByLabelText("Promotion type"), { target: { value: "flyer" } });
    await waitFor(() => expect(screen.getByLabelText("Promotion type")).toHaveValue("flyer"));
    fireEvent.change(screen.getByLabelText("Promotion type"), { target: { value: "text" } });
    await waitFor(() => expect(screen.getByLabelText("Promotion type")).toHaveValue("text"));
    fireEvent.click(screen.getByRole("button", { name: "Go to Content" }));
    expectSeed();
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it("starts a fresh text draft after closing and reopening the workspace", () => {
    render(<Harness />);
    editText();
    fireEvent.click(screen.getByRole("button", { name: "Close workspace" }));
    expect(screen.queryByLabelText("Channel / format")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reopen workspace" }));
    expectSeed();
    expect(mocks.generate).not.toHaveBeenCalled();
  });
});
