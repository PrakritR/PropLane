import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentContext } from "@/lib/tools/context";
import type { ResidentAgentContext } from "@/lib/tools/resident-context";
import type { MoveInFormQuestion, MoveInFormTemplate } from "@/lib/move-in-forms/types";
import { defaultMoveInForm, MOVE_IN_FORM_STARTERS, moveInFormDueFor, newMoveInFormTemplate } from "@/lib/move-in-forms/templates";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));
vi.mock("@/lib/tools/audit", () => ({ writeAuditLog: vi.fn(async () => ({ recorded: true })), updateAuditResult: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: vi.fn() }));
vi.mock("@/lib/auth/manager-application-access", () => ({ managerOwnedPropertyIdSet: async (_db: unknown, userId: string) => new Set(userId === "owner" ? ["home"] : []) }));
vi.mock("@/lib/auth/co-manager-module-scope", () => ({ linkedOwnerScopeForModule: async (_db: unknown, userId: string) => ({ owners: new Set(), propertyIds: new Set(userId === "co-manager" ? ["home"] : []) }) }));
vi.mock("@/lib/workspaces/scope.server", () => ({ activeWorkspacePropertyScope: vi.fn(async () => null) }));
const planTier = vi.hoisted(() => ({ value: "paid" as "free" | "paid" | null }));
vi.mock("@/lib/manager-access-server", () => ({ getManagerPortalNavSubscriptionTier: vi.fn(async () => planTier.value) }));
const emitted = vi.hoisted(() => ({ calls: [] as { event: string; id: string }[] }));
vi.mock("@/lib/move-in-forms/move-in-form-events.server", () => ({
  emitMoveInFormEvent: vi.fn(async (_db: unknown, input: { event: string; row: { id: string } }) => { emitted.calls.push({ event: input.event, id: input.row.id }); }),
  emailManagerOfMoveInFormSubmission: vi.fn(async (_db: unknown, row: { id: string }) => { emitted.calls.push({ event: "email", id: row.id }); return true; }),
}));

import {
  assertMoveInPlan, assertMoveInPlanForActor, cancelMoveInForm, checkMoveInFormAnswers, deleteMoveInFormFile, dispatchMoveInFormsForResidency, dispatchMoveInFormsForSignedLease, editMoveInForm,
  listMoveInForms, moveInFormDetail, moveInFormFileUrl, remindMoveInForm, saveMoveInFormDraft, sendMoveInForm, sendMoveInFormToCurrentResidents,
  submitMoveInForm, uploadMoveInFormFile, uploadMoveInFormTemplatePdf, type MoveInFormActor,
} from "@/lib/move-in-forms/server";
import { MAX_FILES_PER_QUESTION } from "@/lib/move-in-forms/limits";

type Row = Record<string, unknown>;
let forms: Row[];
let applications: Row[];
let properties: Row[];
let leases: Row[];
let profiles: Row[];
let authUsers: Record<string, { email: string; email_confirmed_at: string | null }>;
/** bucket -> path -> bytes */
let objects: Record<string, Map<string, Uint8Array>>;

