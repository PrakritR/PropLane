// @vitest-environment jsdom
/**
 * Render-level proof for the move-in form UI: the shared question renderer draws every type, the
 * resident checklist and one-question-per-screen flow save and submit through the move-in forms
 * client (mocked here, since the API has its own tests), and the property Forms tab lists the three
 * pinned default forms (Intake, Move-in, Move-out) then the five starters as plain rows (no on/off
 * state), like the Applications list. The builder has three steps: Form, Questions, Who & when.
 */
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MoveInFormQuestionField } from "@/components/move-in-forms/move-in-form-question";
import { MoveInFormLivePreview } from "@/components/portal/move-in-forms/move-in-form-live-preview";
import { ResidentMoveInForms } from "@/components/portal/move-in-forms/resident-move-in-forms";
import { PropertyMoveInFormsPanel } from "@/components/portal/move-in-forms/property-move-in-forms-panel";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import { createPropertyApplicationTemplate } from "@/lib/property-application-templates";
import { defaultMoveInForm, MOVE_IN_FORM_STARTERS, newMoveInFormTemplate } from "@/lib/move-in-forms/templates";
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


const getUser = () => import("@testing-library/user-event").then((m) => m.default);

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
  const DEFAULT_NAMES = ["Intake form", "Move-in form", "Move-out form"];

  const rowOf = (name: string): HTMLElement => {
    const row = screen.getAllByRole("listitem").find((item) => within(item).queryByText(name));
    if (!row) throw new Error(`No row named ${name}`);
    return row;
  };
  async function openMenu(name: string) {
    const user = await getUser();
    await act(async () => {
      await user.click(within(rowOf(name)).getByRole("button", { name: `Actions for ${name}` }));
    });
  }

  it("lists the three default forms first, then the five starters, as plain rows: no Turned off, no greyed rows", () => {
    render(<PropertyMoveInFormsPanel {...base} sub={sub} />);
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(8);
    const expected = [...DEFAULT_NAMES, ...MOVE_IN_FORM_STARTERS.map((starter) => starter.name)];
    expected.forEach((name, index) => expect(within(rows[index]!).getByText(name)).toBeTruthy());
    expect(screen.queryByText("Turned off")).toBeNull();
    expect(screen.queryByText("0 sent")).toBeNull();
    for (const row of rows) expect(row.className).not.toMatch(/opacity-/);
    expect(screen.getAllByText("Built in PropLane")).toHaveLength(8);
  });

  it("each row names when the form is sent and what it is linked to", () => {
    render(<PropertyMoveInFormsPanel {...base} sub={sub} />);
    expect(within(rowOf("Intake form")).getByText("After application is submitted")).toBeTruthy();
    expect(within(rowOf("Move-in form")).getByText("After lease is signed")).toBeTruthy();
    expect(within(rowOf("Move-out form")).getByText("14 days before move-out")).toBeTruthy();
    expect(within(rowOf("Key receipt")).getByText("Sent by hand")).toBeTruthy();
    for (const row of screen.getAllByRole("listitem")) expect(within(row).getByText("All applications · All leases")).toBeTruthy();
  });

  it("a form linked to a property template names it in the Linked to fact", () => {
    const linked = { ...MOVE_IN_FORM_STARTERS[1]!, linkedApplicationTemplateIds: ["tplA"], linkedLeaseTemplateIds: ["l1", "l2"] };
    const withTemplates = {
      ...sub,
      moveInFormTemplates: [linked],
      propertyApplicationTemplates: [{ ...createPropertyApplicationTemplate({ kind: "standard", label: "Standard application" }), id: "tplA" }],
    } as unknown as typeof sub;
    render(<PropertyMoveInFormsPanel {...base} sub={withTemplates} />);
    expect(within(rowOf("Key receipt")).getByText(/Standard application · 2 leases/)).toBeTruthy();
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

  it("an empty stored list still shows the three default forms, so there is no empty state", () => {
    render(<PropertyMoveInFormsPanel {...base} sub={{ ...sub, moveInFormTemplates: [] }} />);
    expect(screen.queryByText("No move-in forms for this property")).toBeNull();
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    DEFAULT_NAMES.forEach((name, index) => expect(within(rows[index]!).getByText(name)).toBeTruthy());
  });

  it("the chooser offers build, upload and template, and a template opens the builder", async () => {
    render(<PropertyMoveInFormsPanel {...base} sub={sub} chooserOpen />);
    expect(await screen.findByText("Build a form")).toBeTruthy();
    expect(screen.getByText("Upload a PDF")).toBeTruthy();
    expect(screen.getByText("Start from a template")).toBeTruthy();
  });

  it("a starter row menu offers Edit, Duplicate and Delete, and no on/off switch or reset", async () => {
    render(<PropertyMoveInFormsPanel {...base} sub={sub} />);
    await openMenu("Key receipt");
    for (const name of ["Edit", "Duplicate", "Delete"]) expect(await screen.findByRole("menuitem", { name })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: /turn o(n|ff)/i })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Reset to default questions" })).toBeNull();
  });

  it("a default form's row menu has no Delete, and offers Reset to default questions instead", async () => {
    render(<PropertyMoveInFormsPanel {...base} sub={sub} />);
    for (const name of DEFAULT_NAMES) {
      cleanup();
      render(<PropertyMoveInFormsPanel {...base} sub={sub} />);
      await openMenu(name);
      for (const item of ["Edit", "Duplicate", "Reset to default questions"]) expect(await screen.findByRole("menuitem", { name: item })).toBeTruthy();
      expect(screen.queryByRole("menuitem", { name: "Delete" })).toBeNull();
    }
  });

  it("saves the whole list (defaults, starters) plus the copy on the first save, the copy sent only by hand", async () => {
    const user = await getUser();
    render(<PropertyMoveInFormsPanel {...base} sub={sub} />);
    await openMenu("Move-in checklist");
    await act(async () => {
      await user.click(await screen.findByRole("menuitem", { name: "Duplicate" }));
    });
    await waitFor(() => expect(persist).toHaveBeenCalled());
    const saved = persist.mock.calls[0]![2] as { moveInFormTemplates: Array<{ id: string; name: string; trigger: string; kind: string; enabled?: boolean }> };
    expect(saved.moveInFormTemplates).toHaveLength(9);
    expect(saved.moveInFormTemplates.slice(0, 3).map((t) => t.id)).toEqual(["default-intake", "default-move-in", "default-move-out"]);
    // The default forms keep their own Sends; every untouched starter (and the copy) is stored by-hand, so
    // saving one form never arms another to message residents.
    expect(saved.moveInFormTemplates.map((t) => t.trigger)).toEqual([
      "application-submitted", "lease-signed", "before-move-out",
      "manual", "manual", "manual", "manual", "manual", "manual",
    ]);
    expect(saved.moveInFormTemplates[4]!.name).toBe("Move-in checklist (copy)");
    expect(saved.moveInFormTemplates[4]!.kind).toBe("other");
    expect(saved.moveInFormTemplates.some((t) => "enabled" in t)).toBe(false);
  });

  it("Delete asks first, then removes just that form", async () => {
    const user = await getUser();
    const ask = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<PropertyMoveInFormsPanel {...base} sub={sub} />);
    await openMenu("Vehicle and parking");
    const deleteItem = await screen.findByRole("menuitem", { name: "Delete" });
    // Destructive menu items ignore a click in the first moments after the menu opens.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      await user.click(deleteItem);
    });
    await waitFor(() => expect(persist).toHaveBeenCalled());
    expect(ask).toHaveBeenCalledWith("Delete Vehicle and parking?");
    const saved = persist.mock.calls[0]![2] as { moveInFormTemplates: Array<{ id: string }> };
    expect(saved.moveInFormTemplates).toHaveLength(7);
    expect(saved.moveInFormTemplates.some((t) => t.id === "starter-vehicle-parking")).toBe(false);
    expect(saved.moveInFormTemplates.slice(0, 3).map((t) => t.id)).toEqual(["default-intake", "default-move-in", "default-move-out"]);
    ask.mockRestore();
  });

  it("declining the Delete confirm deletes nothing", async () => {
    const user = await getUser();
    const ask = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<PropertyMoveInFormsPanel {...base} sub={sub} />);
    await openMenu("Vehicle and parking");
    const deleteItem = await screen.findByRole("menuitem", { name: "Delete" });
    // Destructive menu items ignore a click in the first moments after the menu opens.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      await user.click(deleteItem);
    });
    expect(ask).toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    ask.mockRestore();
  });

  it("Reset to default questions restores the shipped questions and keeps the form's audience and links", async () => {
    const user = await getUser();
    const ask = vi.spyOn(window, "confirm").mockReturnValue(true);
    const edited = {
      ...defaultMoveInForm("intake"),
      questions: [q("mine", { label: "My own question" })],
      trigger: "manual" as const,
      audience: { kind: "whole-house" as const },
      linkedApplicationTemplateIds: ["tplA"],
    };
    render(<PropertyMoveInFormsPanel {...base} sub={{ ...sub, moveInFormTemplates: [edited] }} />);
    await openMenu("Intake form");
    await act(async () => {
      await user.click(await screen.findByRole("menuitem", { name: "Reset to default questions" }));
    });
    await waitFor(() => expect(persist).toHaveBeenCalled());
    const saved = persist.mock.calls[0]![2] as { moveInFormTemplates: MoveInFormTemplateLike[] };
    const intake = saved.moveInFormTemplates.find((t) => t.id === "default-intake")!;
    expect(intake.questions.map((item) => item.label)).toEqual(defaultMoveInForm("intake").questions.map((item) => item.label));
    expect(intake.trigger).toBe("application-submitted");
    expect(intake.audience).toEqual({ kind: "whole-house" });
    expect(intake.linkedApplicationTemplateIds).toEqual(["tplA"]);
    ask.mockRestore();
  });
});

