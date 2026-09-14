import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  ctx: null as null | { user: { id: string; role: string }; db: Record<string, unknown> },
  rows: [] as Record<string, unknown>[],
  rereadRows: null as Record<string, unknown>[] | null,
  rereadError: null as Error | null,
  rpc: vi.fn(),
  linkedOwners: vi.fn(async () => []),
}));

vi.mock("@/lib/auth/co-manager-module-scope", () => ({
  viewerAndLinkedOwnerIdsForModule: state.linkedOwners,
}));
vi.mock("@/lib/portal-inbox-thread-scope", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveInboxScopeUser: async () => state.ctx,
}));
vi.mock("@/lib/sms-inbox-state.server", () => ({
  smsNoticeMembers: vi.fn(async () => []),
  storedSmsNoticeIdentity: () => false,
  updateSmsNoticeMailboxState: vi.fn(),
}));
vi.mock("@/lib/agent-notify.server", () => ({ ensureManagerAgentNoticeThread: vi.fn() }));
vi.mock("@/lib/agent/resident-inbox-agent.server", () => ({ ensureResidentAgentThread: vi.fn() }));
vi.mock("@/lib/resident-manager-scope", () => ({ managerIdsOwningResident: vi.fn(async () => []) }));
vi.mock("@/lib/portal-inbox-storage", () => ({
  collapseAssistantInboxThreads: (rows: unknown[]) => rows,
  collapsePersonInboxThreads: (rows: unknown[]) => rows,
}));

import { POST } from "@/app/api/portal-inbox-threads/route";
import { portalInboxReadObservation } from "@/lib/portal-inbox-read-state.server";

const scope = "axis_portal_inbox_manager_v1";
const makeRow = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: "thread-1",
  scope,
  owner_user_id: "manager-1",
  participant_email: "resident@example.com",
  thread_type: null,
  updated_at: "2026-09-13T18:00:00.000Z",
  row_data: { folder: "inbox", unread: true, body: "hello", ...overrides },
});
const request = (body: unknown) => new Request("https://example.test/api/portal-inbox-threads", {
  method: "POST",
  body: JSON.stringify(body),
  headers: { "Content-Type": "application/json" },
});
const observation = (row: Record<string, unknown>) => portalInboxReadObservation(row as never);

function query() {
  const ids: Set<string> | null = null;
  const filters: { ids: Set<string> | null; scope: string | null; owners: Set<string> | null; participant: string | null; orMatcher: ((row: Record<string, unknown>) => boolean) | null } = {
    ids,
    scope: null,
    owners: null,
    participant: null,
    orMatcher: null,
  };
  const matches = (row: Record<string, unknown>) =>
    (!filters.ids || filters.ids.has(String(row.id))) &&
    (!filters.scope || row.scope === filters.scope) &&
    (filters.orMatcher
      ? filters.orMatcher(row)
      : (!filters.owners || filters.owners.has(String(row.owner_user_id))) &&
        (!filters.participant || String(row.participant_email).toLowerCase() === filters.participant));
  const chain = {
    select() { return chain; },
    in(column: string, values: string[]) {
      if (column === "id") filters.ids = new Set(values);
      return chain;
    },
    eq(column: string, value: string) {
      if (column === "id") filters.ids = new Set([value]);
      if (column === "scope") filters.scope = value;
      if (column === "participant_email") filters.participant = value.toLowerCase();
      if (column === "owner_user_id") filters.owners = new Set([value]);
      return chain;
    },
    or(expression: string) {
      const owners = new Set<string>();
      let participant: string | null = null;
      let adminScope = false;
      for (const match of expression.matchAll(/owner_user_id\.eq\.([^,]+)|owner_user_id\.in\.\(([^)]*)\)|participant_email\.eq\.([^,]+)|scope\.eq\.admin/g)) {
        if (match[1]) owners.add(match[1]);
        if (match[2]) match[2].split(",").forEach((id) => owners.add(id));
        if (match[3]) participant = match[3].toLowerCase();
        if (match[0] === "scope.eq.admin") adminScope = true;
      }
      filters.orMatcher = (row) =>
        (owners.size > 0 && owners.has(String(row.owner_user_id))) ||
        (Boolean(participant) && String(row.participant_email).toLowerCase() === participant) ||
        (adminScope && row.scope === "admin");
      // The route's manager-scope query has already constrained `scope`; the
      // admin OR's explicit admin clause is modeled as a scope predicate.
      return chain;
    },
    order() { return chain; },
    limit() { return chain; },
    maybeSingle: async () => ({
      data: (state.rereadRows ?? state.rows).find(matches) ?? null,
      error: state.rereadError,
    }),
    then(resolve: (value: unknown) => unknown) {
      const rows = state.rows.filter(matches);
      return Promise.resolve({ data: rows, error: null }).then(resolve);
    },
  };
  return chain;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.rows = [makeRow()];
  state.rereadRows = null;
  state.rereadError = null;
  state.rpc.mockResolvedValue({ data: true, error: null });
  state.ctx = {
    user: { id: "manager-1", role: "manager" },
    db: { from: vi.fn(() => query()), rpc: state.rpc },
  };
});

