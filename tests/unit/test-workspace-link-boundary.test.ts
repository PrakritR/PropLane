import { describe, expect, it } from "vitest";

import { assertTestWorkspacePrincipalCompatibility } from "@/lib/test-workspaces/index.server";

const ACTOR = "11111111-1111-4111-8111-111111111111";
const RELATED = "22222222-2222-4222-8222-222222222222";
const WORKSPACE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKSPACE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function relationshipDb(classifications: Record<string, unknown>) {
  return {
    from(table: string) {
      let requestedId = ACTOR;
      const query: Record<string, unknown> = {};
      query.select = () => query;
      query.eq = (key: string, value: unknown) => { if (key === "user_id") requestedId = String(value); return query; };
      query.in = async () => table === "profiles"
        ? { data: [], error: null }
        : { data: classifications[ACTOR] ?? null, error: null };
      query.maybeSingle = async () => {
        return { data: classifications[requestedId] ?? null, error: null };
      };
      return query;
    },
  };
}

describe("test workspace account and vendor relationship boundary", () => {
  it("rejects a classified actor linking to a normal principal", async () => {
    const db = relationshipDb({
      [ACTOR]: { workspace_id: WORKSPACE_A, portal_role: "manager", state: "active", expires_at: null, workspace: { status: "active" } },
      [RELATED]: null,
    });
    await expect(assertTestWorkspacePrincipalCompatibility({ actorUserId: ACTOR, relatedUserIds: [RELATED], db: db as never })).rejects.toThrow("Cross-workspace relationship refused");
  });

  it("rejects classified principals from different workspaces", async () => {
    const db = relationshipDb({
      [ACTOR]: { workspace_id: WORKSPACE_A, portal_role: "manager", state: "active", expires_at: null, workspace: { status: "active" } },
      [RELATED]: { workspace_id: WORKSPACE_B, portal_role: "resident", state: "active", expires_at: null, workspace: { status: "active" } },
    });
    await expect(assertTestWorkspacePrincipalCompatibility({ actorUserId: ACTOR, relatedUserIds: [RELATED], db: db as never })).rejects.toThrow("Cross-workspace relationship refused");
  });

  it("allows a same-workspace account/vendor relationship", async () => {
    const db = relationshipDb({
      [ACTOR]: { workspace_id: WORKSPACE_A, portal_role: "manager", state: "active", expires_at: null, workspace: { status: "active" } },
      [RELATED]: { workspace_id: WORKSPACE_A, portal_role: "resident", state: "active", expires_at: null, workspace: { status: "active" } },
    });
    await expect(assertTestWorkspacePrincipalCompatibility({ actorUserId: ACTOR, relatedUserIds: [RELATED], db: db as never })).resolves.toBeUndefined();
  });

  it("rejects a normal customer linking to a classified principal", async () => {
    const db = relationshipDb({
      [ACTOR]: null,
      [RELATED]: { workspace_id: WORKSPACE_A, portal_role: "resident", state: "active", expires_at: null, workspace: { status: "active" } },
    });
    await expect(assertTestWorkspacePrincipalCompatibility({ actorUserId: ACTOR, relatedUserIds: [RELATED], db: db as never })).rejects.toThrow("Cross-workspace relationship refused");
  });
});
