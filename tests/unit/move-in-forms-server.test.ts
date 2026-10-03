import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentContext } from "@/lib/tools/context";
import type { ResidentAgentContext } from "@/lib/tools/resident-context";
import type { MoveInFormQuestion, MoveInFormTemplate } from "@/lib/move-in-forms/types";
import { MOVE_IN_FORM_STARTERS, newMoveInFormTemplate } from "@/lib/move-in-forms/templates";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));
vi.mock("@/lib/tools/audit", () => ({ writeAuditLog: vi.fn(async () => ({ recorded: true })), updateAuditResult: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: vi.fn() }));
vi.mock("@/lib/auth/manager-application-access", () => ({ managerOwnedPropertyIdSet: async (_db: unknown, userId: string) => new Set(userId === "owner" ? ["home"] : []) }));
vi.mock("@/lib/auth/co-manager-module-scope", () => ({ linkedOwnerScopeForModule: async (_db: unknown, userId: string) => ({ owners: new Set(), propertyIds: new Set(userId === "co-manager" ? ["home"] : []) }) }));
vi.mock("@/lib/workspaces/scope.server", () => ({ activeWorkspacePropertyScope: vi.fn(async () => null) }));
const emitted = vi.hoisted(() => ({ calls: [] as { event: string; id: string }[] }));
vi.mock("@/lib/move-in-forms/move-in-form-events.server", () => ({
  emitMoveInFormEvent: vi.fn(async (_db: unknown, input: { event: string; row: { id: string } }) => { emitted.calls.push({ event: input.event, id: input.row.id }); }),
  emailManagerOfMoveInFormSubmission: vi.fn(async (_db: unknown, row: { id: string }) => { emitted.calls.push({ event: "email", id: row.id }); return true; }),
}));

import {
  cancelMoveInForm, checkMoveInFormAnswers, deleteMoveInFormFile, dispatchMoveInFormsForResidency, dispatchMoveInFormsForSignedLease,
  listMoveInForms, moveInFormDetail, moveInFormFileUrl, remindMoveInForm, saveMoveInFormDraft, sendMoveInForm,
  submitMoveInForm, uploadMoveInFormFile, uploadMoveInFormTemplatePdf, type MoveInFormActor,
} from "@/lib/move-in-forms/server";
import { MAX_FILES_PER_QUESTION } from "@/lib/move-in-forms/limits";

type Row = Record<string, unknown>;
let forms: Row[];
let applications: Row[];
let properties: Row[];
let leases: Row[];
/** bucket -> path -> bytes */
let objects: Record<string, Map<string, Uint8Array>>;

function builder(table: string) {
  const filters: ((row: Row) => boolean)[] = [];
  let patch: Row | undefined;
  let inserted: Row | undefined;
  let insertError: { code: string } | undefined;
  let from = 0; let to = Infinity;
  const rows = () => table === "resident_move_in_forms" ? forms : table === "manager_application_records" ? applications
    : table === "manager_property_records" ? properties : table === "portal_lease_pipeline_records" ? leases : [];
  const run = () => {
    if (insertError) return { data: null, error: insertError };
    if (inserted) return { data: structuredClone(inserted), error: null };
    const matched = rows().filter((row) => filters.every((f) => f(row))).slice(from, to + 1);
    if (patch) for (const row of matched) Object.assign(row, patch);
    return { data: structuredClone(matched), error: null };
  };
  const q: Record<string, unknown> = {
    select: () => q, order: () => q,
    eq: (key: string, value: unknown) => { filters.push((row) => row[key] === value); return q; },
    neq: (key: string, value: unknown) => { filters.push((row) => row[key] !== value); return q; },
    in: (key: string, values: unknown[]) => { filters.push((row) => values.includes(row[key])); return q; },
    is: (key: string, value: unknown) => { filters.push((row) => (row[key] ?? null) === value); return q; },
    range: (a: number, b: number) => { from = a; to = b; return q; },
    update: (value: Row) => { patch = value; return q; },
    insert: (value: Row) => {
      // The partial unique index: one SENT copy of a form per residency (a submitted one is history).
      const clash = forms.some((row) => row.application_id === value.application_id && row.form_id === value.form_id && row.status === "sent");
      if (clash) { insertError = { code: "23505" }; return q; }
      inserted = { id: crypto.randomUUID(), answers: [], signed_document_sha256: null, submitted_at: null, reminded_at: null,
        manager_viewed_at: null, sent_at: new Date().toISOString(), ...value };
      forms.push(inserted);
      return q;
    },
    maybeSingle: async () => { const r = run(); return { ...r, data: Array.isArray(r.data) ? r.data[0] ?? null : r.data }; },
    single: async () => { const r = run(); return { ...r, data: Array.isArray(r.data) ? r.data[0] ?? null : r.data }; },
    then: (resolve: (value: ReturnType<typeof run>) => unknown) => Promise.resolve(run()).then(resolve),
  };
  return q;
}
const storage = {
  from: (bucket: string) => ({
    list: async (prefix: string) => ({ data: [...(objects[bucket]?.keys() ?? [])].filter((p) => p.startsWith(`${prefix}/`)).map((p) => ({ name: p.slice(prefix.length + 1) })), error: null }),
    upload: vi.fn(async (path: string, bytes: Uint8Array) => { (objects[bucket] ??= new Map()).set(path, bytes); return { error: null }; }),
    remove: vi.fn(async (paths: string[]) => { for (const path of paths) objects[bucket]?.delete(path); return { error: null }; }),
    download: async (path: string) => { const bytes = objects[bucket]?.get(path); return bytes ? { data: new Blob([bytes as BlobPart]), error: null } : { data: null, error: { message: "missing" } }; },
    createSignedUrl: async (path: string) => ({ data: { signedUrl: `https://signed.example/${path}` }, error: null }),
  }),
};
const db = { from: builder, storage };
const manager = (userId = "owner"): MoveInFormActor => ({ role: "manager", context: { userId, landlordId: userId, db } as unknown as AgentContext });
const resident = (userId = "res-a", email = "a@example.test"): MoveInFormActor => ({ role: "resident", context: { userId, landlordId: userId, email, phase: "approved", db } as unknown as ResidentAgentContext });

