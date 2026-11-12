import { describe, expect, it } from "vitest";
import { fakeOwnerDb, type FakeRow } from "../helpers/owner-fake-db";
import { AccountDeletionBlockedError, assertManagedAccountDeletable, managedAccountDeletionBlocker } from "@/lib/auth/managed-account-deletion-guard.server";

const ADMIN = "admin-owner";
const CLIENT = "client-1";
const WS = "ws-managed";

function world(extra: Record<string, FakeRow[]> = {}, balance = { owed: 0, matured: 0, pending: 0 }) {
  return fakeOwnerDb(
    {
      platform_service_settings: [{ singleton: true, owner_user_id: ADMIN }],
      portal_workspaces: [{ id: WS, owner_user_id: ADMIN, is_service: true, name: "Ambika" }],
      account_link_invites: [{ id: "s1", workspace_id: WS, invitee_user_id: CLIENT, status: "accepted", team_role: "property_owner", is_owner_of_record: true }],
      managed_workspace_fee_policies: [{ id: "p1", workspace_id: WS, owner_user_id: CLIENT, status: "active", signed_at: "2026-10-20", owner_share_bps: 9000, applies_to: "rent", effective_from: "2026-10-01" }],
      ...extra,
    },
    { rpc: { party_balance: () => [balance] } },
  );
}

describe("deleting an account never takes a managed workspace's books with it", () => {
  it("refuses the service owner, and any account that owns an is_service workspace", async () => {
    const f = world();
    expect(await managedAccountDeletionBlocker(f.db, ADMIN)).toMatch(/service owner/i);
    const g = world({ platform_service_settings: [{ singleton: true, owner_user_id: "someone-else" }] });
    expect(await managedAccountDeletionBlocker(g.db, ADMIN)).toMatch(/owns PropLane-managed workspaces/i);
    await expect(assertManagedAccountDeletable(f.db, ADMIN)).rejects.toBeInstanceOf(AccountDeletionBlockedError);
  });

  it("refuses the client while they are the payee of a managed workspace with a fee policy (the policy would be purged with them)", async () => {
    const f = world();
    expect(await managedAccountDeletionBlocker(f.db, CLIENT)).toMatch(/property owner of a PropLane-managed workspace/i);
  });

  it("refuses the client with a non-zero owner payable balance even when no policy is active", async () => {
    const f = world({ managed_workspace_fee_policies: [] }, { owed: 12_000, matured: 12_000, pending: 0 });
    expect(await managedAccountDeletionBlocker(f.db, CLIENT)).toMatch(/balance/i);
  });

  it("lets a client with no managed seat, an ended seat or a replaced owner of record go", async () => {
    const plain = world();
    expect(await managedAccountDeletionBlocker(plain.db, "random-user")).toBeNull();
    const replaced = world({
      account_link_invites: [
        { id: "s1", workspace_id: WS, invitee_user_id: CLIENT, status: "accepted", team_role: "property_owner", is_owner_of_record: false },
        { id: "s2", workspace_id: WS, invitee_user_id: "new-owner", status: "accepted", team_role: "property_owner", is_owner_of_record: true },
      ],
      managed_workspace_fee_policies: [{ id: "p1", workspace_id: WS, owner_user_id: "new-owner", status: "active", signed_at: "2026-10-20", owner_share_bps: 9000, applies_to: "rent", effective_from: "2026-10-01" }],
    });
    expect(await managedAccountDeletionBlocker(replaced.db, CLIENT)).toBeNull();
  });

  it("fails closed: an unreadable read is a refusal, never 'safe to delete'", async () => {
    const f = fakeOwnerDb({ platform_service_settings: [{ singleton: true, owner_user_id: ADMIN }] }, { broken: [] });
    const broken = { ...f.db, from: () => { throw new Error("boom"); } } as never;
    expect(await managedAccountDeletionBlocker(broken, CLIENT)).toMatch(/could not check/i);
  });
});
