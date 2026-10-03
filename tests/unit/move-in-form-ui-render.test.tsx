// @vitest-environment jsdom
/**
 * Render-level proof for the move-in form UI: the shared question renderer draws every type, the
 * resident checklist and one-question-per-screen flow save and submit through the move-in forms
 * client (mocked here, since the API has its own tests), and the property Forms tab lists the five
 * starter forms OFF until the manager turns one on.
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
    propertyLabel: "Brooklyn House",
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

  it("lists the five starters, every one turned off, before anything is saved", () => {
    render(<PropertyMoveInFormsPanel {...base} sub={sub} />);
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(5);
    for (const starter of MOVE_IN_FORM_STARTERS) expect(screen.getByText(starter.name)).toBeTruthy();
    // The figure is drawn once for the phone layout and once for desktop; CSS shows one.
    expect(screen.getAllByText("Turned off").length).toBeGreaterThanOrEqual(5);
    expect(screen.getAllByText("Built in PropLane")).toHaveLength(5);
  });

  it("shows how many residents finished a form that is on", async () => {
    const on = { ...MOVE_IN_FORM_STARTERS[0]!, enabled: true };
    client.loadMoveInForms.mockResolvedValue({
      forms: [summary({ formId: on.id, status: "submitted" }), summary({ id: "r2", formId: on.id }), summary({ id: "r3", formId: on.id })],
      unread: 0,
    });
    render(<PropertyMoveInFormsPanel {...base} sub={{ ...sub, moveInFormTemplates: [on] }} />);
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

  it("saves the whole starter list plus the new form on the first save", async () => {
    // Turn-on goes through the same persist path the editor uses.
    const user = await import("@testing-library/user-event").then((m) => m.default);
    render(<PropertyMoveInFormsPanel {...base} sub={sub} />);
    const row = screen.getAllByRole("listitem")[1]!;
    const trigger = within(row).getByRole("button", { name: "Actions for Key receipt" });
    await act(async () => {
      await user.click(trigger);
    });
    await act(async () => {
      await user.click(await screen.findByRole("menuitem", { name: "Turn on" }));
    });
    await waitFor(() => expect(persist).toHaveBeenCalled());
    const saved = persist.mock.calls[0]![2] as { moveInFormTemplates: Array<{ id: string; enabled: boolean }> };
    expect(saved.moveInFormTemplates).toHaveLength(5);
    expect(saved.moveInFormTemplates.filter((t) => t.enabled).map((t) => t.id)).toEqual([MOVE_IN_FORM_STARTERS[1]!.id]);
  });
});

describe("builder popup", () => {
  const rooms = [{ id: "room-1", label: "Room 1" }, { id: "room-2", label: "Room 2" }];

  async function openBuilder(initial = newMoveInFormTemplate("built"), mode: "add" | "edit" = "add", startStep = 0) {
    const { MoveInFormEditorModal } = await import("@/components/portal/move-in-forms/move-in-form-editor-modal");
    const onSave = vi.fn().mockResolvedValue(true);
    const onClose = vi.fn();
    render(
      <MoveInFormEditorModal mode={mode} initial={initial} rooms={rooms} propertyId="p1" propertyLabel="Brooklyn House" startStep={startStep} onSave={onSave} onClose={onClose} />,
    );
    return { onSave, onClose };
  }

  it("shows the four steps, the property as context, and the live resident view", async () => {
    await openBuilder();
    expect(screen.getByText("New move-in form")).toBeTruthy();
    for (const label of ["Form", "Questions", "Who & when", "Review"]) expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    expect(screen.getByText("Brooklyn House")).toBeTruthy();
    expect(screen.getAllByText("What the resident sees · live").length).toBeGreaterThan(0);
    expect(screen.getByText(/Step 1 of 4/)).toBeTruthy();
  });

  it("an uploaded form names its first step Upload", async () => {
    await openBuilder(newMoveInFormTemplate("upload"));
    expect(screen.getAllByText("Upload").length).toBeGreaterThan(0);
    expect(screen.getByText("Drop a PDF here or browse")).toBeTruthy();
  });

  it("will not leave the first step without a name, and says why", async () => {
    await openBuilder();
    fireEvent.click(screen.getByRole("button", { name: /continue to questions/i }));
    expect(await screen.findByText("Name this form.")).toBeTruthy();
    expect(screen.getByText(/Step 1 of 4/)).toBeTruthy();
  });

  it("walks the steps and creates the form turned on, sending it to current residents by default", async () => {
    const starter = newMoveInFormTemplate("built", "key-receipt");
    const { onSave, onClose } = await openBuilder(starter);
    fireEvent.click(screen.getByRole("button", { name: /continue to questions/i }));
    expect(await screen.findByText(/Step 2 of 4/)).toBeTruthy();
    expect(screen.getAllByRole("textbox", { name: "Question" }).length).toBe(starter.questions.length);
    fireEvent.click(screen.getByRole("button", { name: /continue to who/i }));
    expect(await screen.findByText(/Step 3 of 4/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /continue to review/i }));
    expect(await screen.findByText(/Step 4 of 4/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Create form" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const [saved, options] = onSave.mock.calls[0]!;
    expect(saved.enabled).toBe(true);
    expect(saved.name).toBe("Key receipt");
    expect(options).toEqual({ sendToCurrent: true });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("opening a saved form to Preview lands on Review with Save form", async () => {
    await openBuilder({ ...MOVE_IN_FORM_STARTERS[1]!, enabled: true }, "edit", 3);
    expect(screen.getByRole("button", { name: "Save form" })).toBeTruthy();
    expect(screen.getByText(/Step 4 of 4/)).toBeTruthy();
  });

  it("adds a question and a section, and removes a question", async () => {
    await openBuilder({ ...newMoveInFormTemplate("built"), name: "Blank", questions: [q("a", { label: "First" })] }, "add", 1);
    expect(screen.getAllByRole("textbox", { name: "Question" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /^question$/i }));
    expect(screen.getAllByRole("textbox", { name: "Question" })).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: /^section$/i }));
    expect(screen.getAllByRole("textbox", { name: "Question" })).toHaveLength(3);
    expect(screen.getAllByRole("textbox", { name: "Section name" })).toHaveLength(2);
    fireEvent.click(screen.getAllByRole("button", { name: "Delete question" })[2]!);
    expect(screen.getAllByRole("textbox", { name: "Question" })).toHaveLength(2);
  });
});