const q = (key: string, type: MoveInFormQuestion["type"], extra: Partial<MoveInFormQuestion> = {}): MoveInFormQuestion =>
  ({ id: `q-${key}`, key, label: key, type, required: false, options: [], ...extra });
const ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const UUID = "33333333-3333-4333-8333-333333333333";

function formRow(overrides: Row = {}): Row {
  return {
    id: ID, application_id: "AXIS-A", manager_user_id: "owner", property_id: "home", property_label: "12 Elm", room_label: "Room 1",
    resident_name: "Resident A", resident_email: "a@example.test", resident_user_id: "res-a", form_id: "f1", form_name: "Checklist",
    source: "built", status: "sent", answers: [], signed_document_sha256: null, sent_at: "2026-10-01T00:00:00Z", due_at: null,
    submitted_at: null, reminded_at: null, manager_viewed_at: null,
    snapshot: { pdf: null, questions: [
      q("name", "text", { required: true }),
      q("pet", "yes_no", { required: true }),
      q("pet_name", "text", { required: true, showIf: { fieldKey: "pet", equals: "yes" } }),
      q("room_photos", "photos", { required: true }),
      q("sig", "signature", { required: true }),
    ] },
    ...overrides,
  };
}
const sigAnswer = (id = ID) => ({ key: "sig", signature: { storagePath: `${id}/sig/${UUID}.png`, signedName: "Resident A", signedAt: "ignored" } });
const photoAnswer = (id = ID) => ({ key: "room_photos", files: [`${id}/room_photos/${UUID}.jpg`] });
function stored(id = ID) {
  (objects["move-in-form-files"] ??= new Map()).set(`${id}/sig/${UUID}.png`, new Uint8Array([1]));
  objects["move-in-form-files"]!.set(`${id}/room_photos/${UUID}.jpg`, new Uint8Array([1]));
}
const goodAnswers = (id = ID) => [{ key: "name", value: "A" }, { key: "pet", value: "no" }, photoAnswer(id), sigAnswer(id)];

beforeEach(() => {
  vi.clearAllMocks();
  emitted.calls = [];
  objects = {};
  forms = [formRow()];
  leases = [];
  properties = [{ id: "home", manager_user_id: "owner", templates: null, settings: null, rooms: [{ id: "r1", name: "Room 1" }, { id: "r2", name: "Room 2" }], legacy_rooms: null }];
  applications = [{ id: "AXIS-A", manager_user_id: "owner", property_id: "home", resident_email: "a@example.test", app_bucket: "approved",
    app_name: "Resident A", app_property: "12 Elm", app_property_id: "home", app_resident_user_id: "res-a", app_room_choice: "home::r1", app_lease_start: "2026-10-10" }];
});

