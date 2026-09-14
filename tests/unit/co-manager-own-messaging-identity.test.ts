import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

/**
 * A co-manager sends and replies from the WORKSPACE's work number and work
 * email — one of each per workspace, held by the owner — and their assistant is
 * scoped to the houses assigned to them. The first half pins that scope; the
 * second half pins that neither channel is ever minted for a co-manager, and
 * that the settings copy says whose it is rather than offering a request.
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

describe("provisioning is refused for a pure co-manager, on both channels", () => {
  const ROUTE = readFileSync(
    join(process.cwd(), "src/app/api/manager/assistant-email/route.ts"),
    "utf8",
  );

  it("the assistant-email request is a 409 workspace_email_shared, not a 403 with a redirect", () => {
    expect(ROUTE).toContain('code: "workspace_email_shared"');
    expect(ROUTE).not.toContain("Co-managers use the account owner's assistant email.");
  });

  it("the work number request is the matching 409", () => {
    const numberRoute = readFileSync(
      join(process.cwd(), "src/app/api/manager/messaging-number/route.ts"),
      "utf8",
    );
    expect(numberRoute).toContain('code: "workspace_number_shared"');
  });
});

describe("the settings copy names the workspace channel instead of offering a request", () => {
  it("the assistant email panel shows a co-manager the workspace address and who manages it", () => {
    const panel = readFileSync(
      join(process.cwd(), "src/components/portal/pro-assistant-email-settings-panel.tsx"),
      "utf8",
    );
    expect(panel).toContain('label="Workspace email"');
    expect(panel).toContain('label="Managed by"');
    expect(panel).not.toContain("Request your own address");
  });

  it("the work number panel does the same", () => {
    const panel = readFileSync(
      join(process.cwd(), "src/components/portal/pro-messaging-settings-panel.tsx"),
      "utf8",
    );
    expect(panel).toContain('label="Workspace number"');
    expect(panel).toContain('label="Managed by"');
  });
});

describe("the status endpoint reports the workspace address and withholds the button", () => {
  const ROUTE = readFileSync(
    join(process.cwd(), "src/app/api/manager/assistant-email/route.ts"),
    "utf8",
  );

  it("canRequest is off for a pure co-manager and still gated on storage and billing", () => {
    const start = ROUTE.indexOf("canRequest:");
    const canRequest = ROUTE.slice(start, start + 200);
    expect(canRequest).toContain("!pureCoManager");
    expect(canRequest).toContain("storageReady");
    // The plan/billing half comes from the gate shared with the work number.
    expect(canRequest).toContain("canRequestBilling");
    expect(ROUTE).toContain("managerCommsRequestIsOfferable");
  });

  it("hands a co-manager the workspace address the way the number route hands the workspace number", () => {
    expect(ROUTE).toContain("resolveWorkspaceWorkEmails(db, userId)");
    expect(ROUTE).toContain("workspaceEmail,");
  });

  it("still REPORTS the role, which the copy uses", () => {
    expect(ROUTE).toContain('const workspaceRole = pureCoManager ? "co_manager" : "primary"');
  });
});
