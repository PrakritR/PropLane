import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({
  manager: true as boolean, resident: true as boolean, calls: [] as string[],
  record: null as unknown,
}));
vi.mock("@/lib/tools/context", () => ({ resolveAgentContext: vi.fn(async () => (state.manager ? { userId: "m", db: {} } : null)) }));
vi.mock("@/lib/tools/resident-context", () => ({ resolveResidentAgentContext: vi.fn(async () => (state.resident ? { userId: "r", email: "r@x.test", db: {} } : null)) }));
vi.mock("@/lib/move-in-forms/server", () => {
  class MoveInFormError extends Error { constructor(message: string, readonly status = 400) { super(message); } }
  const note = (name: string, value: unknown = { ok: true }) => vi.fn(async (...args: unknown[]) => { state.calls.push(`${name}:${args.slice(1).map((a) => typeof a === "string" ? a : "").join(",")}`); return value; });
  return {
    MoveInFormError,
    MOVE_IN_FORM_FILES_BUCKET: "move-in-form-files",
    getMoveInFormForExport: vi.fn(async () => state.record),
    listMoveInForms: note("list", { forms: [], unread: 0 }), moveInFormDetail: note("detail", { form: {} }),
    moveInFormFileUrl: note("file", "https://signed.example/x"), moveInFormRecordPdf: note("recordPdf", { bytes: new Uint8Array([37]), fileName: "a.pdf" }),
    moveInFormTemplatePdf: note("templatePdf", { bytes: new Uint8Array([37]), fileName: "a.pdf" }),
    remindMoveInForm: note("remind"), cancelMoveInForm: note("cancel"), saveMoveInFormDraft: note("save", { form: {} }),
    sendMoveInForm: note("send", { form: {} }), sendMoveInFormToCurrentResidents: note("sendExisting", { sent: 0 }),
    submitMoveInForm: note("submit", { form: {} }), uploadMoveInFormFile: note("upload", { storagePath: "p" }),
    uploadMoveInFormTemplatePdf: note("uploadPdf", { pdf: {} }),
  };
});

import { GET, PATCH, POST } from "@/app/api/move-in-forms/[[...path]]/route";
import { moveInFormPdf } from "@/lib/move-in-forms/pdf";

const ID = "11111111-1111-4111-8111-111111111111";
const call = (handler: typeof GET, path: string[], portal: string, init: { method?: string; origin?: string | null; body?: unknown; query?: string } = {}) => {
  const url = `https://app.test/api/move-in-forms/${path.join("/")}?portal=${portal}${init.query ?? ""}`;
  const headers = new Headers({ host: "app.test" });
  if (init.origin !== null && init.method && init.method !== "GET") headers.set("origin", init.origin ?? "https://app.test");
  const req = new NextRequest(url, { method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  return handler(req, { params: Promise.resolve({ path }) });
};

beforeEach(() => { state.manager = true; state.resident = true; state.calls = []; state.record = null; vi.clearAllMocks(); });

describe("move-in forms route", () => {
  it("sets private no-store headers and requires a signed-in portal", async () => {
    const ok = await call(GET, [], "manager");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("private, no-store");
    state.manager = false;
    expect((await call(GET, [], "manager")).status).toBe(401);
    expect((await call(GET, [], "bogus")).status).toBe(400);
  });

  it("refuses a cross-origin or originless write before doing any work", async () => {
    for (const origin of ["https://evil.test", null]) {
      const res = await call(POST, ["send"], "manager", { method: "POST", origin, body: {} });
      expect(res.status).toBe(403);
    }
    expect(state.calls).toEqual([]);
  });

  it("keeps the two portals' routes apart", async () => {
    expect((await call(GET, ["mine"], "manager")).status).toBe(404);
    expect((await call(GET, [ID], "resident")).status).toBe(404);
    expect((await call(POST, ["send"], "resident", { method: "POST", body: {} })).status).toBe(404);
    expect((await call(POST, [ID, "remind"], "resident", { method: "POST", body: {} })).status).toBe(404);
    expect(state.calls).toEqual([]);
  });

  it("routes the manager and resident calls the client makes", async () => {
    expect((await call(POST, ["send"], "manager", { method: "POST", body: {} })).status).toBe(201);
    expect((await call(POST, ["send-existing"], "manager", { method: "POST", body: {} })).status).toBe(200);
    expect((await call(POST, [ID, "remind"], "manager", { method: "POST", body: {} })).status).toBe(200);
    expect((await call(POST, [ID, "cancel"], "manager", { method: "POST", body: {} })).status).toBe(200);
    expect((await call(GET, [ID], "manager")).status).toBe(200);
    expect((await call(GET, ["mine"], "resident")).status).toBe(200);
    expect((await call(GET, ["mine", ID], "resident")).status).toBe(200);
    expect((await call(PATCH, ["mine", ID], "resident", { method: "PATCH", body: { answers: [] } })).status).toBe(200);
    expect((await call(POST, ["mine", ID, "submit"], "resident", { method: "POST", body: { answers: [] } })).status).toBe(200);
    expect(state.calls.map((c) => c.split(":")[0])).toEqual(["send", "sendExisting", "remind", "cancel", "detail", "list", "detail", "save", "submit"]);
  });

  it("rejects a non-uuid id as a 400 and unknown shapes as 404", async () => {
    expect((await call(GET, ["not-a-uuid"], "manager")).status).toBe(400);
    expect((await call(GET, [ID, "nope"], "manager")).status).toBe(404);
    expect((await call(GET, ["mine", ID, "nope"], "resident")).status).toBe(404);
  });

  it("answers a file request with a private redirect, and serves originals sandboxed and never sniffed", async () => {
    const file = await call(GET, [ID, "file"], "manager", { query: `&path=${ID}/k/x.jpg` });
    expect(file.status).toBe(302);
    expect(file.headers.get("location")).toBe("https://signed.example/x");
    expect(file.headers.get("cache-control")).toBe("private, no-store");
    expect((await call(GET, [ID, "file"], "manager")).status).toBe(400);
    const original = await call(GET, ["template-pdf"], "manager", { query: "&propertyId=p&formId=f" });
    expect(original.headers.get("content-type")).toBe("application/pdf");
    expect(original.headers.get("x-content-type-options")).toBe("nosniff");
    expect(original.headers.get("content-security-policy")).toBe("sandbox");
  });
});

describe("moveInFormPdf", () => {
  const record = (status: string) => ({
    id: ID, applicationId: "AXIS-A", formName: "Checklist", residentName: "Resident A", propertyLabel: "12 Elm", roomLabel: "Room 1",
    status, submittedAt: "2026-10-02T00:00:00Z", sentAt: "2026-10-01T00:00:00Z", dueAt: null, signedDocumentSha256: null,
    snapshot: { pdf: null, questions: [
      { id: "1", key: "name", label: "Your name", type: "text", required: true, options: [], section: "About you" },
      { id: "2", key: "hidden", label: "Hidden one", type: "text", required: false, options: [], showIf: { fieldKey: "x", equals: "y" } },
      { id: "3", key: "pet", label: "Pet?", type: "yes_no", required: false, options: [] },
    ] },
    answers: [{ key: "name", value: "Résumé ünïcode" }, { key: "pet", value: true }],
  });

  it("renders a submitted form and refuses an unsubmitted one", async () => {
    state.record = record("submitted");
    const bytes = await moveInFormPdf({ role: "manager", context: { db: { storage: { from: () => ({}) } } } } as never, ID);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
    state.record = record("sent");
    await expect(moveInFormPdf({ role: "manager", context: { db: {} } } as never, ID)).rejects.toMatchObject({ status: 409 });
  });
});