describe("authorization: a foreign id is a 404, never a 403", () => {
  it("hides manager A's row from manager B for read, remind and cancel", async () => {
    const other = manager("other-owner");
    await expect(moveInFormDetail(other, ID)).rejects.toMatchObject({ status: 404 });
    await expect(remindMoveInForm(other, ID)).rejects.toMatchObject({ status: 404 });
    await expect(cancelMoveInForm(other, ID)).rejects.toMatchObject({ status: 404 });
    expect((await listMoveInForms(other)).forms).toEqual([]);
    expect(forms[0]!.status).toBe("sent");
  });

  it("will not let manager B send a form for manager A's residency", async () => {
    properties[0]!.templates = [{ ...newMoveInFormTemplate("built"), id: "f1", name: "F", questions: [q("sig", "signature", { required: true })] }];
    await expect(sendMoveInForm(manager("other-owner"), { applicationId: "AXIS-A", formId: "f1" })).rejects.toMatchObject({ status: 404 });
    expect(forms).toHaveLength(1);
  });

  it("hides resident A's row from resident B for read, save and submit", async () => {
    const roommate = resident("res-b", "b@example.test");
    await expect(moveInFormDetail(roommate, ID)).rejects.toMatchObject({ status: 404 });
    await expect(saveMoveInFormDraft(roommate, ID, { answers: [] })).rejects.toMatchObject({ status: 404 });
    await expect(submitMoveInForm(roommate, ID, { answers: goodAnswers() })).rejects.toMatchObject({ status: 404 });
    await expect(moveInFormFileUrl(roommate, ID, `${ID}/sig/${UUID}.png`)).rejects.toMatchObject({ status: 404 });
    expect((await listMoveInForms(roommate)).forms).toEqual([]);
    expect(forms[0]!.status).toBe("sent");
  });

  it("refuses a resident the manager routes and a manager the resident ones", async () => {
    await expect(remindMoveInForm(resident(), ID)).rejects.toMatchObject({ status: 404 });
    await expect(cancelMoveInForm(resident(), ID)).rejects.toMatchObject({ status: 404 });
    await expect(submitMoveInForm(manager(), ID, { answers: goodAnswers() })).rejects.toMatchObject({ status: 404 });
  });

  it("does not match another resident reusing the email with a different login", async () => {
    await expect(moveInFormDetail(resident("imposter", "a@example.test"), ID)).rejects.toMatchObject({ status: 404 });
  });
});

