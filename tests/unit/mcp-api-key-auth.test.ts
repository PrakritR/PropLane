import { beforeEach, describe, expect, it, vi } from "vitest";

const { findLiveApiKey, touchApiKey, createSupabaseServiceRoleClient, userHoldsAdminRole } = vi.hoisted(() => ({
  findLiveApiKey: vi.fn(),
  touchApiKey: vi.fn(),
  createSupabaseServiceRoleClient: vi.fn(),
  userHoldsAdminRole: vi.fn(),
}));

vi.mock("@/lib/mcp/api-keys.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mcp/api-keys.server")>();
  return { ...actual, findLiveApiKey, touchApiKey };
});
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient }));
vi.mock("@/lib/auth/admin-role", () => ({ userHoldsAdminRole }));

import { hashApiKeyToken, mintApiKey, normalizeScopes } from "@/lib/mcp/api-keys.server";
import { bearerTokenFrom, resolveApiKeyContext } from "@/lib/mcp/context.server";

function dbForRole(role: string | null) {
  return {
    from(table: string) {
      const row = table === "profiles" ? { email: "manager@example.com", role } : null;
      const rows = table === "profile_roles" && role ? [{ role }] : [];
      return {
        select() {
          return this;
        },
        eq() {
          return this;
        },
        maybeSingle: async () => ({ data: row }),
        then: (resolve: (value: { data: unknown[] }) => unknown) => Promise.resolve({ data: rows }).then(resolve),
      };
    },
  };
}

describe("MCP API-key credential resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    userHoldsAdminRole.mockResolvedValue(false);
    findLiveApiKey.mockResolvedValue({
      id: "key_1",
      userId: "manager_1",
      scopes: ["read"],
      portal: "manager",
      lastUsedAt: null,
    });
  });

  it("parses bearer credentials and normalizes only the supported scopes", () => {
    expect(bearerTokenFrom(new Request("https://example.test", { headers: { Authorization: "Bearer pl_live_x" } }))).toBe(
      "pl_live_x",
    );
    expect(bearerTokenFrom(new Request("https://example.test", { headers: { Authorization: "Basic x" } }))).toBeNull();
    expect(normalizeScopes(["WRITE", "unknown"])).toEqual(["write", "unknown"]);
    expect(normalizeScopes("write")).toEqual([]);
  });

  it("re-derives manager access on every request instead of trusting the key row", async () => {
    createSupabaseServiceRoleClient.mockReturnValue(dbForRole("manager"));
    const allowed = await resolveApiKeyContext(
      new Request("https://example.test", { headers: { Authorization: "Bearer pl_live_x" } }),
    );
    expect(allowed).toMatchObject({ ok: true, keyId: "key_1", ctx: { landlordId: "manager_1" } });

    createSupabaseServiceRoleClient.mockReturnValue(dbForRole("resident"));
    const denied = await resolveApiKeyContext(
      new Request("https://example.test", { headers: { Authorization: "Bearer pl_live_x" } }),
    );
    expect(denied).toMatchObject({ ok: false, status: 403 });
    expect(touchApiKey).toHaveBeenCalledTimes(1);
  });

  it("refuses a future non-manager portal key before it can reach the manager registry", async () => {
    findLiveApiKey.mockResolvedValueOnce({
      id: "key_2",
      userId: "manager_1",
      scopes: ["read"],
      portal: "resident",
      lastUsedAt: null,
    });
    createSupabaseServiceRoleClient.mockReturnValue(dbForRole("manager"));
    const result = await resolveApiKeyContext(
      new Request("https://example.test", { headers: { Authorization: "Bearer pl_live_x" } }),
    );
    expect(result).toMatchObject({ ok: false, status: 401 });
    expect(userHoldsAdminRole).not.toHaveBeenCalled();
  });

  it("keeps MCP and REST API credentials on their own endpoints", async () => {
    findLiveApiKey.mockResolvedValueOnce({
      id: "key_api",
      userId: "manager_1",
      scopes: [],
      allowedTools: ["list_charges"],
      transport: "api",
      portal: "manager",
      lastUsedAt: null,
    });
    createSupabaseServiceRoleClient.mockReturnValue(dbForRole("manager"));
    const result = await resolveApiKeyContext(
      new Request("https://example.test", { headers: { Authorization: "Bearer pl_live_x" } }),
      "mcp",
    );
    expect(result).toMatchObject({ ok: false, status: 401, error: expect.stringContaining("REST API") });
    expect(userHoldsAdminRole).not.toHaveBeenCalled();
  });

  it("stores only a SHA-256 hash when minting a token", async () => {
    let inserted: Record<string, unknown> | null = null;
    const db = {
      from: () => ({
        insert: (row: Record<string, unknown>) => {
          inserted = row;
          return {
            select: () => ({
              single: async () => ({
                data: {
                  id: "key_1",
                  name: row.name,
                  token_prefix: row.token_prefix,
                  scopes: row.scopes,
                  created_at: "2026-08-06T00:00:00.000Z",
                  last_used_at: null,
                  expires_at: null,
                  revoked_at: null,
                },
                error: null,
              }),
            }),
          };
        },
      }),
    };
    const minted = await mintApiKey(db as never, { userId: "manager_1", name: "Harness", scopes: ["payments:read"], allowedTools: ["list_charges"], transport: "mcp" });
    expect(minted).not.toBeNull();
    expect(inserted).not.toBeNull();
    expect(Object.values(inserted!)).not.toContain(minted!.token);
    expect(inserted!.token_sha256).toBe(hashApiKeyToken(minted!.token));
    expect(String(inserted!.token_prefix)).toHaveLength(12);
  });
});
