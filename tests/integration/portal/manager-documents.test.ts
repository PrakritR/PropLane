import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonRequest, parseJsonResponse } from "../../helpers/api-request";

// The document routes gate on getReportsAuthContext + assertManagerFinancialsAccess.
// We mock the auth layer directly so the tests exercise the routes' own
// ownership/validation logic rather than the auth internals.
// The route resolves the active workspace's row scope; a failed load now fails closed (503).
// This file's minimal DB mock cannot serve that load, so the viewer has no workspaces
// (scope does not narrow) — workspace narrowing is covered by its own tests.
vi.mock("@/lib/workspaces/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspaces/server")>()),
  loadWorkspaces: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/reports/auth", () => ({
  getReportsAuthContext: vi.fn(),
  assertManagerFinancialsAccess: vi.fn(),
}));
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));

import { getReportsAuthContext, assertManagerFinancialsAccess } from "@/lib/reports/auth";
import { GET as LIST, POST as UPLOAD } from "@/app/api/manager-documents/route";
import { PATCH as RENAME, DELETE as SOFT_DELETE } from "@/app/api/manager-documents/[id]/route";
import { GET as SIGNED_URL } from "@/app/api/manager-documents/[id]/signed-url/route";

type DocRow = {
  id: string;
  manager_user_id: string;
  storage_path: string;
  display_name: string;
  original_filename?: string | null;
  mime_type: string;
  deleted_at: string | null;
};

// The [id] routes 404 on non-UUID ids before touching the DB, so test rows use
// a real UUID.
const DOC_ID = "11111111-1111-4111-8111-111111111111";

/**
 * A minimal Supabase-shaped mock. The [id] routes fetch the row by id only and
 * enforce ownership in code (owner short-circuit in
 * assertManagerDocumentsCoManagerAccess), so single-row lookups match on id +
 * live status; the list query still scopes by manager_user_id.
 */
function mockDb(rows: DocRow[]) {
  const removed: string[][] = [];
  const signed: { path: string; options?: { download?: string | boolean } }[] = [];
  const inserted: Record<string, unknown>[] = [];
  const uploaded: string[] = [];

  function tableApi() {
    const filters: Record<string, unknown> = {};
    const builder: Record<string, unknown> = {
      select: () => builder,
      order: () => builder,
      limit: () => builder,
      is: (col: string, val: unknown) => {
        filters[col] = val;
        return builder;
      },
      not: () => builder,
      ilike: () => builder,
      eq: (col: string, val: unknown) => {
        filters[col] = val;
        return builder;
      },
      insert: (row: Record<string, unknown>) => {
        inserted.push(row);
        return {
          select: () => ({
            single: async () => ({
              data: { ...row, id: "new-doc", created_at: "2026-07-07T00:00:00Z", updated_at: "2026-07-07T00:00:00Z", visibility: "manager", expires_at: null, superseded_by_document_id: null },
              error: null,
            }),
          }),
        };
      },
      update: (patch: Record<string, unknown>) => {
        const upd: Record<string, unknown> = {};
        const updBuilder: Record<string, unknown> = {
          eq: (col: string, val: unknown) => {
            upd[col] = val;
            return updBuilder;
          },
          is: (col: string, val: unknown) => {
            upd[col] = val;
            return updBuilder;
          },
          select: () => ({
            maybeSingle: async () => {
              const match = rows.find((r) => r.id === upd.id && r.deleted_at === null);
              if (!match) return { data: null, error: null };
              Object.assign(match, patch);
              return {
                data: { ...match, original_filename: null, size_bytes: 10, checksum: null, category: "other", property_id: null, unit_label: null, lease_id: null, resident_user_id: null, resident_email: null, vendor_id: null, work_order_id: null, visibility: "manager", expires_at: null, superseded_by_document_id: null, uploaded_by: match.manager_user_id, created_at: "x", updated_at: "y" },
                error: null,
              };
            },
          }),
        };
        return updBuilder;
      },
      // Terminal for the [id] routes' SELECT: .eq("id").is("deleted_at").maybeSingle()
      maybeSingle: async () => {
        const match = rows.find((r) => r.id === filters.id && r.deleted_at === null);
        return { data: match ?? null, error: null };
      },
      // Terminal for the list SELECT (awaited directly)
      then: (resolve: (v: { data: DocRow[]; error: null }) => void) => {
        const data = rows.filter((r) => r.manager_user_id === filters.manager_user_id && r.deleted_at === null);
        resolve({ data, error: null });
      },
    };
    return builder;
  }

  const client = {
    from: () => tableApi(),
    storage: {
      from: () => ({
        upload: async (path: string) => {
          uploaded.push(path);
          return { error: null };
        },
        remove: async (paths: string[]) => {
          removed.push(paths);
          return { error: null };
        },
        createSignedUrl: async (path: string, _ttl: number, options?: { download?: string | boolean }) => {
          signed.push({ path, options });
          return { data: { signedUrl: `https://signed.example/${path}` }, error: null };
        },
      }),
    },
  };
  return { client, removed, signed, inserted, uploaded };
}

