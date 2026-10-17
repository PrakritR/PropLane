import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveWorkspaceSendLine } from "@/lib/sms/manager-workspace-role.server";

/**
 * A PostgREST-faithful double: `select()` PROJECTS each row down to the named
 * columns. `createMemoryDb` returns whole rows whatever the column list says,
 * so it cannot see a resolution that filters on a column it forgot to select —
 * which is exactly how the workspace split below can silently stop working.
 */
type Row = Record<string, unknown>;

function projectingDb(tables: Record<string, Row[]>, selects: string[]): SupabaseClient {
  const builder = (table: string) => {
    let columns: string[] = [];
    const filters: Array<(row: Row) => boolean> = [];
    const rows = () =>
      (tables[table] ?? [])
        .filter((row) => filters.every((f) => f(row)))
        .map((row) =>
          columns.includes("*")
            ? { ...row }
            : Object.fromEntries(columns.filter((c) => c in row).map((c) => [c, row[c]])),
        );
    const api = {
      select(list: string) {
        selects.push(`${table}:${list}`);
        columns = list.split(",").map((c) => c.trim());
        return api;
      },
      eq(col: string, value: unknown) {
        filters.push((row) => row[col] === value);
        return api;
      },
      order() {
        return api;
      },
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      then: (resolve: (value: { data: Row[]; error: null }) => unknown) =>
        Promise.resolve({ data: rows(), error: null }).then(resolve),
    };
    return api;
  };
  return { from: builder } as unknown as SupabaseClient;
}

const OWNER = "owner-1";
const DEFAULT_WS = "ws-default";
const OTHER_WS = "ws-other";

function db(selects: string[]) {
  return projectingDb(
    {
      manager_sms_numbers: [
        {
          id: "num-default",
          manager_user_id: OWNER,
          workspace_id: DEFAULT_WS,
          phone_number: "+12065550100",
          provision_state: "active",
          released_at: null,
        },
        {
          id: "num-other",
          manager_user_id: OWNER,
          workspace_id: OTHER_WS,
          phone_number: "+12065550200",
          provision_state: "active",
          released_at: null,
        },
      ],
      portal_workspaces: [
        { id: DEFAULT_WS, owner_user_id: OWNER, is_default: true },
        { id: OTHER_WS, owner_user_id: OWNER, is_default: false },
      ],
      workspace_work_numbers: [],
    },
    selects,
  );
}

function oneNumberDb(workspaceId: string | null) {
  return projectingDb(
    {
      manager_sms_numbers: [
        {
          id: "num-1",
          manager_user_id: OWNER,
          workspace_id: workspaceId,
          phone_number: workspaceId ? "+12065550100" : "+12065550300",
          provision_state: "active",
          released_at: null,
        },
      ],
      portal_workspaces: [
        { id: DEFAULT_WS, owner_user_id: OWNER, is_default: true },
        { id: OTHER_WS, owner_user_id: OWNER, is_default: false },
      ],
      workspace_work_numbers: [],
    },
    [],
  );
}

describe("resolveWorkspaceSendLine keeps each workspace on its own line", () => {
  it("returns the default workspace's own number for the default workspace", async () => {
    const line = await resolveWorkspaceSendLine(db([]), OWNER, DEFAULT_WS);
    expect(line).toEqual({ phoneNumber: "+12065550100", provisionState: "active" });
  });

  it("returns the non-default workspace's own number, never the default's", async () => {
    const line = await resolveWorkspaceSendLine(db([]), OWNER, OTHER_WS);
    expect(line).toEqual({ phoneNumber: "+12065550200", provisionState: "active" });
  });

  it("selects every column the resolution filters on", async () => {
    const selects: string[] = [];
    await resolveWorkspaceSendLine(db(selects), OWNER, DEFAULT_WS);
    const numberSelect = selects.find((s) => s.startsWith("manager_sms_numbers:"));
    expect(numberSelect).toContain("workspace_id");
    expect(numberSelect).toContain("released_at");
  });

  it("reports no line for a non-default workspace whose owner only has another workspace's number", async () => {
    const line = await resolveWorkspaceSendLine(oneNumberDb(DEFAULT_WS), OWNER, OTHER_WS);
    expect(line.phoneNumber).toBeNull();
  });

  it("falls back to the owner's legacy unplaced row only for their default workspace", async () => {
    expect((await resolveWorkspaceSendLine(oneNumberDb(null), OWNER, DEFAULT_WS)).phoneNumber).toBe(
      "+12065550300",
    );
    expect((await resolveWorkspaceSendLine(oneNumberDb(null), OWNER, OTHER_WS)).phoneNumber).toBeNull();
  });
});
