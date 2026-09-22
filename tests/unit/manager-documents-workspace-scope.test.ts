import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabaseClient, type Row } from "./helpers/fake-supabase-tables";

/**
 * The manager Document Library merged every workspace's documents into one
 * list, including manager-level (no property) library docs like lease
 * templates and portfolio policies. The expiration-summary roll-up used the
 * exact same unscoped query, so it could disagree with what the (now scoped)
 * list shows — and the signed-URL mint route had no workspace check at all,
 * so a document outside the active workspace was still downloadable by id.
 * These fail against pre-fix `manager-documents/route.ts`,
 * `expiration-summary/route.ts`, and `[id]/signed-url/route.ts`
 * (`.eq("manager_user_id", …)` alone on every one of them).
 */

const state = vi.hoisted(() => ({ cookieValue: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ get: () => (state.cookieValue !== undefined ? { value: state.cookieValue } : undefined) })),
}));

const mocks = vi.hoisted(() => ({ loadWorkspaces: vi.fn(), linkedPropertyIdsForModule: vi.fn(async () => new Set<string>()) }));
vi.mock("@/lib/workspaces/server", () => ({ loadWorkspaces: mocks.loadWorkspaces }));
vi.mock("@/lib/auth/co-manager-module-scope", () => ({ linkedPropertyIdsForModule: mocks.linkedPropertyIdsForModule }));

const authState = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/reports/auth", () => ({
  getReportsAuthContext: vi.fn(async () => ({ userId: "mgr-1", email: "mgr@example.com", db: authState.db })),
  assertManagerFinancialsAccess: vi.fn(async () => ({ ok: true })),
}));

import { GET as listDocuments } from "@/app/api/manager-documents/route";
import { GET as expirationSummary } from "@/app/api/manager-documents/expiration-summary/route";
import { GET as signedUrl } from "@/app/api/manager-documents/[id]/signed-url/route";

vi.mock("@/lib/documents/document-signed-url.server", () => ({
  createManagerDocumentSignedUrl: vi.fn(async () => ({ signedUrl: "https://storage.example/signed" })),
  resolveDownloadName: () => "download.pdf",
}));

const MANAGER = "mgr-1";
const WS_A = { id: "ws-a", name: "A", ownerUserId: MANAGER, owned: true, isDefault: true, propertyIds: ["p1"] };
const WS_B = { id: "ws-b", name: "B", ownerUserId: MANAGER, owned: true, isDefault: false, propertyIds: ["p2"] };
const WS_EMPTY = { id: "ws-empty", name: "Empty", ownerUserId: MANAGER, owned: true, isDefault: false, propertyIds: [] };