function asManager(userId: string, client: unknown) {
  vi.mocked(getReportsAuthContext).mockResolvedValue({
    role: "manager",
    userId,
    email: "m@test.com",
    db: client as never,
  } as never);
  vi.mocked(assertManagerFinancialsAccess).mockResolvedValue({ ok: true });
}

describe("manager-documents API ownership", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects an unauthenticated signed-url request with 401", async () => {
    vi.mocked(getReportsAuthContext).mockResolvedValue(null);
    const res = await SIGNED_URL(jsonRequest(`http://t/api/manager-documents/${DOC_ID}/signed-url`), {
      params: Promise.resolve({ id: DOC_ID }),
    });
    const { status } = await parseJsonResponse(res);
    expect(status).toBe(401);
  });

  it("returns 404 (not another manager's URL) when the doc belongs to a different manager", async () => {
    const rows: DocRow[] = [
      { id: DOC_ID, manager_user_id: "mgr-owner", storage_path: "manager/mgr-owner/a.pdf", display_name: "A", mime_type: "application/pdf", deleted_at: null },
    ];
    const { client, signed } = mockDb(rows);
    asManager("mgr-intruder", client); // different manager

    const res = await SIGNED_URL(jsonRequest(`http://t/api/manager-documents/${DOC_ID}/signed-url`), {
      params: Promise.resolve({ id: DOC_ID }),
    });
    const { status, data } = await parseJsonResponse<{ error?: string }>(res);
    expect(status).toBe(404);
    expect(data.error).toBeTruthy();
    // Never minted a signed URL for someone else's object.
    expect(signed).toHaveLength(0);
  });

  it("mints a signed URL for the owning manager", async () => {
    const rows: DocRow[] = [
      { id: DOC_ID, manager_user_id: "mgr-owner", storage_path: "manager/mgr-owner/a.pdf", display_name: "A", mime_type: "application/pdf", deleted_at: null },
    ];
    const { client, signed } = mockDb(rows);
    asManager("mgr-owner", client);

    const res = await SIGNED_URL(jsonRequest(`http://t/api/manager-documents/${DOC_ID}/signed-url`), {
      params: Promise.resolve({ id: DOC_ID }),
    });
    const { status, data } = await parseJsonResponse<{ url?: string }>(res);
    expect(status).toBe(200);
    expect(data.url).toContain("manager/mgr-owner/a.pdf");
    expect(signed).toHaveLength(1);
  });

  it("returns the signed URL and file name when download=1 so the client can blob-download", async () => {
    const rows: DocRow[] = [
      { id: DOC_ID, manager_user_id: "mgr-owner", storage_path: "manager/mgr-owner/a.pdf", display_name: "A", mime_type: "application/pdf", deleted_at: null },
    ];
    const { client, signed } = mockDb(rows);
    asManager("mgr-owner", client);

    const res = await SIGNED_URL(jsonRequest(`http://t/api/manager-documents/${DOC_ID}/signed-url?download=1`), {
      params: Promise.resolve({ id: DOC_ID }),
    });
    const { status, data } = await parseJsonResponse<{ url?: string; fileName?: string }>(res);
    expect(status).toBe(200);
    expect(data.url).toContain("manager/mgr-owner/a.pdf");
    expect(data.fileName).toBe("A.pdf");
    expect(signed).toHaveLength(1);
  });

  it("downloads under the original filename when one is stored", async () => {
    const rows: DocRow[] = [
      { id: DOC_ID, manager_user_id: "mgr-owner", storage_path: "manager/mgr-owner/a.pdf", display_name: "Lease Agreement", original_filename: "signed-lease-2026.pdf", mime_type: "application/pdf", deleted_at: null },
    ];
    const { client, signed } = mockDb(rows);
    asManager("mgr-owner", client);

    const res = await SIGNED_URL(jsonRequest(`http://t/api/manager-documents/${DOC_ID}/signed-url?download=1`), {
      params: Promise.resolve({ id: DOC_ID }),
    });
    const { status, data } = await parseJsonResponse<{ fileName?: string }>(res);
    expect(status).toBe(200);
    expect(data.fileName).toBe("signed-lease-2026.pdf");
    expect(signed[0]!.options?.download).toBe("signed-lease-2026.pdf");
  });

  it("appends the storage-path extension when there is no original filename", async () => {
    const rows: DocRow[] = [
      { id: DOC_ID, manager_user_id: "mgr-owner", storage_path: "manager/mgr-owner/abc123.pdf", display_name: "Lease Agreement", original_filename: null, mime_type: "application/pdf", deleted_at: null },
    ];
    const { client, signed } = mockDb(rows);
    asManager("mgr-owner", client);

    const res = await SIGNED_URL(jsonRequest(`http://t/api/manager-documents/${DOC_ID}/signed-url?download=1`), {
      params: Promise.resolve({ id: DOC_ID }),
    });
    const { status, data } = await parseJsonResponse<{ fileName?: string }>(res);
    expect(status).toBe(200);
    expect(data.fileName).toBe("Lease Agreement.pdf");
    expect(signed[0]!.options?.download).toBe("Lease Agreement.pdf");
  });

  it("returns 404 for a malformed document id instead of a DB error", async () => {
    const { client, signed } = mockDb([]);
    asManager("mgr-owner", client);
    const params = { params: Promise.resolve({ id: "not-a-uuid" }) };

    const signedRes = await SIGNED_URL(jsonRequest("http://t/api/manager-documents/not-a-uuid/signed-url"), params);
    expect(signedRes.status).toBe(404);
    expect(signed).toHaveLength(0);

    const renameRes = await RENAME(
      jsonRequest("http://t/api/manager-documents/not-a-uuid", { method: "PATCH", body: { displayName: "X" } }),
      params,
    );
    expect(renameRes.status).toBe(404);

    const deleteRes = await SOFT_DELETE(jsonRequest("http://t/api/manager-documents/not-a-uuid", { method: "DELETE" }), params);
    expect(deleteRes.status).toBe(404);
  });

  it("rename returns 404 for a mismatched manager and leaves the row untouched", async () => {
    const rows: DocRow[] = [
      { id: DOC_ID, manager_user_id: "mgr-owner", storage_path: "p", display_name: "Original", mime_type: "application/pdf", deleted_at: null },
    ];
    const { client } = mockDb(rows);
    asManager("mgr-intruder", client);

    const res = await RENAME(
      jsonRequest(`http://t/api/manager-documents/${DOC_ID}`, { method: "PATCH", body: { displayName: "Hacked" } }),
      { params: Promise.resolve({ id: DOC_ID }) },
    );
    const { status } = await parseJsonResponse(res);
    expect(status).toBe(404);
    expect(rows[0]!.display_name).toBe("Original");
  });

  it("rename rejects a whitespace-only name with 400 and leaves the row untouched", async () => {
    const rows: DocRow[] = [
      { id: DOC_ID, manager_user_id: "mgr-owner", storage_path: "p", display_name: "Original", mime_type: "application/pdf", deleted_at: null },
    ];
    const { client } = mockDb(rows);
    asManager("mgr-owner", client);

    const res = await RENAME(
      jsonRequest(`http://t/api/manager-documents/${DOC_ID}`, { method: "PATCH", body: { displayName: "   " } }),
      { params: Promise.resolve({ id: DOC_ID }) },
    );
    const { status } = await parseJsonResponse(res);
    expect(status).toBe(400);
    expect(rows[0]!.display_name).toBe("Original");
  });

  it("rename succeeds for the owning manager", async () => {
    const rows: DocRow[] = [
      { id: DOC_ID, manager_user_id: "mgr-owner", storage_path: "p", display_name: "Original", mime_type: "application/pdf", deleted_at: null },
    ];
    const { client } = mockDb(rows);
    asManager("mgr-owner", client);

    const res = await RENAME(
      jsonRequest(`http://t/api/manager-documents/${DOC_ID}`, { method: "PATCH", body: { displayName: "Renamed" } }),
      { params: Promise.resolve({ id: DOC_ID }) },
    );
    const { status } = await parseJsonResponse(res);
    expect(status).toBe(200);
    expect(rows[0]!.display_name).toBe("Renamed");
  });

  it("soft-delete returns 404 for a mismatched manager and does not delete", async () => {
    const rows: DocRow[] = [
      { id: DOC_ID, manager_user_id: "mgr-owner", storage_path: "p", display_name: "A", mime_type: "application/pdf", deleted_at: null },
    ];
    const { client } = mockDb(rows);
    asManager("mgr-intruder", client);

    const res = await SOFT_DELETE(jsonRequest(`http://t/api/manager-documents/${DOC_ID}`, { method: "DELETE" }), {
      params: Promise.resolve({ id: DOC_ID }),
    });
    const { status } = await parseJsonResponse(res);
    expect(status).toBe(404);
    expect(rows[0]!.deleted_at).toBeNull();
  });

  it("soft-delete sets deleted_at for the owning manager", async () => {
    const rows: DocRow[] = [
      { id: DOC_ID, manager_user_id: "mgr-owner", storage_path: "p", display_name: "A", mime_type: "application/pdf", deleted_at: null },
    ];
    const { client } = mockDb(rows);
    asManager("mgr-owner", client);

    const res = await SOFT_DELETE(jsonRequest(`http://t/api/manager-documents/${DOC_ID}`, { method: "DELETE" }), {
      params: Promise.resolve({ id: DOC_ID }),
    });
    const { status } = await parseJsonResponse(res);
    expect(status).toBe(200);
    expect(rows[0]!.deleted_at).not.toBeNull();
  });

  it("list only returns the requesting manager's own live documents", async () => {
    const rows: DocRow[] = [
      { id: DOC_ID, manager_user_id: "mgr-a", storage_path: "p1", display_name: "Mine", mime_type: "application/pdf", deleted_at: null },
      { id: "doc-2", manager_user_id: "mgr-b", storage_path: "p2", display_name: "Theirs", mime_type: "application/pdf", deleted_at: null },
      { id: "doc-3", manager_user_id: "mgr-a", storage_path: "p3", display_name: "Deleted", mime_type: "application/pdf", deleted_at: "2026-01-01T00:00:00Z" },
    ];
    const { client } = mockDb(rows);
    asManager("mgr-a", client);

    const res = await LIST(jsonRequest("http://t/api/manager-documents"));
    const { status, data } = await parseJsonResponse<{ documents: { displayName: string }[] }>(res);
    expect(status).toBe(200);
    expect(data.documents.map((d) => d.displayName)).toEqual(["Mine"]);
  });

  it("upload rejects a disallowed mime type with 415 and never inserts", async () => {
    const { client, inserted } = mockDb([]);
    asManager("mgr-a", client);

    const form = new FormData();
    form.set("file", new File([new Uint8Array([1, 2, 3])], "evil.exe", { type: "application/x-msdownload" }));
    const req = new Request("http://t/api/manager-documents", { method: "POST", body: form });

    const res = await UPLOAD(req);
    const { status } = await parseJsonResponse(res);
    expect(status).toBe(415);
    expect(inserted).toHaveLength(0);
  });

  it("upload rejects a malformed residentUserId with 400 before uploading bytes", async () => {
    const { client, inserted, uploaded } = mockDb([]);
    asManager("mgr-a", client);

    const form = new FormData();
    form.set("file", new File([new Uint8Array([1, 2, 3, 4])], "lease.pdf", { type: "application/pdf" }));
    form.set("residentUserId", "not-a-uuid");
    const req = new Request("http://t/api/manager-documents", { method: "POST", body: form });

    const res = await UPLOAD(req);
    const { status } = await parseJsonResponse(res);
    expect(status).toBe(400);
    expect(uploaded).toHaveLength(0);
    expect(inserted).toHaveLength(0);
  });

  it("upload accepts a valid residentUserId", async () => {
    const { client, inserted } = mockDb([]);
    asManager("mgr-a", client);

    const form = new FormData();
    form.set("file", new File([new Uint8Array([1, 2, 3, 4])], "lease.pdf", { type: "application/pdf" }));
    form.set("residentUserId", "8f7e6d5c-4b3a-4c2d-9e1f-0a1b2c3d4e5f");
    const req = new Request("http://t/api/manager-documents", { method: "POST", body: form });

    const res = await UPLOAD(req);
    const { status } = await parseJsonResponse(res);
    expect(status).toBe(201);
    expect(inserted[0]!.resident_user_id).toBe("8f7e6d5c-4b3a-4c2d-9e1f-0a1b2c3d4e5f");
  });

  it("upload stores an owned row with manager_user_id from auth, not the client", async () => {
    const { client, inserted } = mockDb([]);
    asManager("mgr-a", client);

    const form = new FormData();
    form.set("file", new File([new Uint8Array([1, 2, 3, 4])], "lease.pdf", { type: "application/pdf" }));
    form.set("category", "lease");
    // A malicious client tries to attribute the doc to another manager — ignored.
    form.set("managerUserId", "mgr-victim");
    const req = new Request("http://t/api/manager-documents", { method: "POST", body: form });

    const res = await UPLOAD(req);
    const { status } = await parseJsonResponse(res);
    expect(status).toBe(201);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]!.manager_user_id).toBe("mgr-a");
    expect(inserted[0]!.uploaded_by).toBe("mgr-a");
    expect(inserted[0]!.category).toBe("lease");
    expect(String(inserted[0]!.storage_path)).toContain("manager/mgr-a/");
  });
});
