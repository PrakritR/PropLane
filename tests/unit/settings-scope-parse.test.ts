import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  parseSettingsScope,
  resolveSettingsScopeParams,
  assertSettingsScopeOwned,
} from "@/lib/scope/settings-scope";

type Row = Record<string, unknown>;
function makeDb(tables: Record<string, Row[]>): SupabaseClient {
  return {
    from(table: string) {
      const rows = tables[table] ?? (tables[table] = []);
      const filters: Array<(r: Row) => boolean> = [];
      const builder: Record<string, unknown> = {
        select() {
          return builder;
        },
        eq(col: string, val: unknown) {
          filters.push((r) => String(r[col]) === String(val));
          return builder;
        },
        maybeSingle() {
          const match = rows.filter((r) => filters.every((f) => f(r)))[0] ?? null;
          return Promise.resolve({ data: match, error: null });
        },
        then(resolve: (v: { data: Row[] | null; error: null }) => unknown) {
          const matched = rows.filter((r) => filters.every((f) => f(r)));
          return resolve({ data: matched, error: null });
        },
      };
      return builder as never;
    },
  } as unknown as SupabaseClient;
}

const OWNER = "owner-1";
const OTHER = "other-owner";
const WORKSPACE_OWNED = "ws-owned";
const WORKSPACE_FOREIGN = "ws-foreign";
const HOUSE_OWNED = "house-owned";
const HOUSE_FOREIGN = "house-foreign";

function seed(): Record<string, Row[]> {
  return {
    manager_property_records: [
      { id: HOUSE_OWNED, manager_user_id: OWNER, workspace_id: WORKSPACE_OWNED },
      { id: HOUSE_FOREIGN, manager_user_id: OTHER, workspace_id: WORKSPACE_FOREIGN },
    ],
    portal_workspaces: [
      { id: WORKSPACE_OWNED, owner_user_id: OWNER },
      { id: WORKSPACE_FOREIGN, owner_user_id: OTHER },
    ],
  };
}

describe("parseSettingsScope", () => {
  it("reads workspaceId/propertyId from URLSearchParams, trimmed", () => {
    const params = new URLSearchParams("workspaceId=%20ws-1%20&propertyId=house-1");
    expect(parseSettingsScope(params)).toEqual({ workspaceId: "ws-1", propertyId: "house-1" });
  });

  it("reads from a body object and omits blank/missing values", () => {
    expect(parseSettingsScope({ workspaceId: "  ", propertyId: "house-2" })).toEqual({ propertyId: "house-2" });
    expect(parseSettingsScope({})).toEqual({});
    expect(parseSettingsScope(null)).toEqual({});
  });

  it("ignores non-string values", () => {
    expect(parseSettingsScope({ workspaceId: 5, propertyId: null })).toEqual({});
  });
});

describe("resolveSettingsScopeParams", () => {
  it("the body wins over the query string, matching the pre-existing propertyId idiom", () => {
    const scope = resolveSettingsScopeParams("https://example.test/api?propertyId=from-query&workspaceId=ws-query", {
      propertyId: "from-body",
    });
    expect(scope).toEqual({ propertyId: "from-body", workspaceId: "ws-query" });
  });

  it("falls back to the query string when the body has nothing", () => {
    const scope = resolveSettingsScopeParams("https://example.test/api?propertyId=from-query");
    expect(scope).toEqual({ propertyId: "from-query" });
  });
});

describe("assertSettingsScopeOwned — no scope", () => {
  it("passes through as the caller's own account", async () => {
    const db = makeDb(seed());
    const result = await assertSettingsScopeOwned(db, OWNER, {});
    expect(result).toEqual({ ok: true, ownerUserId: OWNER, workspaceId: null, propertyId: null });
  });
});

describe("assertSettingsScopeOwned — propertyId", () => {
  it("the caller's own property is allowed", async () => {
    const db = makeDb(seed());
    const result = await assertSettingsScopeOwned(db, OWNER, { propertyId: HOUSE_OWNED });
    expect(result).toEqual({ ok: true, ownerUserId: OWNER, workspaceId: WORKSPACE_OWNED, propertyId: HOUSE_OWNED });
  });

  it("refuses another owner's property with no module given (ownership-only)", async () => {
    const db = makeDb(seed());
    const result = await assertSettingsScopeOwned(db, OWNER, { propertyId: HOUSE_FOREIGN });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
  });

  it("refuses a propertyId that does not exist at all", async () => {
    const db = makeDb(seed());
    const result = await assertSettingsScopeOwned(db, OWNER, { propertyId: "does-not-exist" });
    expect(result.ok).toBe(false);
  });

  it("refuses a propertyId paired with a workspaceId it does not belong to", async () => {
    const db = makeDb(seed());
    const result = await assertSettingsScopeOwned(db, OWNER, { propertyId: HOUSE_OWNED, workspaceId: WORKSPACE_FOREIGN });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not in that workspace/);
  });
});

describe("assertSettingsScopeOwned — workspaceId", () => {
  it("the caller's own workspace is allowed", async () => {
    const db = makeDb(seed());
    const result = await assertSettingsScopeOwned(db, OWNER, { workspaceId: WORKSPACE_OWNED });
    expect(result).toEqual({ ok: true, ownerUserId: OWNER, workspaceId: WORKSPACE_OWNED, propertyId: null });
  });

  it("refuses another owner's workspace with no module given (ownership-only)", async () => {
    const db = makeDb(seed());
    const result = await assertSettingsScopeOwned(db, OWNER, { workspaceId: WORKSPACE_FOREIGN });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
  });

  it("refuses a workspaceId that does not exist at all", async () => {
    const db = makeDb(seed());
    const result = await assertSettingsScopeOwned(db, OWNER, { workspaceId: "does-not-exist" });
    expect(result.ok).toBe(false);
  });
});