describe("submit", () => {
  it("rejects a missing required answer with 400 and leaves the row open", async () => {
    stored();
    await expect(submitMoveInForm(resident(), ID, { answers: [{ key: "pet", value: "no" }, photoAnswer(), sigAnswer()] }))
      .rejects.toMatchObject({ status: 400, message: "name is required." });
    expect(forms[0]!.status).toBe("sent");
  });

  it("does not require a question its showIf hides, and requires it when shown", async () => {
    stored();
    const ok = await submitMoveInForm(resident(), ID, { answers: goodAnswers() });
    expect(ok.form.status).toBe("submitted");
    forms = [formRow()];
    await expect(submitMoveInForm(resident(), ID, { answers: [{ key: "name", value: "A" }, { key: "pet", value: "yes" }, photoAnswer(), sigAnswer()] }))
      .rejects.toMatchObject({ status: 400, message: "pet_name is required." });
  });

  it("drops an answer to a question that is hidden", async () => {
    stored();
    const { form } = await submitMoveInForm(resident(), ID, { answers: [...goodAnswers(), { key: "pet_name", value: "Rex" }] });
    expect(form.answers.some((answer) => answer.key === "pet_name")).toBe(false);
  });

  it("returns 409 on a second submit and does not rewrite the first answers", async () => {
    stored();
    await submitMoveInForm(resident(), ID, { answers: goodAnswers() });
    const first = structuredClone(forms[0]!.answers);
    await expect(submitMoveInForm(resident(), ID, { answers: [{ key: "name", value: "Changed" }, ...goodAnswers().slice(1)] }))
      .rejects.toMatchObject({ status: 409 });
    expect(forms[0]!.answers).toEqual(first);
    await expect(saveMoveInFormDraft(resident(), ID, { answers: [] })).rejects.toMatchObject({ status: 409 });
  });

  it("rejects an answer file outside this record's prefix", async () => {
    stored();
    for (const path of [`${OTHER_ID}/room_photos/${UUID}.jpg`, `${ID}/other_key/${UUID}.jpg`, `${ID}/room_photos/../x.jpg`, `${ID}/room_photos/${UUID}.svg`]) {
      await expect(submitMoveInForm(resident(), ID, { answers: [{ key: "name", value: "A" }, { key: "pet", value: "no" }, { key: "room_photos", files: [path] }, sigAnswer()] }))
        .rejects.toMatchObject({ status: 400 });
    }
    await expect(submitMoveInForm(resident(), ID, { answers: [{ key: "name", value: "A" }, { key: "pet", value: "no" }, photoAnswer(), { key: "sig", signature: { storagePath: `${OTHER_ID}/sig/${UUID}.png`, signedName: "A", signedAt: "x" } }] }))
      .rejects.toMatchObject({ status: 400 });
    expect(forms[0]!.status).toBe("sent");
  });

  it("rejects a file that was never actually stored", async () => {
    await expect(submitMoveInForm(resident(), ID, { answers: goodAnswers() })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/missing/) });
  });

  it("rejects unknown keys, duplicates and off-list options", () => {
    const questions = [q("a", "select", { options: ["x", "y"] }), q("b", "multi_select", { options: ["x", "y"] })];
    expect(() => checkMoveInFormAnswers(ID, questions, [{ key: "zzz", value: "x" }], "draft")).toThrow(/does not ask/);
    expect(() => checkMoveInFormAnswers(ID, questions, [{ key: "a", value: "x" }, { key: "a", value: "y" }], "draft")).toThrow(/only be answered once/);
    expect(() => checkMoveInFormAnswers(ID, questions, [{ key: "a", value: "nope" }], "draft")).toThrow(/listed options/);
    expect(() => checkMoveInFormAnswers(ID, questions, [{ key: "b", value: ["x", "nope"] }], "draft")).toThrow(/listed options/);
    expect(checkMoveInFormAnswers(ID, questions, [{ key: "b", value: ["x"] }], "draft")).toEqual([{ key: "b", value: ["x"] }]);
  });

  it("validates types and lets a draft skip only required-ness", () => {
    const questions = [q("n", "number", { required: true }), q("d", "date"), q("e", "email"), q("c", "checkbox", { required: true })];
    expect(checkMoveInFormAnswers(ID, questions, [], "draft")).toEqual([]);
    expect(() => checkMoveInFormAnswers(ID, questions, [], "submit")).toThrow(/required/);
    expect(() => checkMoveInFormAnswers(ID, questions, [{ key: "n", value: "abc" }], "draft")).toThrow(/number/);
    expect(() => checkMoveInFormAnswers(ID, questions, [{ key: "d", value: "2026-02-31" }], "draft")).toThrow(/date/);
    expect(() => checkMoveInFormAnswers(ID, questions, [{ key: "e", value: "not-an-email" }], "draft")).toThrow(/email/);
    expect(() => checkMoveInFormAnswers(ID, questions, [{ key: "n", value: 4 }, { key: "c", value: false }], "submit")).toThrow(/required/);
    expect(checkMoveInFormAnswers(ID, questions, [{ key: "n", value: 4 }, { key: "c", value: true }], "submit")).toHaveLength(2);
  });

  it("stamps the signing time on the server and never the client's", async () => {
    stored();
    const { form } = await submitMoveInForm(resident(), ID, { answers: goodAnswers() });
    const signature = form.answers.find((answer) => "signature" in answer);
    expect(signature && "signature" in signature && signature.signature.signedAt).not.toBe("ignored");
  });

  it("notifies the manager once, and not when the property turns it off", async () => {
    stored();
    await submitMoveInForm(resident(), ID, { answers: goodAnswers() });
    expect(emitted.calls).toEqual([{ event: "submitted", id: ID }]);
    emitted.calls = [];
    forms = [formRow()];
    properties[0]!.settings = { remind: "never", notifyOnSubmit: "none" };
    await submitMoveInForm(resident(), ID, { answers: goodAnswers() });
    expect(emitted.calls).toEqual([]);
  });

  it("emails the manager only when the property asks for an Assistant notice and email", async () => {
    stored();
    properties[0]!.settings = { remind: "never", notifyOnSubmit: "assistant" };
    await submitMoveInForm(resident(), ID, { answers: goodAnswers() });
    expect(emitted.calls.map((call) => call.event)).toEqual(["submitted"]);
    emitted.calls = [];
    forms = [formRow()];
    properties[0]!.settings = { remind: "never", notifyOnSubmit: "assistant-and-email" };
    await submitMoveInForm(resident(), ID, { answers: goodAnswers() });
    expect(emitted.calls.map((call) => call.event)).toEqual(["submitted", "email"]);
  });

  it("prunes stored uploads the final answers no longer reference", async () => {
    stored();
    const orphan = `${ID}/room_photos/${OTHER_ID}.jpg`;
    objects["move-in-form-files"]!.set(orphan, new Uint8Array([1]));
    await submitMoveInForm(resident(), ID, { answers: goodAnswers() });
    expect(objects["move-in-form-files"]!.has(orphan)).toBe(false);
    expect(objects["move-in-form-files"]!.has(`${ID}/room_photos/${UUID}.jpg`)).toBe(true);
    expect(objects["move-in-form-files"]!.has(`${ID}/sig/${UUID}.png`)).toBe(true);
  });
});

