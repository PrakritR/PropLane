import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

/**
 * Mover against the DEV/TEST Supabase project only (emstjswhotsnyksqhqyf). Opt in with MOVER_DEV_WORKSPACE=<client-owned
 * is_service workspace id> (and MOVER_DEV_APPLY=1 to run the apply -> read-back -> undo cycle). Skipped otherwise.
 * It proves: the dry run has no stops and no unclassified table; apply moves the workspace and houses to the service owner, seats
 * the client as the owner of record, leaves listing content byte-identical; a second call says already_moved; undo restores it.
 */
const DEV_REF = "emstjswhotsnyksqhqyf";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const ws = process.env.MOVER_DEV_WORKSPACE ?? "";
const enabled = Boolean(ws && url.includes(DEV_REF) && key);
const suite = enabled ? describe : describe.skip;
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

suite("managed workspace mover on dev", () => {
  const client = () => createClient(url, key, { auth: { persistSession: false } });
  it("dry run: no stops, nothing unclassified", async () => {
    const db = client();
    const owner = (await db.from("portal_workspaces").select("owner_user_id").eq("id", ws).single()).data!.owner_user_id as string;
    const { data, error } = await db.rpc("move_managed_workspace_to_service_owner", { p_workspace: ws, p_expected_from: owner, p_dry_run: true });
    expect(error).toBeNull();
    expect(data.stops).toEqual([]);
    expect(data.unclassified).toEqual({});
    expect(data.status).toBe("dry_run");
  });
  (process.env.MOVER_DEV_APPLY === "1" ? it : it.skip)("apply -> read-back -> already_moved -> undo", async () => {
    const db = client();
    const before = (await db.from("portal_workspaces").select("owner_user_id").eq("id", ws).single()).data!.owner_user_id as string;
    const housesBefore = (await db.from("manager_property_records").select("id, property_data, row_data").eq("workspace_id", ws).order("id")).data!;
    const moved = await db.rpc("move_managed_workspace_to_service_owner", { p_workspace: ws, p_expected_from: before, p_dry_run: false });
    expect(moved.error).toBeNull();
    expect(moved.data.status).toBe("moved");
    const to = moved.data.to as string;
    expect((await db.from("portal_workspaces").select("owner_user_id").eq("id", ws).single()).data!.owner_user_id).toBe(to);
    const housesAfter = (await db.from("manager_property_records").select("id, manager_user_id, property_data, row_data").eq("workspace_id", ws).order("id")).data!;
    expect(housesAfter.every((h) => h.manager_user_id === to)).toBe(true);
    expect(hash(housesAfter.map((h) => [h.id, h.property_data, h.row_data]))).toBe(hash(housesBefore.map((h) => [h.id, h.property_data, h.row_data])));
    const seat = await db.from("account_link_invites").select("*").eq("workspace_id", ws).eq("invitee_user_id", before).eq("team_role", "property_owner").eq("status", "accepted").maybeSingle();
    expect(seat.data).toMatchObject({ inviter_user_id: to, is_owner_of_record: true, is_service_seat: false });
    expect((await db.rpc("move_managed_workspace_to_service_owner", { p_workspace: ws, p_expected_from: before, p_dry_run: false })).data.status).toBe("already_moved");
    expect((await db.rpc("undo_managed_workspace_move", { p_workspace: ws })).data.status).toBe("undone");
    expect((await db.from("portal_workspaces").select("owner_user_id").eq("id", ws).single()).data!.owner_user_id).toBe(before);
  });
});
