/**
 * night/custom-lease item 1: "delete-if-unused". Deleting a workspace
 * lease-library entry must be refused (409) while a property submission or a
 * resident's lease row still references it, and must succeed — including
 * reclaiming the storage object — once nothing references it anymore.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const OWNER_ID = "b5809cf3-dcff-4e46-a0cc-5dcc53bc8910";
const ROUTE_URL = "/api/portal/lease-template?path=" + encodeURIComponent(`${OWNER_ID}/123-abc.pdf`);

const state: {
  library: Row[];
  properties: Row[];
  leases: Row[];
  workspace: Row;
  removedPaths: string[][];
} = {
  library: [],
  properties: [],
  leases: [],
  workspace: { id: "ws-1", owner_user_id: OWNER_ID },
  removedPaths: [],
};

function makeQuery(table: string) {
  const filters: ((r: Row) => boolean)[] = [];
  const rowsFor = () => {
    if (table === "lease_document_library") return state.library;
    if (table === "manager_property_records") return state.properties;
    if (table === "portal_lease_pipeline_records") return state.leases;
    if (table === "portal_workspaces") return [state.workspace];
    return [];
  };
  const matches = () => rowsFor().filter((r) => filters.every((f) => f(r)));
  const q = {
    select: () => q,
    eq: (col: string, val: unknown) => {
      filters.push((r) => r[col] === val);
      return q;
    },
    maybeSingle: async () => ({ data: matches()[0] ?? null, error: null }),
    limit: () => Promise.resolve({ data: matches(), error: null }),
    then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: matches(), error: null }).then(resolve),
    delete: () => ({
      eq: (col: string, val: unknown) => {
        state.library = state.library.filter((r) => r[col] !== val);
        return Promise.resolve({ data: null, error: null });
      },
    }),
  };
  return q;
}

const db = {
  from: (table: string) => makeQuery(table),
  storage: {
    from: () => ({
      remove: async (paths: string[]) => {
        state.removedPaths.push(paths);
        return { error: null };
      },
    }),
  },
};

vi.mock("@/lib/reports/auth", () => ({
  getReportsAuthContext: async () => ({ db, userId: OWNER_ID, email: "manager@example.com", role: "manager" }),
}));
vi.mock("@/lib/scope/settings-scope", () => ({
  assertSettingsScopeOwned: async () => ({ ok: true }),
  resolveSettingsScopeParams: () => ({}),
}));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: async () => ({ ok: true }) }));

import { DELETE } from "@/app/api/portal/lease-library/route";

function del(id: string) {
  return DELETE(new Request("http://localhost/api/portal/lease-library", { method: "DELETE", body: JSON.stringify({ id }) }));
}

describe("DELETE /api/portal/lease-library — delete-if-unused", () => {
  beforeEach(() => {
    state.removedPaths = [];
    state.library = [
      {
        id: "lib_1",
        workspace_id: "ws-1",
        manager_user_id: OWNER_ID,
        name: "Corporate lease",
        storage_path: `${OWNER_ID}/123-abc.pdf`,
        file_name: "corp.pdf",
        is_default: false,
        fields: [],
        created_at: "2026-09-01T00:00:00.000Z",
        updated_at: "2026-09-01T00:00:00.000Z",
      },
    ];
    state.properties = [];
    state.leases = [];
  });

  it("refuses to delete an entry a property listing still references", async () => {
    state.properties = [
      {
        id: "prop-1",
        workspace_id: "ws-1",
        property_data: { listingSubmission: { leaseTemplateDocUrl: ROUTE_URL } },
      },
    ];

    const res = await del("lib_1");
    expect(res.status).toBe(409);
    expect(state.library).toHaveLength(1);
    expect(state.removedPaths).toHaveLength(0);
  });

  it("refuses to delete an entry a resident's lease row still references (libraryDocumentId)", async () => {
    state.leases = [
      {
        id: "lease-1",
        manager_user_id: OWNER_ID,
        row_data: { managerUploadedPdf: { libraryDocumentId: "lib_1", dataUrl: "data:application/pdf;base64,AAA" } },
      },
    ];

    const res = await del("lib_1");
    expect(res.status).toBe(409);
    expect(state.library).toHaveLength(1);
  });

  it("ignores a lease referencing a DIFFERENT library entry", async () => {
    state.leases = [
      {
        id: "lease-1",
        manager_user_id: OWNER_ID,
        row_data: { managerUploadedPdf: { libraryDocumentId: "some-other-entry" } },
      },
    ];

    const res = await del("lib_1");
    const body = (await res.json()) as { ok: boolean };
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(state.library).toHaveLength(0);
  });

  it("deletes the row and reclaims the storage object once nothing references it", async () => {
    const res = await del("lib_1");
    const body = (await res.json()) as { ok: boolean };
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(state.library).toHaveLength(0);
    expect(state.removedPaths).toEqual([[`${OWNER_ID}/123-abc.pdf`]]);
  });

  it("is a no-op (200) when the entry was already deleted", async () => {
    const res = await del("missing-id");
    const body = (await res.json()) as { ok: boolean };
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });
});