describe("uploaded document forms", () => {
  const pdfBytes = new TextEncoder().encode("%PDF-1.4 signed bytes");
  const sha = createHash("sha256").update(pdfBytes).digest("hex");
  const path = `owner/move-in-forms/f1/1700000000000-${UUID}.pdf`;
  const uploadRow = () => formRow({
    source: "upload",
    snapshot: { questions: [q("sig", "signature", { required: true })], pdf: { storagePath: path, fileName: "Rules.pdf", pageCount: 2, sha256: sha } },
  });

  it("stores the SHA-256 of the exact PDF bytes the resident signed", async () => {
    forms = [uploadRow()];
    (objects["lease-templates"] ??= new Map()).set(path, pdfBytes);
    (objects["move-in-form-files"] ??= new Map()).set(`${ID}/sig/${UUID}.png`, new Uint8Array([1]));
    const { form } = await submitMoveInForm(resident(), ID, { answers: [sigAnswer()] });
    expect(form.signedDocumentSha256).toBe(sha);
    expect(forms[0]!.signed_document_sha256).toBe(sha);
  });

  it("refuses when the stored document changed after it was sent", async () => {
    forms = [uploadRow()];
    (objects["lease-templates"] ??= new Map()).set(path, new TextEncoder().encode("%PDF-1.4 tampered"));
    (objects["move-in-form-files"] ??= new Map()).set(`${ID}/sig/${UUID}.png`, new Uint8Array([1]));
    await expect(submitMoveInForm(resident(), ID, { answers: [sigAnswer()] })).rejects.toMatchObject({ status: 409 });
    expect(forms[0]!.status).toBe("sent");
  });

  it("refuses a snapshot whose document path is outside the owner's prefix", async () => {
    forms = [uploadRow()];
    (forms[0]!.snapshot as { pdf: { storagePath: string } }).pdf.storagePath = `victim/move-in-forms/f1/1700000000000-${UUID}.pdf`;
    (objects["lease-templates"] ??= new Map()).set(`victim/move-in-forms/f1/1700000000000-${UUID}.pdf`, pdfBytes);
    (objects["move-in-form-files"] ??= new Map()).set(`${ID}/sig/${UUID}.png`, new Uint8Array([1]));
    await expect(submitMoveInForm(resident(), ID, { answers: [sigAnswer()] })).rejects.toMatchObject({ status: 409 });
  });
});

describe("manager actions", () => {
  it("opens a submission once and clears it from the unread count", async () => {
    forms = [formRow({ status: "submitted", submitted_at: "2026-10-02T00:00:00Z" })];
    expect((await listMoveInForms(manager())).unread).toBe(1);
    const { form } = await moveInFormDetail(manager(), ID);
    expect(form.managerViewedAt).not.toBeNull();
    expect((await listMoveInForms(manager())).unread).toBe(0);
  });

  it("never lets a resident see manager viewing state", async () => {
    forms = [formRow({ status: "submitted", manager_viewed_at: "2026-10-03T00:00:00Z" })];
    expect((await moveInFormDetail(resident(), ID)).form.managerViewedAt).toBeNull();
  });

  it("cancels an open form but locks a submitted one", async () => {
    await cancelMoveInForm(manager(), ID);
    expect(forms[0]!.status).toBe("cancelled");
    forms = [formRow({ status: "submitted" })];
    await expect(cancelMoveInForm(manager(), ID)).rejects.toMatchObject({ status: 409 });
    expect(forms[0]!.status).toBe("submitted");
  });

  it("hides a cancelled form from the resident and from lists", async () => {
    forms = [formRow({ status: "cancelled" })];
    await expect(moveInFormDetail(resident(), ID)).rejects.toMatchObject({ status: 404 });
    expect((await listMoveInForms(manager())).forms).toEqual([]);
  });

  it("reminds an open form once per cooldown and refuses a submitted one", async () => {
    await remindMoveInForm(manager(), ID);
    expect(forms[0]!.reminded_at).toBeTruthy();
    expect(emitted.calls).toEqual([{ event: "reminder", id: ID }]);
    await expect(remindMoveInForm(manager(), ID)).rejects.toMatchObject({ status: 409 });
    forms = [formRow({ status: "submitted" })];
    await expect(remindMoveInForm(manager(), ID)).rejects.toMatchObject({ status: 409 });
  });

  it("sends once by hand (even a form that never sends itself), and refuses a duplicate", async () => {
    const template: MoveInFormTemplate = { ...newMoveInFormTemplate("built"), id: "f2", name: "Keys", trigger: "manual", questions: [q("sig", "signature", { required: true })] };
    properties[0]!.templates = [template];
    const sent = await sendMoveInForm(manager(), { applicationId: "AXIS-A", formId: "f2" });
    expect(sent.form).toMatchObject({ formId: "f2", status: "sent", roomLabel: "Room 1", questionCount: 1 });
    expect(forms.find((row) => row.form_id === "f2")!.due_at).toBe(sent.form.dueAt);
    await expect(sendMoveInForm(manager(), { applicationId: "AXIS-A", formId: "f2" })).rejects.toMatchObject({ status: 409 });
    await expect(sendMoveInForm(manager(), { applicationId: "AXIS-A", formId: "nope" })).rejects.toMatchObject({ status: 404 });
  });

  it("sends again after the resident submitted: a fresh copy, the submitted one stays as history", async () => {
    properties[0]!.templates = [{ ...newMoveInFormTemplate("built"), id: "f1", name: "Checklist", trigger: "manual", questions: [q("sig", "signature", { required: true })] }];
    forms = [formRow({ status: "submitted", submitted_at: "2026-10-02T00:00:00Z" })];
    const again = await sendMoveInForm(manager(), { applicationId: "AXIS-A", formId: "f1" });
    expect(again.form.status).toBe("sent");
    expect(forms).toHaveLength(2);
    expect(forms.filter((row) => row.status === "submitted")).toHaveLength(1);
    expect(forms.filter((row) => row.status === "sent")).toHaveLength(1);
    // A second send while that fresh copy is still waiting is refused.
    await expect(sendMoveInForm(manager(), { applicationId: "AXIS-A", formId: "f1" })).rejects.toMatchObject({ status: 409 });
    expect(forms).toHaveLength(2);
  });

  it("will not send an upload form that has no stored document", async () => {
    properties[0]!.templates = [{ ...newMoveInFormTemplate("upload"), id: "up", name: "Rules", pdf: null }];
    await expect(sendMoveInForm(manager(), { applicationId: "AXIS-A", formId: "up" })).rejects.toMatchObject({ status: 409 });
  });
});

