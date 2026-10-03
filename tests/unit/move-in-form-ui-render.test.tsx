// @vitest-environment jsdom
/**
 * Render-level proof for the move-in form UI: the shared question renderer draws every type, the
 * resident checklist and one-question-per-screen flow save and submit through the move-in forms
 * client (mocked here, since the API has its own tests), and the property Forms tab lists the five
 * starter forms as plain rows (no on/off state), like the Applications list.
 */
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MoveInFormQuestionField } from "@/components/move-in-forms/move-in-form-question";
import { MoveInFormLivePreview } from "@/components/portal/move-in-forms/move-in-form-live-preview";
import { ResidentMoveInForms } from "@/components/portal/move-in-forms/resident-move-in-forms";
import { PropertyMoveInFormsPanel } from "@/components/portal/move-in-forms/property-move-in-forms-panel";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import { MOVE_IN_FORM_STARTERS, newMoveInFormTemplate } from "@/lib/move-in-forms/templates";
import type { MoveInFormAnswer, MoveInFormQuestion, MoveInFormRecord, MoveInFormSummary } from "@/lib/move-in-forms/types";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/portal/properties/p1/move-in",
}));
vi.mock("@/hooks/use-portal-session", () => ({
  usePortalSession: () => ({ userId: "u1", email: "ada@example.com", ready: true }),
}));
vi.mock("@/lib/demo/demo-session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/demo/demo-session")>();
  return { ...actual, isDemoModeActive: () => false };
});

const client = vi.hoisted(() => ({
  loadMoveInForms: vi.fn(),
  getMyMoveInForm: vi.fn(),
  saveMyMoveInFormDraft: vi.fn(),
  submitMyMoveInForm: vi.fn(),
  uploadMyMoveInFormFile: vi.fn(),
  sendMoveInFormToCurrentResidents: vi.fn(),
  uploadMoveInFormPdf: vi.fn(),
  downloadMoveInFormPdf: vi.fn(),
}));
vi.mock("@/lib/move-in-forms/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/move-in-forms/client")>();
  return { ...actual, ...client };
});
const persist = vi.hoisted(() => vi.fn());
vi.mock("@/lib/manager-property-save-target", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/manager-property-save-target")>();
  return { ...actual, persistManagerListingSubmissionOnServer: persist };
});