function docRow(id: string, propertyId: string | null, overrides: Row = {}) {
  return {
    id,
    manager_user_id: MANAGER,
    display_name: `Doc ${id}`,
    original_filename: null,
    mime_type: "application/pdf",
    size_bytes: 100,
    checksum: null,
    storage_path: `manager/${MANAGER}/${id}.pdf`,
    category: "other",
    property_id: propertyId,
    unit_label: null,
    lease_id: null,
    resident_user_id: null,
    resident_email: null,
    vendor_id: null,
    work_order_id: null,
    visibility: "manager",
    expires_at: null,
    superseded_by_document_id: null,
    signature_status: null,
    signature_requested_at: null,
    signed_at: null,
    uploaded_by: MANAGER,
    deleted_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function setup(rows: Row[]) {
  const db = fakeSupabaseClient({ manager_documents: rows });
  authState.db = db;
  return db;
}

beforeEach(() => {
  state.cookieValue = undefined;
  mocks.loadWorkspaces.mockReset();
  mocks.linkedPropertyIdsForModule.mockReset();
  mocks.linkedPropertyIdsForModule.mockResolvedValue(new Set());
});

async function json(res: Response) {
  return res.json() as Promise<Record<string, unknown>>;
}

describe("GET /api/manager-documents — active-workspace scoping", () => {
  it("a manager with two workspaces sees only workspace A's documents while A is active", async () => {
    mocks.loadWorkspaces.mockResolvedValue([WS_A, WS_B]);
    state.cookieValue = WS_A.id;
    setup([docRow("d-a", "p1"), docRow("d-b", "p2")]);
    const body = await json(await listDocuments(new Request("http://localhost/api/manager-documents")));
    expect((body.documents as Array<{ id: string }>).map((d) => d.id)).toEqual(["d-a"]);
  });

  it("switching to workspace B shows only B's documents", async () => {
    mocks.loadWorkspaces.mockResolvedValue([WS_A, WS_B]);
    state.cookieValue = WS_B.id;
    setup([docRow("d-a", "p1"), docRow("d-b", "p2")]);
    const body = await json(await listDocuments(new Request("http://localhost/api/manager-documents")));
    expect((body.documents as Array<{ id: string }>).map((d) => d.id)).toEqual(["d-b"]);
  });

  it("an empty active workspace yields no property-tied documents", async () => {
    mocks.loadWorkspaces.mockResolvedValue([WS_A, WS_EMPTY]);
    state.cookieValue = WS_EMPTY.id;
    setup([docRow("d-a", "p1")]);
    const body = await json(await listDocuments(new Request("http://localhost/api/manager-documents")));
    expect(body.documents).toEqual([]);
  });

  it("a single-workspace manager is unaffected", async () => {
    mocks.loadWorkspaces.mockResolvedValue([WS_A]);
    setup([docRow("d-a", "p1")]);
    const body = await json(await listDocuments(new Request("http://localhost/api/manager-documents")));
    expect((body.documents as Array<{ id: string }>).map((d) => d.id)).toEqual(["d-a"]);
  });

  it("a manager-level document (no property at all) follows the default-workspace rule", async () => {
    mocks.loadWorkspaces.mockResolvedValue([WS_A, WS_B]);

    state.cookieValue = WS_A.id; // A is the owned default
    setup([docRow("d-portfolio", null)]);
    expect(((await json(await listDocuments(new Request("http://localhost/api/manager-documents")))).documents as Array<{ id: string }>).map((d) => d.id)).toEqual(["d-portfolio"]);

    state.cookieValue = WS_B.id; // B is not the default
    setup([docRow("d-portfolio", null)]);
    expect((await json(await listDocuments(new Request("http://localhost/api/manager-documents")))).documents).toEqual([]);
  });

  it("scope=manager (the explicit manager-level filter) is empty outside the default workspace", async () => {
    mocks.loadWorkspaces.mockResolvedValue([WS_A, WS_B]);
    state.cookieValue = WS_B.id;
    setup([docRow("d-portfolio", null)]);
    const body = await json(await listDocuments(new Request("http://localhost/api/manager-documents?scope=manager")));
    expect(body.documents).toEqual([]);
  });

  it("a co-manager's linked (other owner's) documents narrow to the active workspace's houses too", async () => {
    mocks.loadWorkspaces.mockResolvedValue([WS_A, WS_B]);
    mocks.linkedPropertyIdsForModule.mockResolvedValue(new Set(["p1", "p2"]));
    state.cookieValue = WS_A.id;
    setup([
      { ...docRow("linked-p1", "p1"), manager_user_id: "owner-2" },
      { ...docRow("linked-p2", "p2"), manager_user_id: "owner-2" },
    ]);
    const body = await json(await listDocuments(new Request("http://localhost/api/manager-documents")));
    expect((body.documents as Array<{ id: string }>).map((d) => d.id)).toEqual(["linked-p1"]);
  });
});

describe("GET /api/manager-documents/expiration-summary — matches the (now scoped) list", () => {
  it("counts only the active workspace's expiring documents, same as the list", async () => {
    mocks.loadWorkspaces.mockResolvedValue([WS_A, WS_B]);
    state.cookieValue = WS_A.id;
    const soon = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    setup([docRow("d-a", "p1", { expires_at: soon }), docRow("d-b", "p2", { expires_at: soon })]);
    const body = await json(await expirationSummary());
    const summary = body.summary as { within30: number };
    expect(summary.within30).toBe(1);
  });
});

describe("GET /api/manager-documents/[id]/signed-url — active-workspace guard", () => {
  function req(id: string) {
    return new Request(`http://localhost/api/manager-documents/${id}/signed-url`);
  }
  function ctx(id: string) {
    return { params: Promise.resolve({ id }) };
  }

  const DOC_ID = "11111111-1111-1111-1111-111111111111";

  it("refuses to mint a signed URL for a document outside the active workspace", async () => {
    mocks.loadWorkspaces.mockResolvedValue([WS_A, WS_B]);
    state.cookieValue = WS_A.id;
    setup([docRow(DOC_ID, "p2")]);
    const res = await signedUrl(req(DOC_ID), ctx(DOC_ID));
    expect(res.status).toBe(404);
  });

  it("mints a signed URL for a document inside the active workspace", async () => {
    mocks.loadWorkspaces.mockResolvedValue([WS_A, WS_B]);
    state.cookieValue = WS_A.id;
    setup([docRow(DOC_ID, "p1")]);
    const res = await signedUrl(req(DOC_ID), ctx(DOC_ID));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.url).toBe("https://storage.example/signed");
  });

  it("refuses to mint a signed URL for a manager-level document outside the default workspace", async () => {
    mocks.loadWorkspaces.mockResolvedValue([WS_A, WS_B]);
    state.cookieValue = WS_B.id;
    setup([docRow(DOC_ID, null)]);
    const res = await signedUrl(req(DOC_ID), ctx(DOC_ID));
    expect(res.status).toBe(404);
  });
});