describe("files", () => {
  it("mints a signed URL only for a path under the record, and managers only for submitted answers", async () => {
    forms = [formRow({ status: "submitted", answers: [photoAnswer(), sigAnswer()] })];
    const photo = `${ID}/room_photos/${UUID}.jpg`;
    expect(await moveInFormFileUrl(manager(), ID, photo)).toBe(`https://signed.example/${photo}`);
    expect(await moveInFormFileUrl(resident(), ID, photo)).toBe(`https://signed.example/${photo}`);
    await expect(moveInFormFileUrl(manager(), ID, `${OTHER_ID}/room_photos/${UUID}.jpg`)).rejects.toMatchObject({ status: 404 });
    await expect(moveInFormFileUrl(manager(), ID, `${ID}/room_photos/${OTHER_ID}.jpg`)).rejects.toMatchObject({ status: 404 });
    await expect(moveInFormFileUrl(manager("other-owner"), ID, photo)).rejects.toMatchObject({ status: 404 });
  });

  it("refuses an upload that is not an image, for a question that takes no file, or on a submitted form", async () => {
    await expect(uploadMoveInFormFile(resident(), ID, "room_photos", new File(["<svg></svg>"], "x.jpg", { type: "image/jpeg" }))).rejects.toMatchObject({ status: 400 });
    await expect(uploadMoveInFormFile(resident(), ID, "name", new File(["x"], "x.jpg"))).rejects.toMatchObject({ status: 400 });
    await expect(uploadMoveInFormFile(resident("res-b", "b@example.test"), ID, "room_photos", new File(["x"], "x.jpg"))).rejects.toMatchObject({ status: 404 });
    forms = [formRow({ status: "submitted" })];
    await expect(uploadMoveInFormFile(resident(), ID, "room_photos", new File(["x"], "x.jpg"))).rejects.toMatchObject({ status: 409 });
  });

  it("re-encodes a real image into the record's own prefix", async () => {
    const sharp = (await import("sharp")).default;
    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: "white" } }).png().toBuffer();
    const { storagePath } = await uploadMoveInFormFile(resident(), ID, "room_photos", new File([new Uint8Array(png)], "x.png", { type: "image/png" }));
    expect(storagePath).toMatch(new RegExp(`^${ID}/room_photos/[0-9a-f-]{36}\\.jpg$`));
    const signature = await uploadMoveInFormFile(resident(), ID, "sig", new File([new Uint8Array(png)], "s.png", { type: "image/png" }));
    expect(signature.storagePath).toMatch(/\.png$/);
  });
});

describe("removing an upload", () => {
  it("deletes only a file inside this record's prefix, only while the form is open", async () => {
    stored();
    const photo = `${ID}/room_photos/${UUID}.jpg`;
    await expect(deleteMoveInFormFile(resident(), ID, photo)).resolves.toEqual({ ok: true });
    expect(objects["move-in-form-files"]!.has(photo)).toBe(false);
    for (const path of [`${OTHER_ID}/room_photos/${UUID}.jpg`, `${ID}/not_a_question/${UUID}.jpg`, `${ID}/room_photos/../x.jpg`, `${ID}/room_photos/${UUID}.svg`, "nonsense"]) {
      await expect(deleteMoveInFormFile(resident(), ID, path)).rejects.toMatchObject({ status: 404 });
    }
    await expect(deleteMoveInFormFile(resident("res-b", "b@example.test"), ID, `${ID}/sig/${UUID}.png`)).rejects.toMatchObject({ status: 404 });
    await expect(deleteMoveInFormFile(manager(), ID, `${ID}/sig/${UUID}.png`)).rejects.toMatchObject({ status: 404 });
    expect(objects["move-in-form-files"]!.has(`${ID}/sig/${UUID}.png`)).toBe(true);
    forms = [formRow({ status: "submitted" })];
    await expect(deleteMoveInFormFile(resident(), ID, `${ID}/sig/${UUID}.png`)).rejects.toMatchObject({ status: 409 });
  });

  it("frees the question's file cap once a photo is deleted", async () => {
    const png = await (await import("sharp")).default({ create: { width: 4, height: 4, channels: 3, background: "white" } }).png().toBuffer();
    const file = () => new File([new Uint8Array(png)], "x.png", { type: "image/png" });
    const paths: string[] = [];
    for (let i = 0; i < MAX_FILES_PER_QUESTION; i++) paths.push((await uploadMoveInFormFile(resident(), ID, "room_photos", file())).storagePath);
    await expect(uploadMoveInFormFile(resident(), ID, "room_photos", file())).rejects.toMatchObject({ message: "This question has reached its file limit." });
    await deleteMoveInFormFile(resident(), ID, paths[0]!);
    await expect(uploadMoveInFormFile(resident(), ID, "room_photos", file())).resolves.toHaveProperty("storagePath");
  });
});

