// @vitest-environment jsdom
import { useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EMPTY_DRAFT, type PromotionDraft } from "@/components/portal/promotion-form";

const mocks = vi.hoisted(() => ({ confirm: vi.fn() }));

vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => mocks.confirm,
}));

vi.mock("@/components/portal/add-workspace", () => ({
  AddWorkspace: ({ children, onJump, onClose, dirty }: { children: ReactNode; onJump: (index: number) => void; onClose: () => void; dirty?: boolean }) => (
    <div>
      <output data-testid="dirty">{String(Boolean(dirty))}</output>
      <button type="button" data-testid="go-kind" onClick={() => onJump(0)}>Kind</button>
      <button type="button" data-testid="close" onClick={onClose}>Close</button>
      {children}
    </div>
  ),
}));

vi.mock("@/components/portal/add-workspace/parts", () => ({
  PreviewPanel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  StepColumn: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  StepHeading: ({ title }: { title: string }) => <h2>{title}</h2>,
  WizardSelect: ({ label, value, options, onChange }: { label: string; value: string; options: { value: string; label: string }[]; onChange: (value: string) => void }) => (
    <div>
      <span>{label}</span>
      {options.map((option) => (
        <button key={option.value} type="button" aria-pressed={option.value === value} data-attr={`kind-${option.value}`} onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  ),
}));

vi.mock("@/components/portal/promotion-form", async () => {
  const actual = await vi.importActual<typeof import("@/components/portal/promotion-form")>("@/components/portal/promotion-form");
  return {
    ...actual,
    PromotionForm: ({ setDraft }: { setDraft: Dispatch<SetStateAction<PromotionDraft>> }) => (
      <button type="button" data-attr="edit-flyer" onClick={() => setDraft((previous) => ({ ...previous, title: "Edited flyer" }))}>
        Edit flyer
      </button>
    ),
  };
});

vi.mock("@/components/portal/promotion-text-generate-modal", () => ({
  PromotionTextComposer: ({ onDirtyChange }: { onDirtyChange: (dirty: boolean) => void }) => (
    <button type="button" data-attr="edit-text" onClick={() => onDirtyChange(true)}>Edit text</button>
  ),
}));

vi.mock("@/components/portal/promotion-upload-composer", () => ({ PromotionUploadComposer: () => null }));
vi.mock("@/components/portal/listing-wizard-v2/wizard-primitives", () => ({
  StepColumn: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  StepHeading: ({ title }: { title: string }) => <h2>{title}</h2>,
}));

import { PromotionNewModal } from "@/components/portal/promotion-new-modal";

afterEach(() => {
  cleanup();
  mocks.confirm.mockReset();
});

function Harness({ initialKind = "flyer", flyerBusy = false }: { initialKind?: "flyer" | "text"; flyerBusy?: boolean }) {
  const [draft, setDraft] = useState<PromotionDraft>(EMPTY_DRAFT);
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button" data-testid="reseed" onClick={() => setDraft({ ...EMPTY_DRAFT, propertyKey: "house-2", title: "Reseeded" })}>Reseed</button>
      <button type="button" data-testid="reopen" onClick={() => setOpen((value) => !value)}>Reopen</button>
      <output data-testid="draft-title">{draft.title}</output>
      <PromotionNewModal
        open={open}
        onClose={() => setOpen(false)}
        initialKind={initialKind}
        initialStepId="content"
        draft={draft}
        setDraft={setDraft}
        listings={[]}
        onSelectProperty={() => {}}
        onGenerateFlyer={() => {}}
        flyerBusy={flyerBusy}
        onGenerateText={() => {}}
      />
    </>
  );
}

describe("PromotionNewModal discard warnings", () => {
  it("warns for flyer edits and resets the abandoned flyer after confirming a switch", async () => {
    mocks.confirm.mockResolvedValue(true);
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Edit flyer" }));
    expect(screen.getByTestId("dirty").textContent).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Kind" }));
    fireEvent.click(screen.getByRole("button", { name: "Text" }));
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole("button", { name: "Text" }).getAttribute("aria-pressed")).toBe("true"));
    expect(screen.getByTestId("draft-title").textContent).toBe("");
    expect(screen.getByTestId("dirty").textContent).toBe("false");
  });

  it("warns when text content is edited", async () => {
    mocks.confirm.mockResolvedValue(false);
    render(<Harness initialKind="text" />);
    fireEvent.click(screen.getByRole("button", { name: "Edit text" }));
    expect(screen.getByTestId("dirty").textContent).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Kind" }));
    fireEvent.click(screen.getByRole("button", { name: "Flyer" }));
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Text" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("dirty").textContent).toBe("true");
  });

  it("does not warn after a clean property reseed or reopen", async () => {
    mocks.confirm.mockResolvedValue(true);
    render(<Harness />);
    fireEvent.click(screen.getByTestId("reseed"));
    await waitFor(() => expect(screen.getByTestId("draft-title").textContent).toBe("Reseeded"));
    expect(screen.getByTestId("dirty").textContent).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Kind" }));
    fireEvent.click(screen.getByRole("button", { name: "Text" }));
    expect(mocks.confirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("reopen"));
    fireEvent.click(screen.getByTestId("reopen"));
    expect(screen.getByTestId("dirty").textContent).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Kind" }));
    fireEvent.click(screen.getByRole("button", { name: "Text" }));
    expect(mocks.confirm).not.toHaveBeenCalled();
  });

  it("blocks a type switch while the flyer is busy", () => {
    render(<Harness flyerBusy />);
    fireEvent.click(screen.getByRole("button", { name: "Kind" }));
    fireEvent.click(screen.getByRole("button", { name: "Text" }));
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(screen.getByTestId("dirty").textContent).toBe("false");
    expect(screen.getByRole("button", { name: "Flyer" }).getAttribute("aria-pressed")).toBe("true");
  });
});