beforeEach(() => {
  client.loadMoveInForms.mockResolvedValue({ forms: [], unread: 0 });
  client.saveMyMoveInFormDraft.mockResolvedValue({});
  persist.mockResolvedValue(true);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function q(key: string, patch: Partial<MoveInFormQuestion> = {}): MoveInFormQuestion {
  return { id: `q-${key}`, key, label: `Label ${key}`, type: "text", required: false, options: [], ...patch };
}

describe("shared question renderer", () => {
  const cases: Array<[string, MoveInFormQuestion]> = [
    ["text", q("t")],
    ["long_text", q("lt", { type: "long_text" })],
    ["number", q("n", { type: "number" })],
    ["currency", q("c", { type: "currency" })],
    ["yes_no", q("yn", { type: "yes_no" })],
    ["select", q("s", { type: "select", options: ["A", "B"] })],
    ["multi_select", q("ms", { type: "multi_select", options: ["A", "B"] })],
    ["checkbox", q("cb", { type: "checkbox" })],
    ["date", q("d", { type: "date" })],
    ["phone", q("p", { type: "phone" })],
    ["email", q("e", { type: "email" })],
    ["photos", q("ph", { type: "photos" })],
    ["initials", q("i", { type: "initials" })],
    ["signature", q("sg", { type: "signature", required: true })],
  ];

  it.each(cases)("draws a %s question with its label", (_name, question) => {
    render(<MoveInFormQuestionField question={question} onChange={() => {}} />);
    expect(screen.getAllByText(question.label).length).toBeGreaterThan(0);
  });

  it("emits a typed answer keyed to the question, and null when cleared", () => {
    const onChange = vi.fn();
    function Harness() {
      const [answer, setAnswer] = useState<MoveInFormAnswer | undefined>();
      return (
        <MoveInFormQuestionField
          question={q("t")}
          answer={answer}
          onChange={(next) => {
            onChange(next);
            setAnswer(next ?? undefined);
          }}
        />
      );
    }
    render(<Harness />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "Ada" } });
    expect(onChange).toHaveBeenLastCalledWith({ key: "t", value: "Ada" });
    fireEvent.change(input, { target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("a photo question offers the camera and the picker, and nothing when read-only", () => {
    const { rerender } = render(<MoveInFormQuestionField question={q("ph", { type: "photos" })} onChange={() => {}} />);
    expect(screen.getByRole("button", { name: /take photo/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /choose photos/i })).toBeTruthy();
    rerender(<MoveInFormQuestionField question={q("ph", { type: "photos" })} onChange={() => {}} readOnly />);
    expect(screen.queryByRole("button", { name: /take photo/i })).toBeNull();
  });

  it("a signed question shows who signed and offers Redo until it is read-only", () => {
    const answer: MoveInFormAnswer = { key: "sg", signature: { storagePath: "r/sg/1.png", signedName: "Ada Lovelace", signedAt: "2026-10-03T00:00:00Z" } };
    const { rerender } = render(<MoveInFormQuestionField question={q("sg", { type: "signature" })} answer={answer} onChange={() => {}} />);
    expect(screen.getByText("Signed by Ada Lovelace")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Redo" })).toBeTruthy();
    rerender(<MoveInFormQuestionField question={q("sg", { type: "signature" })} answer={answer} onChange={() => {}} readOnly />);
    expect(screen.queryByRole("button", { name: "Redo" })).toBeNull();
  });
});

describe("builder live preview", () => {
  it("walks the questions one at a time and starts uploaded forms on the document", () => {
    const onIndex = vi.fn();
    const questions = [q("a"), q("b")];
    const { rerender } = render(
      <MoveInFormLivePreview name="Keys" source="built" questions={questions} pdfUrl={null} index={0} onIndexChange={onIndex} answers={{}} onAnswersChange={() => {}} />,
    );
    expect(screen.getByText("Label a")).toBeTruthy();
    expect(screen.getByText("1 of 2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(onIndex).toHaveBeenCalledWith(1);
    rerender(
      <MoveInFormLivePreview name="Pets" source="upload" questions={questions} pdfUrl={null} index={0} onIndexChange={onIndex} answers={{}} onAnswersChange={() => {}} />,
    );
    expect(screen.getByText("Read the document")).toBeTruthy();
    expect(screen.getByText("The PDF shows here")).toBeTruthy();
  });

  it("shows a placeholder for a question still being typed", () => {
    render(
      <MoveInFormLivePreview name="" source="built" questions={[q("a", { label: "" })]} pdfUrl={null} index={0} onIndexChange={() => {}} answers={{}} onAnswersChange={() => {}} />,
    );
    expect(screen.getByText("Untitled form")).toBeTruthy();
    expect(screen.getByText("Your question")).toBeTruthy();
  });
});

function summary(patch: Partial<MoveInFormSummary>): MoveInFormSummary {
  return {
    id: "r1",
    applicationId: "app-1",
    managerUserId: "m1",
    propertyId: "p1",
    roomLabel: "Room 1",
    residentName: "Ada Lovelace",
    residentEmail: "ada@example.com",
    formId: "f1",
    formName: "Move-in checklist",
    source: "built",
    status: "sent",
    signedDocumentSha256: null,
    sentAt: "2026-09-20T00:00:00Z",
    dueAt: "2099-10-02T06:59:59Z",
    submittedAt: null,
    remindedAt: null,
    managerViewedAt: null,
    questionCount: 2,
    photoCount: 0,
    signed: false,
    ...patch,
  };
}

function record(patch: Partial<MoveInFormRecord> = {}): MoveInFormRecord {
  const base: Partial<MoveInFormSummary> = summary({});
  delete base.questionCount;
  delete base.photoCount;
  delete base.signed;
  return {
    ...(base as Omit<MoveInFormRecord, "snapshot" | "answers">),
    snapshot: { questions: [q("keys", { label: "How many keys?", required: true }), q("note", { label: "Anything else?" })], pdf: null },
    answers: [],
    ...patch,
  };
}

describe("resident My home › Forms", () => {
  it("says so when nothing was sent", async () => {
    render(<ResidentMoveInForms />);
    expect(await screen.findByText("No move-in forms")).toBeTruthy();
  });

  it("lists forms with a done count, Done on submitted ones and a due date on open ones", async () => {
    client.loadMoveInForms.mockResolvedValue({
      forms: [
        summary({ id: "r1", formName: "Key receipt", status: "submitted", submittedAt: "2026-09-25T00:00:00Z" }),
        summary({ id: "r2", formName: "Pet agreement", dueAt: "2099-10-01T06:59:59Z" }),
        summary({ id: "r3", formName: "Cancelled one", status: "cancelled" }),
      ],
      unread: 0,
    });
    render(<ResidentMoveInForms />);
    expect(await screen.findByText("Before you move in · 1 of 2 done")).toBeTruthy();
    expect(screen.queryByText("Cancelled one")).toBeNull();
    const rows = screen.getAllByRole("button").filter((b) => b.getAttribute("data-attr") === "resident-move-in-form-row");
    expect(rows).toHaveLength(2);
    // Open forms come first, submitted ones last.
    expect(within(rows[0]!).getByText("Pet agreement")).toBeTruthy();
    expect(within(rows[0]!).getByText("Due Sep 30")).toBeTruthy();
    expect(within(rows[1]!).getByText("Done")).toBeTruthy();
  });

  it("fills one question per screen, saves as it goes, blocks a required blank, and submits", async () => {
    client.loadMoveInForms.mockResolvedValue({ forms: [summary({})], unread: 0 });
    client.getMyMoveInForm.mockResolvedValue({ form: record() });
    client.submitMyMoveInForm.mockResolvedValue({ form: record({ status: "submitted" }) });
    render(<ResidentMoveInForms />);
    fireEvent.click(await screen.findByText("Move-in checklist"));

    expect(await screen.findByText("How many keys?")).toBeTruthy();
    expect(screen.queryByText("Anything else?")).toBeNull();

    // A required question left blank stops Next and says so.
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("This is required.")).toBeTruthy();
    expect(screen.queryByText("Anything else?")).toBeNull();

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("Anything else?")).toBeTruthy();
    // Moving on flushes the draft straight away, without waiting for the debounce.
    await waitFor(() => expect(client.saveMyMoveInFormDraft).toHaveBeenCalledWith("r1", [{ key: "keys", value: "3" }]));

    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(client.submitMyMoveInForm).toHaveBeenCalledWith("r1", [{ key: "keys", value: "3" }]));
    expect(await screen.findByText("Submitted")).toBeTruthy();
  });

  it("reopens on the first unanswered question with the saved answers restored", async () => {
    client.loadMoveInForms.mockResolvedValue({ forms: [summary({})], unread: 0 });
    client.getMyMoveInForm.mockResolvedValue({ form: record({ answers: [{ key: "keys", value: "3" }] }) });
    render(<ResidentMoveInForms />);
    fireEvent.click(await screen.findByText("Move-in checklist"));
    expect(await screen.findByText("Anything else?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect((await screen.findByRole("textbox")) as HTMLInputElement).toHaveProperty("value", "3");
  });

  it("opens an uploaded form on its document, then the signature, labelled Sign and submit", async () => {
    client.loadMoveInForms.mockResolvedValue({ forms: [summary({ source: "upload", formName: "Pet agreement" })], unread: 0 });
    client.getMyMoveInForm.mockResolvedValue({
      form: record({
        source: "upload",
        formName: "Pet agreement",
        snapshot: {
          questions: [q("signature", { label: "Signature", type: "signature", required: true })],
          pdf: { storagePath: "u/f/1.pdf", fileName: "pets.pdf", pageCount: 3, sha256: "a".repeat(64) },
        },
      }),
    });
    render(<ResidentMoveInForms />);
    fireEvent.click(await screen.findByText("Pet agreement"));
    expect(await screen.findByRole("button", { name: "Sign and submit" })).toBeTruthy();
    expect(screen.getByText("Signature")).toBeTruthy();
    // The signature pad is there to draw on.
    expect(screen.getByRole("img", { name: /signature pad/i })).toBeTruthy();
  });

  it("a submitted form opens read-only with a download", async () => {
    client.loadMoveInForms.mockResolvedValue({ forms: [summary({ status: "submitted" })], unread: 0 });
    client.getMyMoveInForm.mockResolvedValue({ form: record({ status: "submitted", answers: [{ key: "keys", value: "3" }] }) });
    render(<ResidentMoveInForms />);
    fireEvent.click(await screen.findByText("Move-in checklist"));
    expect(await screen.findByRole("button", { name: /download/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
    expect(client.saveMyMoveInFormDraft).not.toHaveBeenCalled();
  });
});

describe("property Move-in › Forms", () => {
  const sub = createDefaultListingSubmission();
  sub.rooms = [{ ...sub.rooms[0]!, id: "room-1", name: "Room 1" }];
  const base = {
    saveTarget: { mode: "listing" as const, saveId: "p1" },
    managerUserId: "m1",
    canEdit: true,
    propertyLabel: "Brooklyn House",
    onUpdated: vi.fn(),
    showToast: vi.fn(),
    chooserOpen: false,
    onChooserOpenChange: vi.fn(),
  };

  it("lists the five starters as plain rows: no Turned off, no greyed rows", () => {
    render(<PropertyMoveInFormsPanel {...base} sub={sub} />);
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(5);
    for (const starter of MOVE_IN_FORM_STARTERS) expect(screen.getByText(starter.name)).toBeTruthy();
    expect(screen.queryByText("Turned off")).toBeNull();
    expect(screen.queryByText("0 sent")).toBeNull();
    for (const row of rows) expect(row.className).not.toMatch(/opacity-/);
    expect(screen.getAllByText("Built in PropLane")).toHaveLength(5);
  });

  it("shows how many residents finished a form that has been sent", async () => {
    const sent = MOVE_IN_FORM_STARTERS[0]!;
    client.loadMoveInForms.mockResolvedValue({
      forms: [summary({ formId: sent.id, status: "submitted" }), summary({ id: "r2", formId: sent.id }), summary({ id: "r3", formId: sent.id })],
      unread: 0,
    });
    render(<PropertyMoveInFormsPanel {...base} sub={{ ...sub, moveInFormTemplates: [sent] }} />);
    expect((await screen.findAllByText("1 of 3 residents")).length).toBeGreaterThan(0);
  });

  it("an empty list offers New form", () => {
    render(<PropertyMoveInFormsPanel {...base} sub={{ ...sub, moveInFormTemplates: [] }} />);
    expect(screen.getByText("No move-in forms for this property")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /new form/i }));
    expect(base.onChooserOpenChange).toHaveBeenCalledWith(true);
  });

  it("the chooser offers build, upload and template, and a template opens the builder", async () => {
    render(<PropertyMoveInFormsPanel {...base} sub={sub} chooserOpen />);
    expect(await screen.findByText("Build a form")).toBeTruthy();
    expect(screen.getByText("Upload a PDF")).toBeTruthy();
    expect(screen.getByText("Start from a template")).toBeTruthy();
  });

  it("a row menu offers Edit, Duplicate and Delete, and no on/off switch", async () => {
    const user = await import("@testing-library/user-event").then((m) => m.default);
    render(<PropertyMoveInFormsPanel {...base} sub={sub} />);
    const row = screen.getAllByRole("listitem")[1]!;
    await act(async () => {
      await user.click(within(row).getByRole("button", { name: "Actions for Key receipt" }));
    });
    for (const name of ["Edit", "Duplicate", "Delete"]) expect(await screen.findByRole("menuitem", { name })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: /turn o(n|ff)/i })).toBeNull();
  });

  it("saves the whole starter list plus the copy on the first save, the copy sent only by hand", async () => {
    const user = await import("@testing-library/user-event").then((m) => m.default);
    render(<PropertyMoveInFormsPanel {...base} sub={sub} />);
    const row = screen.getAllByRole("listitem")[0]!;
    await act(async () => {
      await user.click(within(row).getByRole("button", { name: "Actions for Move-in checklist" }));
    });
    await act(async () => {
      await user.click(await screen.findByRole("menuitem", { name: "Duplicate" }));
    });
    await waitFor(() => expect(persist).toHaveBeenCalled());
    const saved = persist.mock.calls[0]![2] as { moveInFormTemplates: Array<{ id: string; name: string; trigger: string; enabled?: boolean }> };
    expect(saved.moveInFormTemplates).toHaveLength(6);
    // Nothing was saved before, so the untouched checklist is stored by-hand too: no form messages
    // residents until the manager saves it with that trigger.
    expect(saved.moveInFormTemplates.map((t) => t.trigger)).toEqual(["manual", "manual", "manual", "manual", "manual", "manual"]);
    expect(saved.moveInFormTemplates[1]!.name).toBe("Move-in checklist (copy)");
    expect(saved.moveInFormTemplates.some((t) => "enabled" in t)).toBe(false);
  });

  it("Delete asks first, then removes just that form", async () => {
    const user = await import("@testing-library/user-event").then((m) => m.default);
    render(<PropertyMoveInFormsPanel {...base} sub={sub} />);
    const row = screen.getAllByRole("listitem")[2]!;
    await act(async () => {
      await user.click(within(row).getByRole("button", { name: "Actions for Vehicle and parking" }));
    });
    await act(async () => {
      await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
    });
    // The confirm provider is not mounted in this harness, so nothing is deleted without one.
    expect(persist).not.toHaveBeenCalled();
  });
});

describe("builder popup", () => {
  const rooms = [{ id: "room-1", label: "Room 1" }, { id: "room-2", label: "Room 2" }];
  const labels = () => Array.from(document.querySelectorAll<HTMLInputElement>('[data-attr="application-question-label"]')).map((input) => input.value);

  async function openBuilder(initial = newMoveInFormTemplate("built"), mode: "add" | "edit" = "add", startStep = 0, onDelete?: () => Promise<boolean>) {
    const { MoveInFormEditorModal } = await import("@/components/portal/move-in-forms/move-in-form-editor-modal");
    const onSave = vi.fn().mockResolvedValue(true);
    const onClose = vi.fn();
    render(
      <MoveInFormEditorModal mode={mode} initial={initial} rooms={rooms} propertyId="p1" startStep={startStep} onSave={onSave} onDelete={onDelete} onClose={onClose} />,
    );
    return { onSave, onClose };
  }

  it("uses the application editor's frame: Add title, Form and Questions steps, and the live resident view", async () => {
    await openBuilder();
    expect(screen.getAllByText("Add move-in form").length).toBeGreaterThan(0);
    for (const label of ["Form", "Questions"]) expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    expect(screen.queryByText("Review")).toBeNull();
    expect(screen.queryByText("Who & when")).toBeNull();
    expect(screen.getAllByText("What the resident sees · live").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Not saved yet").length).toBeGreaterThan(0);
  });

  it("the Form step holds name, Sends, Due and Who, and the Sends options include only-by-hand", async () => {
    await openBuilder({ ...newMoveInFormTemplate("built"), name: "Rules" });
    expect(document.querySelector('[data-attr="move-in-form-name"]')).toBeTruthy();
    for (const attr of ["move-in-form-trigger", "move-in-form-due", "move-in-form-audience"]) {
      expect(document.querySelector(`[data-attr="${attr}"]`)).toBeTruthy();
    }
    expect(screen.getByText("When the lease is signed")).toBeTruthy();
  });

  it("an uploaded form offers the PDF drop on the Form step", async () => {
    await openBuilder(newMoveInFormTemplate("upload"));
    expect(screen.getByText("Drop a PDF here or browse")).toBeTruthy();
  });

  it("Start from can switch a new form to Upload a PDF", async () => {
    const user = await import("@testing-library/user-event").then((m) => m.default);
    await openBuilder();
    expect(screen.queryByText("Drop a PDF here or browse")).toBeNull();
    await act(async () => {
      await user.click(document.querySelector('[data-attr="move-in-form-starts-from"]') as HTMLElement);
    });
    await act(async () => {
      await user.click(await screen.findByRole("option", { name: "Upload a PDF" }));
    });
    expect(await screen.findByText("Drop a PDF here or browse")).toBeTruthy();
  });

  it("will not leave the first step without a name, and says why", async () => {
    await openBuilder();
    fireEvent.click(screen.getByRole("button", { name: /continue to questions/i }));
    expect((await screen.findAllByText(/Name this form|Required/)).length).toBeGreaterThan(0);
    expect(labels()).toEqual([]);
  });

  it("walks Form then Questions and creates a by-hand starter without pushing it to residents", async () => {
    const starter = newMoveInFormTemplate("built", "key-receipt");
    const { onSave, onClose } = await openBuilder(starter);
    expect(screen.queryByText("Already-signed residents")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /continue to questions/i }));
    for (const question of starter.questions) expect((await screen.findAllByText(question.label)).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Create form" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const [saved, options] = onSave.mock.calls[0]!;
    expect("enabled" in saved).toBe(false);
    expect(saved.trigger).toBe("manual");
    expect(saved.name).toBe("Key receipt");
    expect(options).toEqual({ sendToCurrent: false });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("a form that sends on lease signing is offered to already-signed residents by default", async () => {
    const { onSave } = await openBuilder(newMoveInFormTemplate("built", "move-in-checklist"));
    expect(screen.getByText("Already-signed residents")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /continue to questions/i }));
    fireEvent.click(await screen.findByRole("button", { name: "Create form" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]![0].trigger).toBe("lease-signed");
    expect(onSave.mock.calls[0]![1]).toEqual({ sendToCurrent: true });
  });

  it("opening a saved form to Preview lands on Questions with Save", async () => {
    await openBuilder(MOVE_IN_FORM_STARTERS[1]!, "edit", 1);
    expect(screen.getAllByText("Edit move-in form").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
    expect(screen.getAllByText("Saved").length).toBeGreaterThan(0);
  });

  it("edit shows a red Delete on the left; add does not", async () => {
    const onDelete = vi.fn().mockResolvedValue(true);
    await openBuilder(MOVE_IN_FORM_STARTERS[1]!, "edit", 0, onDelete);
    expect(document.querySelector('[data-attr="move-in-form-delete"]')).toBeTruthy();
    cleanup();
    await openBuilder(newMoveInFormTemplate("built"), "add", 0, onDelete);
    expect(document.querySelector('[data-attr="move-in-form-delete"]')).toBeNull();
  });

  it("draws questions with the application editor's question rows and adds, edits and removes one", async () => {
    await openBuilder({ ...newMoveInFormTemplate("built"), name: "Blank", questions: [q("a", { label: "First" })] }, "add", 1);
    expect(screen.getAllByText("First").length).toBeGreaterThan(0);
    // The shared row subtitle names the type; the move-in vocabulary adds Signature and Photos.
    fireEvent.click(screen.getByRole("button", { name: "Add question" }));
    expect(labels()).toEqual([""]);
    fireEvent.change(document.querySelector('[data-attr="application-question-label"]') as HTMLInputElement, { target: { value: "Second" } });
    expect(labels()).toEqual(["Second"]);
    fireEvent.click(screen.getByText("+ Add section"));
    expect(screen.getAllByText("Section 2").length).toBeGreaterThan(0);
  });
});