describe("portal inbox markRead route contract", () => {
  it.each([
    ["unauthenticated", null, 401],
    ["resident scope", { scope: "resident" }, 400],
  ])("fails closed for %s before any write", async (_label, override, expectedStatus) => {
    if (override === null) state.ctx = null;
    const source = state.rows[0]!;
    const response = await POST(request({ action: "markRead", scope: override?.scope ?? scope, sources: [{ id: source.id, observation: observation(source) }] }));
    expect(response.status).toBe(expectedStatus);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("rejects missing and mixed authorized IDs before writing any source", async () => {
    const source = state.rows[0]!;
    const response = await POST(request({
      action: "markRead", scope,
      sources: [{ id: source.id, observation: observation(source) }, { id: "missing", observation: "deadbeef" }],
    }));
    expect(response.status).toBe(404);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("rejects duplicate source IDs before authorization or writes", async () => {
    const source = state.rows[0]!;
    const token = observation(source);
    const response = await POST(request({
      action: "markRead", scope,
      sources: [{ id: source.id, observation: token }, { id: source.id, observation: token }],
    }));
    expect(response.status).toBe(400);
    expect(state.linkedOwners).not.toHaveBeenCalled();
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["already read", { unread: false }, "alreadyRead"],
    ["archived", { folder: "trash", unread: true }, "archived"],
  ])("returns the %s outcome without RPC", async (_label, rowPatch, expectedStatus) => {
    state.rows = [makeRow(rowPatch)];
    const source = state.rows[0]!;
    const response = await POST(request({ action: "markRead", scope, sources: [{ id: source.id, observation: observation(source) }] }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ results: [{ id: source.id, status: expectedStatus }] });
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("reports changed when the supplied observation is stale", async () => {
    const source = state.rows[0]!;
    const response = await POST(request({ action: "markRead", scope, sources: [{ id: source.id, observation: "0".repeat(64) }] }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ results: [{ id: source.id, status: "changed", unread: true }] });
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("re-reads after a false CAS and reports same-timestamp content changes", async () => {
    const source = state.rows[0]!;
    state.rereadRows = [{
      ...source,
      // Keep updated_at stable: the observation must cover row content too.
      row_data: { ...(source.row_data as Record<string, unknown>), body: "revised content" },
    }];
    state.rpc.mockResolvedValue({ data: false, error: null });

    const response = await POST(request({ action: "markRead", scope, sources: [{ id: source.id, observation: observation(source) }] }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ results: [{ id: source.id, status: "changed", unread: true }] });
    expect(state.rpc).toHaveBeenCalledTimes(1);
  });

  it("bounds a false CAS retry when the reread still matches the original observation", async () => {
    const source = state.rows[0]!;
    state.rpc.mockResolvedValue({ data: false, error: null });

    const response = await POST(request({ action: "markRead", scope, sources: [{ id: source.id, observation: observation(source) }] }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ results: [{ id: source.id, status: "changed", unread: true }] });
    expect(state.rpc).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the false CAS reread errors", async () => {
    const source = state.rows[0]!;
    state.rpc.mockResolvedValue({ data: false, error: null });
    state.rereadError = new Error("reread unavailable");

    const response = await POST(request({ action: "markRead", scope, sources: [{ id: source.id, observation: observation(source) }] }));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ ok: false, results: [{ id: source.id, status: "failed", unread: true }] });
    expect(state.rpc).toHaveBeenCalledTimes(1);
  });

  it("fails closed on RPC errors and never falls back to folder or upsert writes", async () => {
    state.rpc.mockResolvedValue({ data: null, error: new Error("schema cache") });
    const source = state.rows[0]!;
    const response = await POST(request({ action: "markRead", scope, sources: [{ id: source.id, observation: observation(source) }] }));
    expect(response.status).toBe(500);
    expect(state.rpc).toHaveBeenCalledWith("mark_portal_inbox_source_read", expect.any(Object));
    expect(state.rpc).not.toHaveBeenCalledWith("change_portal_inbox_thread_folders", expect.anything());
  });

  it("denies a co-manager with inbox read access but permits the same owner with edit access", async () => {
    const ownerRow = { ...makeRow(), owner_user_id: "owner-2" };
    state.rows = [ownerRow];
    state.ctx = { user: { id: "co-manager", role: "manager" }, db: { from: vi.fn(() => query()), rpc: state.rpc } };
    state.linkedOwners.mockResolvedValueOnce([]);
    const denied = await POST(request({ action: "markRead", scope, sources: [{ id: ownerRow.id, observation: observation(ownerRow) }] }));
    expect(denied.status).toBe(404);
    expect(state.linkedOwners).toHaveBeenLastCalledWith(state.ctx.db, "co-manager", "inbox", "edit");
    expect(state.rpc).not.toHaveBeenCalled();

    state.linkedOwners.mockResolvedValueOnce(["owner-2"]);
    const allowed = await POST(request({ action: "markRead", scope, sources: [{ id: ownerRow.id, observation: observation(ownerRow) }] }));
    expect(allowed.status).toBe(200);
    await expect(allowed.json()).resolves.toMatchObject({ results: [{ id: ownerRow.id, status: "read" }] });
    expect(state.rpc).toHaveBeenCalledTimes(1);
  });

  it("allows an effective admin viewer and writes every authorized source in a batch", async () => {
    const ownerRow = { ...makeRow(), id: "admin-owned", owner_user_id: "effective-manager" };
    state.rows = [ownerRow];
    state.ctx = { user: { id: "effective-manager", role: "admin" }, db: { from: vi.fn(() => query()), rpc: state.rpc } };
    const response = await POST(request({ action: "markRead", scope, sources: [{ id: ownerRow.id, observation: observation(ownerRow) }] }));
    expect(response.status).toBe(200);
    expect(state.rpc).toHaveBeenCalledWith("mark_portal_inbox_source_read", expect.objectContaining({ p_owner_user_id: "effective-manager" }));
  });

  it("does not let a bare admin inspect an unrelated manager mailbox", async () => {
    const ownerRow = { ...makeRow(), id: "unrelated-manager-row", owner_user_id: "manager-2" };
    state.rows = [ownerRow];
    state.ctx = { user: { id: "admin-1", role: "admin" }, db: { from: vi.fn(() => query()), rpc: state.rpc } };
    const response = await POST(request({ action: "markRead", scope, sources: [{ id: ownerRow.id, observation: observation(ownerRow) }] }));
    expect(response.status).toBe(404);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("rejects a mixed authorized and unauthorized batch before writing any source", async () => {
    const authorized = { ...makeRow(), id: "authorized", owner_user_id: "manager-1" };
    const unauthorized = { ...makeRow(), id: "unauthorized", owner_user_id: "owner-2" };
    state.rows = [authorized, unauthorized];
    const response = await POST(request({
      action: "markRead",
      scope,
      sources: [
        { id: authorized.id, observation: observation(authorized) },
        { id: unauthorized.id, observation: observation(unauthorized) },
      ],
    }));
    expect(response.status).toBe(404);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("returns an earlier committed result when a later source RPC fails", async () => {
    const first = { ...makeRow(), id: "first" };
    const second = { ...makeRow(), id: "second" };
    state.rows = [first, second];
    state.rpc
      .mockResolvedValueOnce({ data: true, error: null })
      .mockResolvedValueOnce({ data: null, error: new Error("second RPC failed") });

    const response = await POST(request({
      action: "markRead",
      scope,
      sources: [
        { id: first.id, observation: observation(first) },
        { id: second.id, observation: observation(second) },
      ],
    }));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      results: [
        { id: "first", status: "read", unread: false },
        { id: "second", status: "failed", unread: true },
      ],
    });
    expect(state.rpc).toHaveBeenCalledTimes(2);
  });

  it("keeps a committed source when a later source reread errors during retry", async () => {
    const first = { ...makeRow(), id: "first" };
    const second = { ...makeRow(), id: "second" };
    state.rows = [first, second];
    state.rpc
      .mockResolvedValueOnce({ data: true, error: null })
      .mockResolvedValueOnce({ data: false, error: null });
    state.rereadError = new Error("retry read failed");

    const response = await POST(request({
      action: "markRead",
      scope,
      sources: [
        { id: first.id, observation: observation(first) },
        { id: second.id, observation: observation(second) },
      ],
    }));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      results: [
        { id: "first", status: "read", unread: false },
        { id: "second", status: "failed", unread: true },
      ],
    });
    expect(state.rpc).toHaveBeenCalledTimes(2);
  });
});
