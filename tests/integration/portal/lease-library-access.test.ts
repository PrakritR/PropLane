/**
 * night/custom-lease item 5: authorization for the workspace lease document
 * library (`/api/portal/lease-library`). Real access is by workspace
 * membership, resolved server-side through the SAME `assertSettingsScopeOwned`
 * helper every other per-workspace settings route uses — never trusted from
 * the request. This drives the real route handlers; a manager unrelated to a
 * workspace must be refused, even though `lease_document_library` rows are
 * only SELECT-visible to the workspace owner at the RLS layer (defense in
 * depth, not the real gate for a service-role route).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const OWNER_ID = "b5809cf3-dcff-4e46-a0cc-5dcc53bc8910";
const STRANGER_ID = "f707ad54-3d2f-4217-804d-3de84e7b61ef";

const state: {
  userId: string;
  role: "manager" | "admin";
  library: Row[];
  scopeResult: { ok: true } | { ok: false; status: 403; error: string };
} = {
  userId: OWNER_ID,
  role: "manager",
  library: [],
  scopeResult: { ok: true },
};

function makeQuery(table: string) {
  const filters: ((r: Row) => boolean)[] = [];
  const rows = () => (table === "lease_document_library" ? state.library : []);
  const matches = () => rows().filter((r) => filters.every((f) => f(r)));
  const q = {
    select: () => q,
    order: () => ({ ...q, then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: matches(), error: null }).then(resolve) }),
    eq: (col: string, val: unknown) => {
      filters.push((r) => r[col] === val);
      return q;
    },
    maybeSingle: async () => ({ data: matches()[0] ?? null, error: null }),
    insert: (payload: Row) => ({
      select: () => ({
        single: async () => {
          const row = { id: `lib_${state.library.length + 1}`, created_at: "2026-09-25T00:00:00.000Z", updated_at: "2026-09-25T00:00:00.000Z", is_default: false, fields: [], ...payload };
          state.library.push(row);
          return { data: row, error: null };
        },
      }),
    }),
  };
  return q;
}

const db = { from: (table: string) => makeQuery(table) };

vi.mock("@/lib/reports/auth", () => ({
  getReportsAuthContext: async () => ({ db, userId: state.userId, email: "manager@example.com", role: state.role }),
}));
vi.mock("@/lib/scope/settings-scope", () => ({
  assertSettingsScopeOwned: async () => state.scopeResult,
  resolveSettingsScopeParams: (url: string) => {
    const workspaceId = new URL(url).searchParams.get("workspaceId") ?? undefined;
    return workspaceId ? { workspaceId } : {};
  },
}));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: async () => ({ ok: true }) }));

import { DELETE, GET, PATCH, POST } from "@/app/api/portal/lease-library/route";

describe("GET/POST/PATCH/DELETE /api/portal/lease-library authorization", () => {
  beforeEach(() => {
    state.userId = OWNER_ID;
    state.role = "manager";
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
    state.scopeResult = { ok: true };
  });

  it("returns the workspace's entries when the caller's workspace access is confirmed", async () => {
    const res = await GET(new Request("http://localhost/api/portal/lease-library?workspaceId=ws-1"));
    const body = (await res.json()) as { entries: Row[] };
    expect(res.status).toBe(200);
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]!.id).toBe("lib_1");
  });

  it("refuses a manager with no relationship to the workspace", async () => {
    state.userId = STRANGER_ID;
    state.scopeResult = { ok: false, status: 403, error: "That workspace is not yours." };

    const res = await GET(new Request("http://localhost/api/portal/lease-library?workspaceId=ws-1"));
    const body = (await res.json()) as { error?: string; entries?: Row[] };
    expect(res.status).toBe(403);
    expect(body.error).toBeTruthy();
    expect(body.entries).toBeUndefined();
  });

  it("refuses to register an object the caller did not upload (foreign folder)", async () => {
    const res = await POST(
      new Request("http://localhost/api/portal/lease-library", {
        method: "POST",
        body: JSON.stringify({
          storagePath: "11111111-2222-4333-8444-555555555555/999-zzz.pdf",
          name: "Planted document",
          fileName: "planted.pdf",
          workspaceId: "ws-1",
        }),
      }),
    );
    expect(res.status).toBe(403);
    expect(state.library).toHaveLength(1);
  });

  it("registers an object the caller uploaded into their own folder", async () => {
    const res = await POST(
      new Request("http://localhost/api/portal/lease-library", {
        method: "POST",
        body: JSON.stringify({
          storagePath: `${OWNER_ID}/999-zzz.pdf`,
          name: "New template",
          fileName: "new.pdf",
          workspaceId: "ws-1",
        }),
      }),
    );
    const body = (await res.json()) as { entry?: Row };
    expect(res.status).toBe(200);
    expect(body.entry?.name).toBe("New template");
    expect(state.library).toHaveLength(2);
  });

  it("refuses PATCH from a manager with no workspace access", async () => {
    state.userId = STRANGER_ID;
    state.scopeResult = { ok: false, status: 403, error: "That workspace is not yours." };

    const res = await PATCH(
      new Request("http://localhost/api/portal/lease-library", {
        method: "PATCH",
        body: JSON.stringify({ id: "lib_1", name: "Renamed" }),
      }),
    );
    expect(res.status).toBe(403);
    expect(state.library[0]!.name).toBe("Corporate lease");
  });

  it("refuses DELETE from a manager with no workspace access", async () => {
    state.userId = STRANGER_ID;
    state.scopeResult = { ok: false, status: 403, error: "That workspace is not yours." };

    const res = await DELETE(
      new Request("http://localhost/api/portal/lease-library", {
        method: "DELETE",
        body: JSON.stringify({ id: "lib_1" }),
      }),
    );
    expect(res.status).toBe(403);
    expect(state.library).toHaveLength(1);
  });
});
