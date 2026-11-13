import { describe, expect, it } from "vitest";
import { createFakeDb } from "../helpers/fake-table-db";

describe("fake workspace provisioning", () => {
  it("returns the same default for one owner and separate defaults for different owners", async () => {
    const db = createFakeDb();
    const first = await db.rpc("ensure_default_portal_workspace", { p_owner: "owner-a" });
    const again = await db.rpc("ensure_default_portal_workspace", { p_owner: "owner-a" });
    const other = await db.rpc("ensure_default_portal_workspace", { p_owner: "owner-b" });
    expect(first.error).toBeNull();
    expect(again.data).toBe(first.data);
    expect(other.data).not.toBe(first.data);
    expect(db.tables.portal_workspaces).toEqual([
      expect.objectContaining({ id: first.data, owner_user_id: "owner-a", name: "My workspace", is_default: true }),
      expect.objectContaining({ id: other.data, owner_user_id: "owner-b", name: "My workspace", is_default: true }),
    ]);
  });

  it("honors explicit overrides and refuses unknown RPCs", async () => {
    const db = createFakeDb({}, { rpc: (name) => name === "ensure_default_portal_workspace" ? { data: "override" } : undefined });
    expect(await db.rpc("ensure_default_portal_workspace", { p_owner: "owner" })).toEqual({ data: "override", error: null });
    expect(db.tables.portal_workspaces).toBeUndefined();
    expect(await db.rpc("unknown_rpc")).toEqual({ data: null, error: { message: "Unsupported fake RPC: unknown_rpc" } });
  });
});