describe("listing filters run in the query", () => {
  it("scopes by application, property and status", async () => {
    forms = [
      formRow(),
      formRow({ id: OTHER_ID, application_id: "AXIS-B", status: "submitted" }),
      formRow({ id: UUID, application_id: "AXIS-A", status: "cancelled" }),
    ];
    expect((await listMoveInForms(manager(), { applicationId: "AXIS-A" })).forms.map((form) => form.id)).toEqual([ID]);
    expect((await listMoveInForms(manager(), { status: "submitted" })).forms.map((form) => form.id)).toEqual([OTHER_ID]);
    expect((await listMoveInForms(manager(), { propertyId: "elsewhere" })).forms).toEqual([]);
    expect((await listMoveInForms(manager())).forms.map((form) => form.id).sort()).toEqual([ID, OTHER_ID].sort());
  });
});

describe("template PDF upload", () => {
  it("tells a co-manager the real reason, and a stranger that the property does not exist", async () => {
    const file = new File([new TextEncoder().encode("%PDF-1.4 hello world")], "Rules.pdf", { type: "application/pdf" });
    await expect(uploadMoveInFormTemplatePdf(manager("other-owner"), { propertyId: "home", formId: "f1", file })).rejects.toMatchObject({ status: 404 });
    await expect(uploadMoveInFormTemplatePdf(manager("co-manager"), { propertyId: "home", formId: "f1", file }))
      .rejects.toMatchObject({ status: 403, message: "Only the property owner can upload the form's PDF." });
  });
});

