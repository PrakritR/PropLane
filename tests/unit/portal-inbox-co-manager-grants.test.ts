import { describe, expect, it } from "vitest";
import { viewerAndLinkedOwnerIdsForModule } from "@/lib/auth/co-manager-module-scope";

type LinkRow = {
  inviter_user_id: string;
  invitee_user_id: string;
  status: string;
  assigned_property_ids: string[];
  property_co_manager_permissions?: unknown;
  co_manager_permissions?: unknown;
};

function makeDb(link: LinkRow[]) {
  const profiles: Record<string, { id: string; email: string }> = {
    viewer: { id: "viewer", email: "viewer@example.com" },
    owner: { id: "owner", email: "owner@example.com" },
  };
  return {
    from(table: string) {
      let filtered = table === "account_link_invites" ? link : Object.values(profiles);
      const chain = {
        select: () => chain,
        eq: (column: string, value: string) => {
          filtered = filtered.filter((row) => String((row as Record<string, unknown>)[column] ?? "") === value);
          return chain;
        },
        in: (column: string, values: string[]) => {
          filtered = filtered.filter((row) => values.includes(String((row as Record<string, unknown>)[column] ?? "")));
          return chain;
        },
        maybeSingle: async () => ({ data: filtered[0] ?? null, error: null }),
        then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
          Promise.resolve({ data: filtered, error: null }).then(resolve, reject),
      };
      return chain;
    },
  };
}

describe("portal inbox co-manager grant scope", () => {
  it("treats an assigned property with empty permissions as no inbox access", async () => {
    const db = makeDb([{
      inviter_user_id: "owner",
      invitee_user_id: "viewer",
      status: "accepted",
      assigned_property_ids: ["house"],
      property_co_manager_permissions: {},
    }]);

    await expect(viewerAndLinkedOwnerIdsForModule(db as never, "viewer", "inbox", "read"))
      .resolves.toEqual(["viewer"]);
  });

  it("normalizes a per-property read grant and excludes it from edit writes", async () => {
    const db = makeDb([{
      inviter_user_id: "owner",
      invitee_user_id: "viewer",
      status: "accepted",
      assigned_property_ids: ["house"],
      property_co_manager_permissions: { house: { inbox: { read: true } } },
    }]);

    await expect(viewerAndLinkedOwnerIdsForModule(db as never, "viewer", "inbox", "read"))
      .resolves.toEqual(["viewer", "owner"]);
    await expect(viewerAndLinkedOwnerIdsForModule(db as never, "viewer", "inbox", "edit"))
      .resolves.toEqual(["viewer"]);
  });

  it("normalizes an edit grant for both read and edit scope", async () => {
    const db = makeDb([{
      inviter_user_id: "owner",
      invitee_user_id: "viewer",
      status: "accepted",
      assigned_property_ids: ["house"],
      property_co_manager_permissions: { house: { inbox: { read: true, edit: true } } },
    }]);

    await expect(viewerAndLinkedOwnerIdsForModule(db as never, "viewer", "inbox", "read"))
      .resolves.toEqual(["viewer", "owner"]);
    await expect(viewerAndLinkedOwnerIdsForModule(db as never, "viewer", "inbox", "edit"))
      .resolves.toEqual(["viewer", "owner"]);
  });
});
