import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

/**
 * A co-manager was refused their own assistant email and told to use the
 * account owner's. That meant two people shared one mailbox and one assistant
 * identity: the owner saw the co-manager's questions in their own thread, and
 * the co-manager had nothing to hand a resident. Each manager who sets one up
 * now gets their own work number AND their own assistant email, scoped to the
 * houses assigned to them.
 */
const links = vi.hoisted(() => ({
  rows: [] as { inviter_user_id: string; assigned_property_ids: string[] }[],
  profiles: [] as { id: string; email: string }[],
}));

vi.mock("@/lib/portal-sandbox-accounts", () => ({ isCrossSandboxPortalPair: () => false }));

function fakeDb() {
  return {
    from(table: string) {
      if (table === "account_link_invites") {
        const builder: Record<string, unknown> = {
          select: () => builder,
          eq: () => builder,
          then: (resolve: (v: unknown) => unknown) =>
            Promise.resolve({ data: links.rows, error: null }).then(resolve),
        };
        return builder;
      }
      if (table === "profiles") {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: links.profiles[0] ?? null, error: null }) }),
            in: async () => ({ data: links.profiles, error: null }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as never;
}

import { resolveManagerSmsAccess } from "@/lib/sms/manager-sms-access.server";

describe("a co-manager's own number and address are scoped to their assigned houses", () => {
  it("scopes to every owner who assigned them, and to those houses only", async () => {
    links.rows = [
      { inviter_user_id: "owner-a", assigned_property_ids: ["prop-a1", "prop-a2"] },
      { inviter_user_id: "owner-b", assigned_property_ids: ["prop-b1"] },
    ];
    links.profiles = [{ id: "co-1", email: "co@example.com" }];

    const access = await resolveManagerSmsAccess(fakeDb(), {
      actorUserId: "co-1",
      workNumberOwnerId: "co-1",
    });

    expect(access).not.toBeNull();
    expect(access?.workNumberOwnerId).toBe("co-1");
    expect(access?.actorUserId).toBe("co-1");
    // The houses are the union of what each owner assigned — "same linked data
    // about the house", reached through their own number.
    expect(access?.assignedPropertyIds.sort()).toEqual(["prop-a1", "prop-a2", "prop-b1"]);
    expect(access?.dataOwnerIds).toContain("owner-a");
    expect(access?.dataOwnerIds).toContain("owner-b");
  });

  it("gives a co-manager with no assignments no scope at all", async () => {
    links.rows = [];
    links.profiles = [{ id: "co-1", email: "co@example.com" }];
    const access = await resolveManagerSmsAccess(fakeDb(), {
      actorUserId: "co-1",
      workNumberOwnerId: "co-1",
    });
    // `owner` mode over an empty portfolio: nothing to answer about, and no
    // other owner's rows reachable.
    expect(access?.mode).toBe("owner");
    expect(access?.dataOwnerIds).toEqual(["co-1"]);
    expect(access?.assignedPropertyIds).toEqual([]);
  });
});

describe("provisioning is no longer refused", () => {
  const ROUTE = readFileSync(
    join(process.cwd(), "src/app/api/manager/assistant-email/route.ts"),
    "utf8",
  );

  it("the assistant-email request no longer 403s a co-manager", () => {
    expect(ROUTE).not.toContain("Co-managers use the account owner's assistant email.");
  });

  it("the work number never refused one, and still does not", () => {
    // Worth pinning: the docs said only property owners could provision, but the
    // route only ever required plan eligibility — which a co-manager inherits
    // from an inviter (getEffectiveManagerSmsEntitlement).
    const numberRoute = readFileSync(
      join(process.cwd(), "src/app/api/manager/messaging-number/route.ts"),
      "utf8",
    );
    expect(numberRoute).not.toMatch(/co-?managers?[^.]*owner'?s? (work )?number/i);
  });
});

describe("the settings copy offers it rather than redirecting", () => {
  it("the assistant email panel tells a co-manager to request their own", () => {
    const panel = readFileSync(
      join(process.cwd(), "src/components/portal/pro-assistant-email-settings-panel.tsx"),
      "utf8",
    );
    expect(panel).toContain("Request your own address");
    expect(panel).not.toContain("Email the workspace owner's assistant address");
    expect(panel).not.toContain("Co-managers email the account owner's assistant address");
  });

  it("the work number panel already described a co-manager's own number", () => {
    const panel = readFileSync(
      join(process.cwd(), "src/components/portal/pro-messaging-settings-panel.tsx"),
      "utf8",
    );
    expect(panel).toContain("Your dedicated PropLane number for resident and prospect texts");
  });
});

describe("the status endpoint actually offers it", () => {
  const ROUTE = readFileSync(
    join(process.cwd(), "src/app/api/manager/assistant-email/route.ts"),
    "utf8",
  );

  it("canRequest no longer depends on the workspace role", () => {
    // This was the gate that actually mattered. The POST refusal was visible;
    // this one quietly made the request button never appear for a co-manager,
    // so removing only the refusal would have left the feature unreachable.
    const canRequest = ROUTE.slice(ROUTE.indexOf("canRequest:"), ROUTE.indexOf("canUse:"));
    expect(canRequest).not.toContain('workspaceRole === "primary"');
    expect(canRequest).toContain("storageReady");
    expect(canRequest).toContain("entitlementCanBeReconciled");
  });

  it("provisioningAvailable does not either", () => {
    const line = ROUTE.slice(ROUTE.indexOf("provisioningAvailable:"), ROUTE.indexOf("storageReady,"));
    expect(line).not.toContain("workspaceRole");
  });

  it("still REPORTS the role, which the copy uses", () => {
    // Removing the gate must not remove the distinction: a co-manager's
    // assistant answers about assigned houses, not a portfolio they own, and
    // the settings copy says so.
    expect(ROUTE).toContain('const workspaceRole = pureCoManager ? "co_manager" : "primary"');
  });
});