function builder(table: string) {
  const filters: ((row: Row) => boolean)[] = [];
  let patch: Row | undefined;
  let inserted: Row | undefined;
  let insertError: { code: string } | undefined;
  let from = 0; let to = Infinity;
  let columns = "";
  const rows = () => table === "resident_move_in_forms" ? forms : table === "manager_application_records" ? applications
    : table === "manager_property_records" ? properties : table === "portal_lease_pipeline_records" ? leases : table === "profiles" ? profiles : [];
  const run = () => {
    if (insertError) return { data: null, error: insertError };
    if (inserted) return { data: structuredClone(inserted), error: null };
    const matched = rows().filter((row) => filters.every((f) => f(row))).slice(from, to + 1);
    if (patch) for (const row of matched) Object.assign(row, patch);
    // `propertyApplicationTemplates` is read under the same `templates` alias as the move-in forms, so a
    // select that names it gets the property's `applicationTemplates` instead.
    if (table === "manager_property_records" && columns.includes("propertyApplicationTemplates")) {
      return { data: structuredClone(matched.map((row) => ({ id: row.id, templates: row.applicationTemplates ?? null }))), error: null };
    }
    return { data: structuredClone(matched), error: null };
  };
  const q: Record<string, unknown> = {
    select: (cols?: string) => { columns = cols ?? ""; return q; }, order: () => q,
    eq: (key: string, value: unknown) => { filters.push((row) => row[key] === value); return q; },
    ilike: (key: string, value: string) => { filters.push((row) => String(row[key] ?? "").toLowerCase() === value.toLowerCase()); return q; },
    limit: () => q,
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
const db = {
  from: builder,
  storage,
  auth: { admin: { getUserById: async (id: string) => ({ data: { user: authUsers[id] ?? null }, error: null }) } },
};
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
  planTier.value = "paid";
  emitted.calls = [];
  objects = {};
  forms = [formRow()];
  leases = [];
  profiles = [{ id: "res-a", email: "a@example.test" }];
  authUsers = { "res-a": { email: "a@example.test", email_confirmed_at: "2026-01-01T00:00:00Z" } };
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

  it("keeps the manager's account id out of what a resident reads", async () => {
    const asResident = (await moveInFormDetail(resident(), ID)).form;
    expect(asResident).not.toHaveProperty("managerUserId");
    expect((await listMoveInForms(resident())).forms.every((form) => !("managerUserId" in form))).toBe(true);
    expect((await moveInFormDetail(manager(), ID)).form.managerUserId).toBe("owner");
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
    expect(result).toEqual({ sent: 1, failed: 0 });
    expect(forms.map((row) => row.form_id)).toEqual(["a"]);
    expect(forms[0]).toMatchObject({ status: "sent", resident_email: "a@example.test", room_label: "Room 1", manager_user_id: "owner" });
    expect((forms[0]!.snapshot as { questions: unknown[] }).questions).toHaveLength(1);
    expect(forms[0]!.due_at).toEqual(expect.stringMatching(/^2026-10-10T0[67]:59:59/));
    expect(emitted.calls).toEqual([{ event: "sent", id: forms[0]!.id }]);
  });

  it("is idempotent: a second dispatch sends nothing new", async () => {
    properties[0]!.templates = [enabled("a")];
    await dispatchMoveInFormsForResidency("AXIS-A", "lease-signed", { db: db as never });
    expect(await dispatchMoveInFormsForResidency("AXIS-A", "lease-signed", { db: db as never })).toEqual({ sent: 0, failed: 0 });
    expect(forms).toHaveLength(1);
    expect(emitted.calls).toHaveLength(1);
  });

  it("never re-sends a form the resident already submitted", async () => {
    properties[0]!.templates = [enabled("a")];
    await dispatchMoveInFormsForResidency("AXIS-A", "lease-signed", { db: db as never });
    forms[0]!.status = "submitted";
    expect(await dispatchMoveInFormsForResidency("AXIS-A", "lease-signed", { db: db as never })).toEqual({ sent: 0, failed: 0 });
    expect(forms).toHaveLength(1);
    expect(emitted.calls).toHaveLength(1);
  });

  it("sends again after the manager cancelled the earlier copy", async () => {
    properties[0]!.templates = [enabled("a")];
    await dispatchMoveInFormsForResidency("AXIS-A", "lease-signed", { db: db as never });
    forms[0]!.status = "cancelled";
    expect(await dispatchMoveInFormsForResidency("AXIS-A", "lease-signed", { db: db as never })).toEqual({ sent: 1, failed: 0 });
  });

  it("a property that never saved its forms sends nothing at lease signing; saving the checklist with that trigger sends it", async () => {
    properties[0]!.templates = null;
    expect(await dispatchMoveInFormsForResidency("AXIS-A", "lease-signed", { db: db as never })).toEqual({ sent: 0, failed: 0 });
    expect(forms).toEqual([]);
    const checklist = MOVE_IN_FORM_STARTERS.find((t) => t.starterKey === "move-in-checklist")!;
    expect(checklist.trigger).toBe("lease-signed");
    properties[0]!.templates = [checklist];
    expect(await dispatchMoveInFormsForResidency("AXIS-A", "lease-signed", { db: db as never })).toEqual({ sent: 1, failed: 0 });
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
    expect(await dispatchMoveInFormsForResidency("AXIS-A", "lease-signed", { db: db as never, secondaryMember: true })).toEqual({ sent: 0, failed: 0 });
    expect(await dispatchMoveInFormsForResidency("AXIS-A", "lease-signed", { db: db as never })).toEqual({ sent: 1, failed: 0 });
  });

  it("does nothing for a residency that is not approved, withdrawn, or unknown", async () => {
    properties[0]!.templates = [enabled("a")];
    applications[0]!.app_bucket = "pending";
    expect(await dispatchMoveInFormsForResidency("AXIS-A", "lease-signed", { db: db as never })).toEqual({ sent: 0, failed: 0 });
    applications[0]!.app_bucket = "approved"; applications[0]!.app_withdrawn_at = "2026-10-02";
    expect(await dispatchMoveInFormsForResidency("AXIS-A", "lease-signed", { db: db as never })).toEqual({ sent: 0, failed: 0 });
    expect(await dispatchMoveInFormsForResidency("NOPE", "lease-signed", { db: db as never })).toEqual({ sent: 0, failed: 0 });
    expect(forms).toEqual([]);
  });

  it("skips an upload form whose document is missing or outside the owner's prefix", async () => {
    const pdf = (storagePath: string) => ({ storagePath, fileName: "x.pdf", pageCount: 1, sha256: "a".repeat(64) });
    properties[0]!.templates = [
      enabled("up1", { source: "upload", pdf: pdf(`owner/move-in-forms/up1/1-${UUID}.pdf`) }),
      enabled("up2", { source: "upload", pdf: pdf(`victim/move-in-forms/up2/1-${UUID}.pdf`) }),
    ];
    (objects["lease-templates"] ??= new Map()).set(`victim/move-in-forms/up2/1-${UUID}.pdf`, new Uint8Array([1]));
    expect(await dispatchMoveInFormsForResidency("AXIS-A", "lease-signed", { db: db as never })).toEqual({ sent: 0, failed: 0 });
    (objects["lease-templates"]!).set(`owner/move-in-forms/up1/1-${UUID}.pdf`, new TextEncoder().encode("%PDF-1.4 x"));
    expect(await dispatchMoveInFormsForResidency("AXIS-A", "lease-signed", { db: db as never })).toEqual({ sent: 1, failed: 0 });
    // The fingerprint is recomputed from the stored bytes, never taken from the property JSON.
    expect((forms[0]!.snapshot as { pdf: { sha256: string } }).pdf.sha256).toBe(createHash("sha256").update("%PDF-1.4 x").digest("hex"));
  });

  it("an unreadable bucket is a failure, while a PDF that is simply not there stays a quiet skip", async () => {
    const pdf = (storagePath: string) => ({ storagePath, fileName: "x.pdf", pageCount: 1, sha256: "a".repeat(64) });
    properties[0]!.templates = [enabled("up1", { source: "upload", pdf: pdf(`owner/move-in-forms/up1/1-${UUID}.pdf`) })];
    const outage = { from: () => ({ download: async () => ({ data: null, error: { status: 503, message: "upstream" } }) }) };
    expect(await dispatchMoveInFormsForResidency("AXIS-A", "lease-signed", { db: { from: builder, storage: outage } as never }))
      .toEqual({ sent: 0, failed: 1 });
    expect(await dispatchMoveInFormsForResidency("AXIS-A", "lease-signed", { db: db as never })).toEqual({ sent: 0, failed: 0 });
    expect(forms).toEqual([]);
  });

  it("never throws into the caller, and reports the failure so a retrying caller can see it", async () => {
    const broken = { from: () => { throw new Error("db down"); }, storage };
    await expect(dispatchMoveInFormsForResidency("AXIS-A", "lease-signed", { db: broken as never })).resolves.toEqual({ sent: 0, failed: 1 });
  });

  it("a signed lease reaches the primary signer and joint members through the service client", async () => {
    const { createSupabaseServiceRoleClient } = await import("@/lib/supabase/service");
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(db as never);
    properties[0]!.templates = [enabled("a"), enabled("house", { audience: { kind: "whole-house" } })];
    applications.push({ ...applications[0]!, id: "AXIS-B", resident_email: "b@example.test", app_resident_user_id: "res-b", app_name: "Resident B" });
    await dispatchMoveInFormsForSignedLease(
      { axisId: "AXIS-A", jointLeaseMembers: [{ applicationId: "AXIS-A" }, { applicationId: "AXIS-B" }] },
      { managerUserId: "owner", propertyId: "home" },
    );
    expect(forms.map((row) => `${row.application_id}:${row.form_id}`).sort()).toEqual(["AXIS-A:a", "AXIS-A:house", "AXIS-B:a"]);
  });

  it("never dispatches to a residency the lease's own manager or property does not own", async () => {
    const { createSupabaseServiceRoleClient } = await import("@/lib/supabase/service");
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(db as never);
    properties[0]!.templates = [enabled("a")];
    // A victim manager's residency on the victim's property, named by a forged id in the lease's client-writable row_data.
    properties.push({ id: "victim-home", manager_user_id: "victim", templates: [enabled("a")], settings: null, rooms: [{ id: "r1", name: "Room 1" }], legacy_rooms: null });
    applications.push({ ...applications[0]!, id: "AXIS-VICTIM", manager_user_id: "victim", property_id: "victim-home", app_property_id: "victim-home",
      resident_email: "v@example.test", app_resident_user_id: "res-v", app_name: "Victim" });
    // The same manager's other property: a lease on `home` must not reach it either.
    properties.push({ id: "other-home", manager_user_id: "owner", templates: [enabled("a")], settings: null, rooms: [{ id: "r1", name: "Room 1" }], legacy_rooms: null });
    applications.push({ ...applications[0]!, id: "AXIS-ELSEWHERE", property_id: "other-home", app_property_id: "other-home", resident_email: "e@example.test", app_resident_user_id: "res-e" });

    await dispatchMoveInFormsForSignedLease(
      { axisId: "AXIS-VICTIM", jointLeaseMembers: [{ applicationId: "AXIS-VICTIM" }, { applicationId: "AXIS-ELSEWHERE" }] },
      { managerUserId: "owner", propertyId: "home" },
    );
    expect(forms.map((row) => row.application_id)).toEqual([]);

    // With no manager read from the lease row, nothing is sent at all.
    await dispatchMoveInFormsForSignedLease({ axisId: "AXIS-A" }, { managerUserId: null, propertyId: "home" });
    expect(forms).toEqual([]);

    // The owner's own residency on the lease's property still goes out.
    await dispatchMoveInFormsForSignedLease({ axisId: "AXIS-A" }, { managerUserId: "owner", propertyId: "home" });
    expect(forms.map((row) => row.application_id)).toEqual(["AXIS-A"]);
  });
});