type MoveInFormTemplateLike = {
  id: string;
  trigger: string;
  audience: unknown;
  linkedApplicationTemplateIds: string[];
  questions: Array<{ label: string }>;
};

describe("builder popup", () => {
  const rooms = [{ id: "room-1", label: "Room 1" }, { id: "room-2", label: "Room 2" }];
  const applicationTemplates = [{ id: "tplA", label: "Standard application" }, { id: "tplB", label: "Group application" }];
  const labels = () => Array.from(document.querySelectorAll<HTMLInputElement>('[data-attr="application-question-label"]')).map((input) => input.value);
  const optionNames = async () => (await screen.findAllByRole("option")).map((option) => (option.textContent ?? "").replace(/^✓/, "").trim());
  const attr = (name: string) => document.querySelector(`[data-attr="${name}"]`) as HTMLElement | null;

  async function openBuilder(
    initial = newMoveInFormTemplate("built"),
    mode: "add" | "edit" = "add",
    startStep = 0,
    onDelete?: () => Promise<boolean>,
    links: { applicationTemplates?: typeof applicationTemplates; leaseTemplates?: Array<{ id: string; label: string }> } = {},
  ) {
    const { MoveInFormEditorModal } = await import("@/components/portal/move-in-forms/move-in-form-editor-modal");
    const onSave = vi.fn().mockResolvedValue(true);
    const onClose = vi.fn();
    render(
      <MoveInFormEditorModal
        mode={mode}
        initial={initial}
        rooms={rooms}
        applicationTemplates={links.applicationTemplates}
        leaseTemplates={links.leaseTemplates}
        propertyId="p1"
        startStep={startStep}
        onSave={onSave}
        onDelete={onDelete}
        onClose={onClose}
      />,
    );
    return { onSave, onClose };
  }

  /** Opens a FieldSingleSelect by its data-attr and picks the option with this name. */
  async function pick(dataAttr: string, option: string) {
    const user = await getUser();
    await act(async () => {
      await user.click(attr(dataAttr) as HTMLElement);
    });
    await act(async () => {
      await user.click(await screen.findByRole("option", { name: option }));
    });
  }

  it("uses the application editor's frame: Add title, Form, Questions and Who & when steps, and the live resident view", async () => {
    await openBuilder();
    expect(screen.getAllByText("Add move-in form").length).toBeGreaterThan(0);
    for (const label of ["Form", "Questions", "Who & when"]) expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    expect(screen.queryByText("Review")).toBeNull();
    expect(screen.getAllByText("What the resident sees · live").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Not saved yet").length).toBeGreaterThan(0);
  });

  it("the Form step holds name and Start from only; Sends, Due and Who moved to Who & when", async () => {
    await openBuilder({ ...newMoveInFormTemplate("built"), name: "Rules" });
    expect(attr("move-in-form-name")).toBeTruthy();
    expect(attr("move-in-form-starts-from")).toBeTruthy();
    for (const name of ["move-in-form-trigger", "move-in-form-due", "move-in-form-audience"]) expect(attr(name)).toBeNull();
  });

  it("the Who & when step holds Sends, Due and Who, and Sends offers all five choices", async () => {
    const user = await getUser();
    await openBuilder({ ...newMoveInFormTemplate("built"), name: "Rules" }, "add", 2);
    for (const name of ["move-in-form-trigger", "move-in-form-due", "move-in-form-audience"]) expect(attr(name)).toBeTruthy();
    expect(attr("move-in-form-name")).toBeNull();
    await act(async () => {
      await user.click(attr("move-in-form-trigger") as HTMLElement);
    });
    expect(await optionNames()).toEqual([
      "After the application is submitted",
      "After the application is approved",
      "After the lease is signed",
      "Before move-out",
      "Only when I send it",
    ]);
  });

  it("an uploaded form offers the PDF drop on the Form step", async () => {
    await openBuilder(newMoveInFormTemplate("upload"));
    expect(screen.getByText("Drop a PDF here or browse")).toBeTruthy();
  });

  it("Start from can switch a new form to Upload a PDF", async () => {
    await openBuilder();
    expect(screen.queryByText("Drop a PDF here or browse")).toBeNull();
    await pick("move-in-form-starts-from", "Upload a PDF");
    expect(await screen.findByText("Drop a PDF here or browse")).toBeTruthy();
  });

  it("will not leave the first step without a name, and says why", async () => {
    await openBuilder();
    fireEvent.click(screen.getByRole("button", { name: /continue to questions/i }));
    expect((await screen.findAllByText(/Name this form|Required/)).length).toBeGreaterThan(0);
    expect(labels()).toEqual([]);
  });

  it("walks Form, Questions, then Who & when, and creates a by-hand starter without pushing it to residents", async () => {
    const starter = newMoveInFormTemplate("built", "key-receipt");
    const { onSave, onClose } = await openBuilder(starter);
    expect(screen.queryByText("Already-signed residents")).toBeNull();
    // Create is on the last step only.
    expect(screen.queryByRole("button", { name: "Create form" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /continue to questions/i }));
    for (const question of starter.questions) expect((await screen.findAllByText(question.label)).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Create form" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /continue to who & when/i }));
    expect(await screen.findByText("Sends")).toBeTruthy();
    expect(screen.queryByText("Already-signed residents")).toBeNull();
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
    // The choice lives on Who & when, not on the Form step.
    expect(screen.queryByText("Already-signed residents")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /continue to questions/i }));
    fireEvent.click(await screen.findByRole("button", { name: /continue to who & when/i }));
    expect(await screen.findByText("Already-signed residents")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Create form" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]![0].trigger).toBe("lease-signed");
    expect(onSave.mock.calls[0]![1]).toEqual({ sendToCurrent: true });
  });

  it("opening a saved form to Preview lands on Questions; Save is on the last step", async () => {
    await openBuilder(MOVE_IN_FORM_STARTERS[1]!, "edit", 1);
    expect(screen.getAllByText("Edit move-in form").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Saved").length).toBeGreaterThan(0);
    for (const question of MOVE_IN_FORM_STARTERS[1]!.questions) expect(screen.getAllByText(question.label).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /continue to who & when/i }));
    // Nothing changed yet, so Save is there but not armed.
    const save = await screen.findByRole("button", { name: "Save" });
    expect(save.hasAttribute("disabled") || save.getAttribute("aria-disabled") === "true").toBe(true);
  });

  it("edit shows a red Delete on the left; add does not", async () => {
    const onDelete = vi.fn().mockResolvedValue(true);
    await openBuilder(MOVE_IN_FORM_STARTERS[1]!, "edit", 0, onDelete);
    expect(attr("move-in-form-delete")).toBeTruthy();
    expect(attr("move-in-form-reset-default")).toBeNull();
    cleanup();
    await openBuilder(newMoveInFormTemplate("built"), "add", 0, onDelete);
    expect(attr("move-in-form-delete")).toBeNull();
  });

  it("a default form has no Delete even when one is offered; it offers Reset to default questions instead", async () => {
    const onDelete = vi.fn().mockResolvedValue(true);
    await openBuilder(defaultMoveInForm("move-in"), "edit", 0, onDelete);
    expect(attr("move-in-form-delete")).toBeNull();
    expect(screen.getByRole("button", { name: "Reset to default questions" })).toBeTruthy();
  });

  it("Reset to default questions in the editor restores the shipped questions", async () => {
    const ask = vi.spyOn(window, "confirm").mockReturnValue(true);
    const shipped = defaultMoveInForm("intake");
    await openBuilder({ ...shipped, questions: [q("mine", { label: "My own question" })] }, "edit", 1);
    expect(screen.getAllByText("My own question").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Reset to default questions" }));
    expect((await screen.findAllByText(shipped.questions[0]!.label)).length).toBeGreaterThan(0);
    expect(screen.queryByText("My own question")).toBeNull();
    ask.mockRestore();
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

  describe("Who & when", () => {
    it("editing a default form's Sends and linked application saves them on that template id", async () => {
      const user = await getUser();
      const { onSave } = await openBuilder(defaultMoveInForm("intake"), "edit", 2, undefined, { applicationTemplates });
      expect(screen.getByText("Linked application")).toBeTruthy();
      await pick("move-in-form-trigger", "After the application is approved");
      await act(async () => {
        await user.click(attr("move-in-form-linked-applications") as HTMLElement);
      });
      await act(async () => {
        await user.click(await screen.findByRole("option", { name: "Standard application" }));
      });
      fireEvent.click(await screen.findByRole("button", { name: "Save" }));
      await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
      const [saved, options] = onSave.mock.calls[0]!;
      expect(saved.id).toBe("default-intake");
      expect(saved.kind).toBe("intake");
      expect(saved.trigger).toBe("application-approved");
      expect(saved.linkedApplicationTemplateIds).toEqual(["tplA"]);
      expect(saved.linkedLeaseTemplateIds).toEqual([]);
      // An edit never re-sends to people who already have it.
      expect(options).toEqual({ sendToCurrent: false });
    });

    it("the link rows only render when the property has such templates", async () => {
      await openBuilder(defaultMoveInForm("move-in"), "edit", 2);
      expect(screen.queryByText("Linked application")).toBeNull();
      expect(screen.queryByText("Linked lease")).toBeNull();
      cleanup();
      await openBuilder(defaultMoveInForm("move-in"), "edit", 2, undefined, {
        applicationTemplates,
        leaseTemplates: [{ id: "lease1", label: "Standard lease" }],
      });
      expect(screen.getByText("Linked application")).toBeTruthy();
      expect(screen.getByText("Linked lease")).toBeTruthy();
    });

    it("Before move-out shows 'Days before the lease ends' and hides 'Already-signed residents'", async () => {
      await openBuilder(defaultMoveInForm("move-out"), "edit", 2);
      expect(screen.getByText("Days before the lease ends")).toBeTruthy();
      expect(attr("move-in-form-move-out-days")).toBeTruthy();
      expect(screen.queryByText("Already-signed residents")).toBeNull();
    });

    it("the days select is hidden for the other sends, and 'Already-signed residents' shows for the two that residents are past", async () => {
      for (const [trigger, signed] of [
        ["application-submitted", false],
        ["application-approved", true],
        ["lease-signed", true],
        ["manual", false],
      ] as const) {
        cleanup();
        await openBuilder({ ...newMoveInFormTemplate("built", "key-receipt"), trigger }, "add", 2);
        expect(screen.queryByText("Days before the lease ends")).toBeNull();
        expect(Boolean(screen.queryByText("Already-signed residents"))).toBe(signed);
      }
    });

    it("switching Sends to Before move-out reveals the days select, and the chosen days are saved", async () => {
      const { onSave } = await openBuilder({ ...newMoveInFormTemplate("built", "key-receipt"), name: "Departure" }, "add", 2);
      expect(screen.queryByText("Days before the lease ends")).toBeNull();
      await pick("move-in-form-trigger", "Before move-out");
      expect(screen.getByText("Days before the lease ends")).toBeTruthy();
      await pick("move-in-form-move-out-days", "30 days");
      fireEvent.click(await screen.findByRole("button", { name: "Create form" }));
      await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
      const [saved, options] = onSave.mock.calls[0]!;
      expect(saved.trigger).toBe("before-move-out");
      expect(saved.moveOutDaysBefore).toBe(30);
      expect(options).toEqual({ sendToCurrent: false });
    });

    it("Due offers move-out dates only for a move-out send", async () => {
      const user = await getUser();
      await openBuilder({ ...defaultMoveInForm("move-out") }, "edit", 2);
      await act(async () => {
        await user.click(attr("move-in-form-due") as HTMLElement);
      });
      const out = await optionNames();
      expect(out).toContain("On move-out day");
      expect(out).not.toContain("The day before move-in");
      cleanup();
      await openBuilder({ ...defaultMoveInForm("move-in") }, "edit", 2);
      await act(async () => {
        await user.click(attr("move-in-form-due") as HTMLElement);
      });
      const inn = await optionNames();
      expect(inn).toContain("The day before move-in");
      expect(inn).not.toContain("On move-out day");
    });

    it("picking some rooms with none chosen blocks Create and says why on this step", async () => {
      const { onSave } = await openBuilder({ ...newMoveInFormTemplate("built", "key-receipt") }, "add", 2);
      await pick("move-in-form-audience", "Some rooms");
      fireEvent.click(await screen.findByRole("button", { name: "Create form" }));
      expect(await screen.findByText("Pick at least one room.")).toBeTruthy();
      expect(onSave).not.toHaveBeenCalled();
    });
  });
});