describe("dispatch", () => {
  const enabled = (id: string, extra: Partial<MoveInFormTemplate> = {}): MoveInFormTemplate =>
    ({ ...newMoveInFormTemplate("built"), id, name: id, trigger: "lease-signed", questions: [q("sig", "signature", { required: true })], ...extra });

  beforeEach(() => { forms = []; });

  it("sends the templates for the trigger with a snapshot and a due date from the move-in date", async () => {
    properties[0]!.templates = [enabled("a"), enabled("b", { enabled: false } as never), enabled("c", { trigger: "application-approved" }), enabled("d", { trigger: "manual" })];
    const result = await dispatchMoveInFormsForResidency("AXIS-A", "lease-signed", { db: db as never });
    expect(result).toEqual({ sent: 1 });
    expect(forms.map((row) => row.form_id)).toEqual(["a"]);
    expect(forms[0]).toMatchObject({ status: "sent", resident_email: "a@example.test", room_label: "Room 1", manager_user_id: "owner" });
    expect((forms[0]!.snapshot as { questions: unknown[] }).questions).toHaveLength(1);
    expect(forms[0]!.due_at).toEqual(expect.stringMatching(/^2026-10-10T0[67]:59:59/));
    expect(emitted.calls).toEqual([{ event: "sent", id: forms[0]!.id }]);
  });

  it("is idempotent: a second dispatch sends nothing new", async () => {
    properties[0]!.templates = [enabled("a")];
    await dispatchMoveInFormsForResidency("AXIS-A", "lease-signed", { db: db as never });
    expect(await dispatchMoveInFormsForResidency("AXIS-A", "lease-signed", { db: db as never })).toEqual({ sent: 0 });
    expect(forms).toHaveLength(1);
    expect(emitted.calls).toHaveLength(1);
  });

  it("never re-sends a form the resident already submitted", async () => {
    properties[0]!.templates = [enabled("a")];
    await dispatchMoveInFormsForResidency("AXIS-A", "lease-signed", { db: db as never });
    forms[0]!.status = "submitted";
    expect(await dispatchMoveInFormsForResidency("AXIS-A", "lease-signed", { db: db as never })).toEqual({ sent: 0 });
    expect(forms).toHaveLength(1);
    expect(emitted.calls).toHaveLength(1);
  });

  it("sends again after the manager cancelled the earlier copy", async () => {
    properties[0]!.templates = [enabled("a")];
    await dispatchMoveInFormsForResidency("AXIS-A", "lease-signed", { db: db as never });
    forms[0]!.status = "cancelled";
    expect(await dispatchMoveInFormsForResidency("AXIS-A", "lease-signed", { db: db as never })).toEqual({ sent: 1 });
  });

  it("a property that never saved its forms sends nothing at lease signing; saving the checklist with that trigger sends it", async () => {
    properties[0]!.templates = null;
    expect(await dispatchMoveInFormsForResidency("AXIS-A", "lease-signed", { db: db as never })).toEqual({ sent: 0 });
    expect(forms).toEqual([]);
    const checklist = MOVE_IN_FORM_STARTERS.find((t) => t.starterKey === "move-in-checklist")!;
    expect(checklist.trigger).toBe("lease-signed");
    properties[0]!.templates = [checklist];
    expect(await dispatchMoveInFormsForResidency("AXIS-A", "lease-signed", { db: db as never })).toEqual({ sent: 1 });
    expect(forms.map((row) => row.form_id)).toEqual(["starter-move-in-checklist"]);
  });

  it("skips templates whose rooms do not include this residency's room", async () => {
    properties[0]!.templates = [enabled("only-r2", { audience: { kind: "rooms", roomIds: ["r2"] } }), enabled("r1", { audience: { kind: "rooms", roomIds: ["r1"] } })];
    await dispatchMoveInFormsForResidency("AXIS-A", "lease-signed", { db: db as never });
    expect(forms.map((row) => row.form_id)).toEqual(["r1"]);
    applications[0]!.app_room_choice = "";
    forms = [];
    await dispatchMoveInFormsForResidency("AXIS-A", "lease-signed", { db: db as never });
    expect(forms).toEqual([]);
  });

  it("sends a whole-house form to the primary signer only", async () => {
    properties[0]!.templates = [enabled("house", { audience: { kind: "whole-house" } })];
    expect(await dispatchMoveInFormsForResidency("AXIS-A", "lease-signed", { db: db as never, secondaryMember: true })).toEqual({ sent: 0 });
    expect(await dispatchMoveInFormsForResidency("AXIS-A", "lease-signed", { db: db as never })).toEqual({ sent: 1 });
  });

  it("does nothing for a residency that is not approved, withdrawn, or unknown", async () => {
    properties[0]!.templates = [enabled("a")];
    applications[0]!.app_bucket = "pending";
    expect(await dispatchMoveInFormsForResidency("AXIS-A", "lease-signed", { db: db as never })).toEqual({ sent: 0 });
    applications[0]!.app_bucket = "approved"; applications[0]!.app_withdrawn_at = "2026-10-02";
    expect(await dispatchMoveInFormsForResidency("AXIS-A", "lease-signed", { db: db as never })).toEqual({ sent: 0 });
    expect(await dispatchMoveInFormsForResidency("NOPE", "lease-signed", { db: db as never })).toEqual({ sent: 0 });
    expect(forms).toEqual([]);
  });

  it("skips an upload form whose document is missing or outside the owner's prefix", async () => {
    const pdf = (storagePath: string) => ({ storagePath, fileName: "x.pdf", pageCount: 1, sha256: "a".repeat(64) });
    properties[0]!.templates = [
      enabled("up1", { source: "upload", pdf: pdf(`owner/move-in-forms/up1/1-${UUID}.pdf`) }),
      enabled("up2", { source: "upload", pdf: pdf(`victim/move-in-forms/up2/1-${UUID}.pdf`) }),
    ];
    (objects["lease-templates"] ??= new Map()).set(`victim/move-in-forms/up2/1-${UUID}.pdf`, new Uint8Array([1]));
    expect(await dispatchMoveInFormsForResidency("AXIS-A", "lease-signed", { db: db as never })).toEqual({ sent: 0 });
    (objects["lease-templates"]!).set(`owner/move-in-forms/up1/1-${UUID}.pdf`, new TextEncoder().encode("%PDF-1.4 x"));
    expect(await dispatchMoveInFormsForResidency("AXIS-A", "lease-signed", { db: db as never })).toEqual({ sent: 1 });
    // The fingerprint is recomputed from the stored bytes, never taken from the property JSON.
    expect((forms[0]!.snapshot as { pdf: { sha256: string } }).pdf.sha256).toBe(createHash("sha256").update("%PDF-1.4 x").digest("hex"));
  });

  it("never throws into the caller", async () => {
    const broken = { from: () => { throw new Error("db down"); }, storage };
    await expect(dispatchMoveInFormsForResidency("AXIS-A", "lease-signed", { db: broken as never })).resolves.toEqual({ sent: 0 });
  });

  it("a signed lease reaches the primary signer and joint members through the service client", async () => {
    const { createSupabaseServiceRoleClient } = await import("@/lib/supabase/service");
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(db as never);
    properties[0]!.templates = [enabled("a"), enabled("house", { audience: { kind: "whole-house" } })];
    applications.push({ ...applications[0]!, id: "AXIS-B", resident_email: "b@example.test", app_resident_user_id: "res-b", app_name: "Resident B" });
    await dispatchMoveInFormsForSignedLease({ axisId: "AXIS-A", jointLeaseMembers: [{ applicationId: "AXIS-A" }, { applicationId: "AXIS-B" }] });
    expect(forms.map((row) => `${row.application_id}:${row.form_id}`).sort()).toEqual(["AXIS-A:a", "AXIS-A:house", "AXIS-B:a"]);
  });
});