describe("dispatch: intake, links and move-out", () => {
  const send = (trigger: Parameters<typeof dispatchMoveInFormsForResidency>[1], options: { daysUntilLeaseEnd?: number; secondaryMember?: boolean } = {}, id = "AXIS-A") =>
    dispatchMoveInFormsForResidency(id, trigger, { db: db as never, ...options });
  const form = (id: string, extra: Partial<MoveInFormTemplate> = {}): MoveInFormTemplate =>
    ({ ...newMoveInFormTemplate("built"), id, name: id, trigger: "lease-signed", questions: [q("sig", "signature", { required: true })], ...extra });

  beforeEach(() => { forms = []; });

  describe("application-submitted (the Intake form)", () => {
    beforeEach(() => { properties[0]!.templates = [defaultMoveInForm("intake")]; });

    it("sends the Intake form to a PENDING application, with its kind in the snapshot", async () => {
      applications[0]!.app_bucket = "pending";
      expect(await send("application-submitted")).toEqual({ sent: 1, failed: 0 });
      expect(forms.map((row) => row.form_id)).toEqual(["default-intake"]);
      expect(forms[0]).toMatchObject({ status: "sent", resident_email: "a@example.test", manager_user_id: "owner", form_name: "Intake form" });
      expect((forms[0]!.snapshot as { kind: string }).kind).toBe("intake");
      expect(emitted.calls).toEqual([{ event: "sent", id: forms[0]!.id }]);
    });

    it("keeps the in-portal Intake form but sends no notice to an address no confirmed login owns", async () => {
      applications[0]!.app_bucket = "pending";
      // A guest typed a stranger's address: no login holds it.
      applications[0]!.resident_email = "stranger@example.test";
      expect(await send("application-submitted")).toEqual({ sent: 1, failed: 0 });
      expect(forms).toHaveLength(1);
      expect(emitted.calls).toEqual([]);
    });

    it("sends no notice when the login holding the address never confirmed it", async () => {
      applications[0]!.app_bucket = "pending";
      authUsers["res-a"]!.email_confirmed_at = null;
      expect(await send("application-submitted")).toEqual({ sent: 1, failed: 0 });
      expect(forms).toHaveLength(1);
      expect(emitted.calls).toEqual([]);
    });

    it("addresses the notice to the confirmed login, not to the typed row", async () => {
      applications[0]!.app_bucket = "pending";
      applications[0]!.app_resident_user_id = "someone-else";
      await send("application-submitted");
      const { emitMoveInFormEvent } = await import("@/lib/move-in-forms/move-in-form-events.server");
      const input = vi.mocked(emitMoveInFormEvent).mock.calls[0]![1] as unknown as { row: { resident_user_id: string; resident_email: string } };
      expect(input.row).toMatchObject({ resident_user_id: "res-a", resident_email: "a@example.test" });
    });

    it("also sends it to an application that is already approved", async () => {
      expect(await send("application-submitted")).toEqual({ sent: 1, failed: 0 });
    });

    it("does nothing for a withdrawn or declined application", async () => {
      applications[0]!.app_bucket = "pending";
      applications[0]!.app_withdrawn_at = "2026-10-02";
      expect(await send("application-submitted")).toEqual({ sent: 0, failed: 0 });
      applications[0]!.app_withdrawn_at = undefined;
      applications[0]!.app_bucket = "declined";
      expect(await send("application-submitted")).toEqual({ sent: 0, failed: 0 });
      expect(forms).toEqual([]);
    });

    it("is sent once: not again on a second dispatch, nor after the application is approved, nor after it was submitted", async () => {
      applications[0]!.app_bucket = "pending";
      expect(await send("application-submitted")).toEqual({ sent: 1, failed: 0 });
      expect(await send("application-submitted")).toEqual({ sent: 0, failed: 0 });
      applications[0]!.app_bucket = "approved";
      expect(await send("application-submitted")).toEqual({ sent: 0, failed: 0 });
      forms[0]!.status = "submitted";
      expect(await send("application-submitted")).toEqual({ sent: 0, failed: 0 });
      expect(forms).toHaveLength(1);
    });

    it("is not sent by the other triggers, and a pending application does not get a lease-signed form", async () => {
      properties[0]!.templates = [defaultMoveInForm("intake"), form("signed")];
      applications[0]!.app_bucket = "pending";
      expect(await send("lease-signed")).toEqual({ sent: 0, failed: 0 });
      expect(await send("application-approved")).toEqual({ sent: 0, failed: 0 });
      applications[0]!.app_bucket = "approved";
      expect(await send("lease-signed")).toEqual({ sent: 1, failed: 0 });
      expect(forms.map((row) => row.form_id)).toEqual(["signed"]);
    });

    it("counts the due date from the day it was sent (3 days after, end of that Pacific day)", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(new Date("2026-10-05T18:00:00Z"));
        applications[0]!.app_bucket = "pending";
        await send("application-submitted");
        expect(forms[0]!.due_at).toBe("2026-10-09T06:59:59.000Z");
        expect(forms[0]!.due_at).toBe(moveInFormDueFor("3-days-after-sent", { sentAt: new Date("2026-10-05T18:00:00Z") }));
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("never-added and older lists", () => {
    it("a property that never added a form (no moveInFormTemplates key) sends nothing, even for application-submitted", async () => {
      properties[0]!.templates = null;
      applications[0]!.app_bucket = "pending";
      expect(await send("application-submitted")).toEqual({ sent: 0, failed: 0 });
      applications[0]!.app_bucket = "approved";
      expect(await send("lease-signed")).toEqual({ sent: 0, failed: 0 });
      expect(await send("before-move-out", { daysUntilLeaseEnd: 5 })).toEqual({ sent: 0, failed: 0 });
      expect(forms).toEqual([]);
    });

    it("a stored list is the whole truth: no default form is added to it", async () => {
      properties[0]!.templates = [form("mine")];
      applications[0]!.app_bucket = "pending";
      applications[0]!.app_lease_end = "2026-10-20";
      expect(await send("application-submitted")).toEqual({ sent: 0, failed: 0 });
      applications[0]!.app_bucket = "approved";
      expect(await send("before-move-out", { daysUntilLeaseEnd: 3 })).toEqual({ sent: 0, failed: 0 });
      // Only the manager's own form goes out; no Intake, Move-in or Move-out form is added behind it.
      expect(await send("lease-signed")).toEqual({ sent: 1, failed: 0 });
      expect(forms.map((row) => row.form_id)).toEqual(["mine"]);
    });

    it("a form the property does not hold cannot be sent by hand, and one it holds can", async () => {
      properties[0]!.templates = [form("mine")];
      await expect(sendMoveInForm(manager(), { applicationId: "AXIS-A", formId: "default-intake" })).rejects.toMatchObject({ status: 404 });
      const sent = await sendMoveInForm(manager(), { applicationId: "AXIS-A", formId: "mine" });
      expect(sent.form).toMatchObject({ formId: "mine", status: "sent" });
    });

    it("a stored Intake form keeps its own Sends", async () => {
      properties[0]!.templates = [{ ...defaultMoveInForm("intake"), trigger: "application-approved" }];
      applications[0]!.app_bucket = "pending";
      expect(await send("application-submitted")).toEqual({ sent: 0, failed: 0 });
      applications[0]!.app_bucket = "approved";
      expect(await send("application-approved")).toEqual({ sent: 1, failed: 0 });
    });
  });

  describe("linked application", () => {
    beforeEach(() => { applications[0]!.app_template_id = "tplB"; });

    it("a form linked to tplA is not sent to a tplB application, and is sent to a tplA one", async () => {
      properties[0]!.templates = [form("only-a", { linkedApplicationTemplateIds: ["tplA"] })];
      expect(await send("lease-signed")).toEqual({ sent: 0, failed: 0 });
      expect(forms).toEqual([]);
      applications[0]!.app_template_id = "tplA";
      expect(await send("lease-signed")).toEqual({ sent: 1, failed: 0 });
      expect(forms.map((row) => row.form_id)).toEqual(["only-a"]);
    });

    it("an empty linked list means every application", async () => {
      properties[0]!.templates = [form("any", { linkedApplicationTemplateIds: [] })];
      expect(await send("lease-signed")).toEqual({ sent: 1, failed: 0 });
    });

    it("a list with several ids admits any of them", async () => {
      properties[0]!.templates = [form("ab", { linkedApplicationTemplateIds: ["tplA", "tplB"] })];
      expect(await send("lease-signed")).toEqual({ sent: 1, failed: 0 });
    });

    it("an application that recorded no template is never guessed into a linked form", async () => {
      properties[0]!.templates = [form("only-a", { linkedApplicationTemplateIds: ["tplA"] }), form("any")];
      applications[0]!.app_template_id = undefined;
      expect(await send("lease-signed")).toEqual({ sent: 1, failed: 0 });
      expect(forms.map((row) => row.form_id)).toEqual(["any"]);
    });

    it("the link applies to the Intake form on a pending application too", async () => {
      properties[0]!.templates = [{ ...defaultMoveInForm("intake"), linkedApplicationTemplateIds: ["tplA"] }];
      applications[0]!.app_bucket = "pending";
      expect(await send("application-submitted")).toEqual({ sent: 0, failed: 0 });
      applications[0]!.app_template_id = "tplA";
      expect(await send("application-submitted")).toEqual({ sent: 1, failed: 0 });
    });

    it("both links must admit the residency", async () => {
      properties[0]!.templates = [form("both", { linkedApplicationTemplateIds: ["tplB"], linkedLeaseTemplateIds: ["leaseX"] })];
      leases = [{ "row_data->>axisId": "AXIS-A", generated: "leaseX", first: null, voided: null }];
      applications[0]!.app_template_id = "tplA";
      expect(await send("lease-signed")).toEqual({ sent: 0, failed: 0 });
      applications[0]!.app_template_id = "tplB";
      expect(await send("lease-signed")).toEqual({ sent: 1, failed: 0 });
    });
  });

  describe("linked lease", () => {
    beforeEach(() => { properties[0]!.templates = [form("lease-x", { linkedLeaseTemplateIds: ["leaseX"] })]; });
    const lease = (patch: Row = {}): Row => ({ "row_data->>axisId": "AXIS-A", generated: null, first: null, voided: null, ...patch });

    it("matches the lease row's own template, generated or lease-first", async () => {
      leases = [lease({ generated: "leaseY" })];
      expect(await send("lease-signed")).toEqual({ sent: 0, failed: 0 });
      leases = [lease({ generated: "leaseX" })];
      expect(await send("lease-signed")).toEqual({ sent: 1, failed: 0 });
      forms = [];
      leases = [lease({ first: "leaseX" })];
      expect(await send("lease-signed")).toEqual({ sent: 1, failed: 0 });
    });

    it("prefers the generated template over the lease-first one", async () => {
      leases = [lease({ generated: "leaseY", first: "leaseX" })];
      expect(await send("lease-signed")).toEqual({ sent: 0, failed: 0 });
    });

    it("skips a voided lease and reads the live one", async () => {
      leases = [lease({ generated: "leaseX", voided: "2026-10-01" }), lease({ generated: "leaseY" })];
      expect(await send("lease-signed")).toEqual({ sent: 0, failed: 0 });
      leases = [lease({ generated: "leaseY", voided: "2026-10-01" }), lease({ generated: "leaseX" })];
      expect(await send("lease-signed")).toEqual({ sent: 1, failed: 0 });
    });

    it("another residency's lease does not count", async () => {
      leases = [lease({ "row_data->>axisId": "AXIS-Z", generated: "leaseX" })];
      expect(await send("lease-signed")).toEqual({ sent: 0, failed: 0 });
    });

    it("with no lease row, falls back to the lease its application template maps to", async () => {
      applications[0]!.app_template_id = "tplA";
      properties[0]!.applicationTemplates = [{ id: "tplA", linkedLeaseTemplateId: "leaseX" }];
      expect(await send("lease-signed")).toEqual({ sent: 1, failed: 0 });
      forms = [];
      properties[0]!.applicationTemplates = [{ id: "tplA", linkedLeaseTemplateId: "leaseY" }];
      expect(await send("lease-signed")).toEqual({ sent: 0, failed: 0 });
      properties[0]!.applicationTemplates = [{ id: "tplA" }];
      expect(await send("lease-signed")).toEqual({ sent: 0, failed: 0 });
    });

    it("an unknown lease template never matches a linked form", async () => {
      leases = [];
      expect(await send("lease-signed")).toEqual({ sent: 0, failed: 0 });
    });

    it("a form with no lease link sends whatever the lease is", async () => {
      properties[0]!.templates = [form("any")];
      leases = [lease({ generated: "leaseY" })];
      expect(await send("lease-signed")).toEqual({ sent: 1, failed: 0 });
    });
  });

  describe("lease type: only the forms matching the signed lease's type go out", () => {
    const lease = (patch: Row = {}): Row => ({ "row_data->>axisId": "AXIS-A", generated: "leaseLong", first: null, voided: null, ...patch });
    beforeEach(() => {
      properties[0]!.lease_kinds = [
        { id: "leaseLong", kind: "long-term" },
        { id: "leaseShort", kind: "short-term" },
        { id: "leaseCustom", kind: "custom" },
      ];
      properties[0]!.templates = [
        form("all-leases"),
        form("long-only", { leaseType: "long-term" }),
        form("short-only", { leaseType: "short-term" }),
        form("custom-only", { linkedLeaseTemplateIds: ["leaseCustom"] }),
      ];
    });
    const sentIds = () => forms.map((row) => row.form_id).sort();

    it("a Long-term lease gets All and Long-term forms only", async () => {
      leases = [lease({ generated: "leaseLong" })];
      expect(await send("lease-signed")).toEqual({ sent: 2, failed: 0 });
      expect(sentIds()).toEqual(["all-leases", "long-only"]);
    });

    it("a Short-term lease gets All and Short-term forms only", async () => {
      leases = [lease({ generated: "leaseShort" })];
      expect(await send("lease-signed")).toEqual({ sent: 2, failed: 0 });
      expect(sentIds()).toEqual(["all-leases", "short-only"]);
    });

    it("a specific custom lease gets All and the form linked to it, never a Long-term or Short-term form", async () => {
      leases = [lease({ generated: "leaseCustom" })];
      expect(await send("lease-signed")).toEqual({ sent: 2, failed: 0 });
      expect(sentIds()).toEqual(["all-leases", "custom-only"]);
    });

    it("with no lease template known the application's rental type decides", async () => {
      leases = [];
      applications[0]!.app_rental_type = "short_term";
      expect(await send("lease-signed")).toEqual({ sent: 2, failed: 0 });
      expect(sentIds()).toEqual(["all-leases", "short-only"]);
      forms = [];
      applications[0]!.app_rental_type = "standard";
      expect(await send("lease-signed")).toEqual({ sent: 2, failed: 0 });
      expect(sentIds()).toEqual(["all-leases", "long-only"]);
    });

    it("an unknown lease type is never guessed into a restricted form; All still goes out", async () => {
      leases = [];
      applications[0]!.app_rental_type = undefined;
      expect(await send("lease-signed")).toEqual({ sent: 1, failed: 0 });
      expect(sentIds()).toEqual(["all-leases"]);
    });

    it("a form with no lease type defaults to All", async () => {
      leases = [lease({ generated: "leaseShort" })];
      properties[0]!.templates = [form("plain")];
      expect(await send("lease-signed")).toEqual({ sent: 1, failed: 0 });
    });
  });

  describe("sending to current residents respects the links", () => {
    it("skips residents on another application template and sends to the linked one", async () => {
      properties[0]!.templates = [form("only-a", { linkedApplicationTemplateIds: ["tplA"] })];
      applications[0]!.app_template_id = "tplB";
      applications.push({ ...applications[0]!, id: "AXIS-B", resident_email: "b@example.test", app_resident_user_id: "res-b", app_name: "Resident B", app_template_id: "tplA" });
      leases = [
        { manager_user_id: "owner", property_id: "home", axis_id: "AXIS-A", signed: "2026-10-01", voided: null, members: null },
        { manager_user_id: "owner", property_id: "home", axis_id: "AXIS-B", signed: "2026-10-01", voided: null, members: null },
      ];
      expect(await sendMoveInFormToCurrentResidents(manager(), { propertyId: "home", formId: "only-a" })).toEqual({ sent: 1 });
      expect(forms.map((row) => `${row.application_id}:${row.form_id}`)).toEqual(["AXIS-B:only-a"]);
    });
  });

  describe("before-move-out", () => {
    const moveOut = (days: 7 | 14 | 30 = 14, extra: Partial<MoveInFormTemplate> = {}): MoveInFormTemplate =>
      ({ ...defaultMoveInForm("move-out"), moveOutDaysBefore: days, ...extra });
    beforeEach(() => {
      properties[0]!.templates = [moveOut()];
      applications[0]!.app_lease_end = "2026-10-20";
    });

    it("is sent once the lease is within N days of ending, and not before", async () => {
      expect(await send("before-move-out", { daysUntilLeaseEnd: 15 })).toEqual({ sent: 0, failed: 0 });
      expect(await send("before-move-out", { daysUntilLeaseEnd: 30 })).toEqual({ sent: 0, failed: 0 });
      expect(forms).toEqual([]);
      expect(await send("before-move-out", { daysUntilLeaseEnd: 14 })).toEqual({ sent: 1, failed: 0 });
      expect(forms.map((row) => row.form_id)).toEqual(["default-move-out"]);
      expect((forms[0]!.snapshot as { kind: string }).kind).toBe("move-out");
    });

    it("is sent on every day inside the window up to the last day, but not the day after the lease ended", async () => {
      for (const days of [14, 7, 1, 0]) {
        forms = [];
        expect(await send("before-move-out", { daysUntilLeaseEnd: days })).toEqual({ sent: 1, failed: 0 });
      }
      forms = [];
      expect(await send("before-move-out", { daysUntilLeaseEnd: -1 })).toEqual({ sent: 0, failed: 0 });
      expect(await send("before-move-out", { daysUntilLeaseEnd: -30 })).toEqual({ sent: 0, failed: 0 });
      expect(forms).toEqual([]);
    });

    it("sends nothing when the caller says nothing about how long the lease has left", async () => {
      expect(await send("before-move-out")).toEqual({ sent: 0, failed: 0 });
    });

    it("follows each form's own window: 7, 14 or 30 days", async () => {
      properties[0]!.templates = [moveOut(7, { id: "w7", name: "w7" }), moveOut(30, { id: "w30", name: "w30" })];
      expect(await send("before-move-out", { daysUntilLeaseEnd: 20 })).toEqual({ sent: 1, failed: 0 });
      expect(forms.map((row) => row.form_id)).toEqual(["w30"]);
      expect(await send("before-move-out", { daysUntilLeaseEnd: 7 })).toEqual({ sent: 1, failed: 0 });
      expect(forms.map((row) => row.form_id)).toEqual(["w30", "w7"]);
    });

    it("is idempotent and never re-sent to a resident who finished it", async () => {
      expect(await send("before-move-out", { daysUntilLeaseEnd: 10 })).toEqual({ sent: 1, failed: 0 });
      expect(await send("before-move-out", { daysUntilLeaseEnd: 9 })).toEqual({ sent: 0, failed: 0 });
      forms[0]!.status = "submitted";
      expect(await send("before-move-out", { daysUntilLeaseEnd: 8 })).toEqual({ sent: 0, failed: 0 });
      expect(forms).toHaveLength(1);
    });

    it("needs an approved residency", async () => {
      applications[0]!.app_bucket = "pending";
      expect(await send("before-move-out", { daysUntilLeaseEnd: 5 })).toEqual({ sent: 0, failed: 0 });
    });

    it("the days window does not hold back other triggers", async () => {
      properties[0]!.templates = [moveOut(), form("signed")];
      expect(await send("lease-signed")).toEqual({ sent: 1, failed: 0 });
      expect(forms.map((row) => row.form_id)).toEqual(["signed"]);
    });

    it("due is anchored on the lease end: the default move-out form is due at the end of the Pacific day of lease end", async () => {
      await send("before-move-out", { daysUntilLeaseEnd: 10 });
      // 2026-10-20 is daylight time (UTC-7): 23:59:59 there is 06:59:59Z the next day.
      expect(forms[0]!.due_at).toBe("2026-10-21T06:59:59.000Z");
      // The move-in date (2026-10-10) is not the anchor.
      expect(forms[0]!.due_at).not.toBe(moveInFormDueFor("move-in-day", { moveInDate: "2026-10-10" }));
    });

    it("due follows the lease end across the daylight-time change (standard time is UTC-8)", async () => {
      applications[0]!.app_lease_end = "2027-01-15";
      await send("before-move-out", { daysUntilLeaseEnd: 10 });
      expect(forms[0]!.due_at).toBe("2027-01-16T07:59:59.000Z");
    });

    it("the days-before-move-out rules count back from the lease end", async () => {
      properties[0]!.templates = [moveOut(14, { due: "7-days-before-move-out" })];
      await send("before-move-out", { daysUntilLeaseEnd: 10 });
      expect(forms[0]!.due_at).toBe("2026-10-14T06:59:59.000Z");
      forms = [];
      properties[0]!.templates = [moveOut(14, { due: "3-days-before-move-out" })];
      await send("before-move-out", { daysUntilLeaseEnd: 10 });
      expect(forms[0]!.due_at).toBe("2026-10-18T06:59:59.000Z");
    });

    it("an unknown lease end leaves the move-out form with no due date, but still sends it", async () => {
      applications[0]!.app_lease_end = "";
      expect(await send("before-move-out", { daysUntilLeaseEnd: 10 })).toEqual({ sent: 1, failed: 0 });
      expect(forms[0]!.due_at).toBeNull();
    });

    it("a lease-end anchored rule falls back to nothing, not the move-in date", async () => {
      expect(moveInFormDueFor("move-out-day", { moveInDate: "2026-10-10" })).toBeNull();
    });

    it("a roommate does not get a whole-house move-out form, the primary does", async () => {
      properties[0]!.templates = [moveOut(14, { audience: { kind: "whole-house" } })];
      expect(await send("before-move-out", { daysUntilLeaseEnd: 5, secondaryMember: true })).toEqual({ sent: 0, failed: 0 });
      expect(await send("before-move-out", { daysUntilLeaseEnd: 5 })).toEqual({ sent: 1, failed: 0 });
    });
  });
});

describe("plan gate: move-in is Pro and Business, in the API and in auto-dispatch", () => {
  it("refuses every manager call from a Free manager with a 402, and lets a paid or unknown plan through", async () => {
    planTier.value = "free";
    await expect(assertMoveInPlanForActor(manager())).rejects.toMatchObject({ status: 402 });
    await expect(assertMoveInPlan("owner")).rejects.toMatchObject({ status: 402 });
    planTier.value = "paid";
    await expect(assertMoveInPlanForActor(manager())).resolves.toBeUndefined();
    planTier.value = null;
    await expect(assertMoveInPlanForActor(manager())).resolves.toBeUndefined();
  });

  it("never gates a resident, who answers a form that was already sent to them", async () => {
    planTier.value = "free";
    await expect(assertMoveInPlanForActor(resident())).resolves.toBeUndefined();
  });

  it("does not send a form on its own for a Free owner", async () => {
    forms = [];
    properties[0]!.templates = [{ ...newMoveInFormTemplate("built"), id: "auto", name: "auto", trigger: "lease-signed", questions: [q("sig", "signature", { required: true })] }];
    planTier.value = "free";
    expect(await dispatchMoveInFormsForResidency("AXIS-A", "lease-signed", { db: db as never })).toEqual({ sent: 0, failed: 0 });
    expect(forms).toEqual([]);
    planTier.value = "paid";
    expect(await dispatchMoveInFormsForResidency("AXIS-A", "lease-signed", { db: db as never })).toEqual({ sent: 1, failed: 0 });
  });
});

describe("manager edit of a pending form (PATCH /api/move-in-forms/:id)", () => {
  it("edits the due date, what it blocks and the questions on a sent copy, and drops answers to removed questions", async () => {
    forms = [formRow({ answers: [{ key: "name", value: "A" }, { key: "pet", value: "no" }] })];
    const { form } = await editMoveInForm(manager(), ID, {
      dueAt: "2026-10-20T06:59:59.000Z",
      blocks: "lease_signing",
      questions: [q("name", "text", { required: true }), q("sig", "signature", { required: true })],
    });
    expect(form.dueAt).toBe("2026-10-20T06:59:59.000Z");
    expect(form.snapshot.blocks).toBe("lease_signing");
    expect(form.snapshot.questions.map((item) => item.key)).toEqual(["name", "sig"]);
    expect(forms[0]!.answers).toEqual([{ key: "name", value: "A" }]);
    expect(forms[0]!.status).toBe("sent");
  });

  it("drops the stored photo and signature of a question it removed, so nothing is orphaned in the bucket", async () => {
    stored();
    forms = [formRow({ answers: [photoAnswer(), sigAnswer()] })];
    await editMoveInForm(manager(), ID, { questions: [q("sig", "signature", { required: true })] });
    expect(forms[0]!.answers).toEqual([sigAnswer()]);
    expect(objects["move-in-form-files"]!.has(`${ID}/room_photos/${UUID}.jpg`)).toBe(false);
    // The surviving question's own file is untouched.
    expect(objects["move-in-form-files"]!.has(`${ID}/sig/${UUID}.png`)).toBe(true);
  });

  it("never touches a surviving question's objects — a photo uploaded seconds ago has no saved answer yet", async () => {
    stored();
    const justUploaded = `${ID}/room_photos/${"b".repeat(8)}-0000-4000-8000-000000000000.jpg`;
    objects["move-in-form-files"]!.set(justUploaded, new Uint8Array([2]));
    // The resident's debounced draft has not landed, so no answer references either photo yet.
    forms = [formRow({ answers: [] })];
    await editMoveInForm(manager(), ID, {
      questions: [q("room_photos", "photos", { required: true }), q("sig", "signature", { required: true })],
    });
    expect(objects["move-in-form-files"]!.has(justUploaded)).toBe(true);
    expect(objects["move-in-form-files"]!.has(`${ID}/room_photos/${UUID}.jpg`)).toBe(true);
    expect(objects["move-in-form-files"]!.has(`${ID}/sig/${UUID}.png`)).toBe(true);
  });

  it("re-derives ownership from the signed-in manager: another manager, and a resident, get a 404 and nothing changes", async () => {
    await expect(editMoveInForm(manager("other-owner"), ID, { blocks: "approval" })).rejects.toMatchObject({ status: 404 });
    await expect(editMoveInForm(resident(), ID, { blocks: "approval" })).rejects.toMatchObject({ status: 404 });
    expect((forms[0]!.snapshot as { blocks?: string }).blocks).toBeUndefined();
  });

  it("lets a co-manager with edit access edit, like remind and cancel", async () => {
    const { form } = await editMoveInForm(manager("co-manager"), ID, { blocks: "approval" });
    expect(form.snapshot.blocks).toBe("approval");
  });

  it("answers 409 once the form is submitted or cancelled, and leaves it untouched", async () => {
    forms = [formRow({ status: "submitted", submitted_at: "2026-10-02T00:00:00Z" })];
    await expect(editMoveInForm(manager(), ID, { blocks: "approval", dueAt: null })).rejects.toMatchObject({ status: 409 });
    expect(forms[0]!.due_at).toBeNull();
    expect((forms[0]!.snapshot as { blocks?: string }).blocks).toBeUndefined();
    forms = [formRow({ status: "cancelled" })];
    await expect(editMoveInForm(manager(), ID, { blocks: "approval" })).rejects.toMatchObject({ status: 409 });
  });

  it("refuses a body that names an id, a status or an owner, and a block value it does not know", async () => {
    await expect(editMoveInForm(manager(), ID, { status: "submitted" })).rejects.toThrow();
    await expect(editMoveInForm(manager(), ID, { managerUserId: "someone-else" })).rejects.toThrow();
    await expect(editMoveInForm(manager(), ID, { blocks: "everything" })).rejects.toThrow();
    expect(forms[0]!.status).toBe("sent");
    expect(forms[0]!.manager_user_id).toBe("owner");
  });

  it("will not strip an upload form's signature or empty a built form", async () => {
    await expect(editMoveInForm(manager(), ID, { questions: [] })).rejects.toMatchObject({ status: 400 });
    forms = [formRow({ source: "upload" })];
    await expect(editMoveInForm(manager(), ID, { questions: [q("name", "text")] })).rejects.toMatchObject({ status: 400 });
  });
});

describe("a sent copy carries what its template blocks", () => {
  it("copies the template's blocks into the snapshot, and an intake form defaults to Move-in details", async () => {
    forms = [];
    properties[0]!.templates = [
      { ...newMoveInFormTemplate("built"), id: "f1", name: "Pets", blocks: "approval", questions: [q("sig", "signature", { required: true })] },
      { ...defaultMoveInForm("intake"), id: "default-intake" },
      { ...newMoveInFormTemplate("built"), id: "f3", name: "Key", questions: [q("sig", "signature", { required: true })] },
    ];
    await sendMoveInForm(manager(), { applicationId: "AXIS-A", formId: "f1" });
    await sendMoveInForm(manager(), { applicationId: "AXIS-A", formId: "default-intake" });
    await sendMoveInForm(manager(), { applicationId: "AXIS-A", formId: "f3" });
    const blocks = Object.fromEntries(forms.map((row) => [row.form_id, (row.snapshot as { blocks?: string }).blocks]));
    expect(blocks).toEqual({ f1: "approval", "default-intake": "move_in_details", f3: "nothing" });
  });

  it("editing the template afterwards never changes a copy already sent", async () => {
    forms = [];
    properties[0]!.templates = [{ ...newMoveInFormTemplate("built"), id: "f1", name: "Pets", blocks: "lease_signing", questions: [q("sig", "signature", { required: true })] }];
    await sendMoveInForm(manager(), { applicationId: "AXIS-A", formId: "f1" });
    properties[0]!.templates = [{ ...(properties[0]!.templates as MoveInFormTemplate[])[0]!, blocks: "nothing" }];
    expect((forms[0]!.snapshot as { blocks?: string }).blocks).toBe("lease_signing");
  });
});
