import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Every manager reaches the PropLane assistant with the SAME reach on every surface — co-manager
 * or not. The work number and the work email both belong to the WORKSPACE: a co-manager sends and
 * replies from the owner's, and never gets one of their own.
 *
 * That last clause is the one that broke. A pure co-manager owns no properties, and every
 * manager tool filters on `landlordId`, so the widening in `managerSmsAccess` is what makes the
 * assistant able to answer at all. The SMS and email paths set it; the PORTAL path did not — so
 * the same person got useful answers by text and an empty portfolio in the app.
 */

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  user: { id: "co-1" } as { id: string } | null,
  profile: { email: "co@axis.test", role: "manager" } as Row | null,
  roles: [{ role: "manager" }] as Row[],
  invites: [] as Row[],
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: state.user } }) },
  }),
}));

vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: async () => false }));

function table(rows: Row[]) {
  const filters: [string, unknown][] = [];
  const api = {
    select: () => api,
    eq: (c: string, v: unknown) => {
      filters.push([c, v]);
      return api;
    },
    in: () => api,
    order: () => api,
    maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
    then: (resolve: (v: { data: Row[]; error: null }) => unknown) =>
      resolve({ data: rows.filter((r) => filters.every(([c, v]) => r[c] === undefined || r[c] === v)), error: null }),
  };
  return api;
}

vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from: (name: string) => {
      if (name === "profiles") return table(state.profile ? [state.profile] : []);
      if (name === "profile_roles") return table(state.roles);
      if (name === "account_link_invites") return table(state.invites);
      return table([]);
    },
  }),
}));

beforeEach(() => {
  state.user = { id: "co-1" };
  state.profile = { email: "co@axis.test", role: "manager" };
  state.roles = [{ role: "manager" }];
  state.invites = [];
});

describe("the portal assistant reaches a co-manager's assigned houses", () => {
  it("carries the co-managed owners, not just the co-manager's own empty portfolio", async () => {
    state.invites = [
      { status: "accepted", inviter_user_id: "owner-1", invitee_user_id: "co-1", assigned_property_ids: ["prop-a"] },
    ];
    const { resolveAgentContext } = await import("@/lib/tools/context");

    const ctx = await resolveAgentContext();

    expect(ctx?.landlordId).toBe("co-1");
    expect(ctx?.managerSmsAccess?.mode).toBe("combined");
    expect(ctx?.managerSmsAccess?.dataOwnerIds).toEqual(expect.arrayContaining(["co-1", "owner-1"]));
    expect(ctx?.managerSmsAccess?.assignedPropertyIds).toEqual(["prop-a"]);
  });

  it("changes nothing for a manager with no incoming assignments", async () => {
    const { resolveAgentContext } = await import("@/lib/tools/context");

    const ctx = await resolveAgentContext();

    expect(ctx?.managerSmsAccess?.mode).toBe("owner");
    expect(ctx?.managerSmsAccess?.assignedPropertyIds).toEqual([]);
  });

  it("still refuses a non-manager", async () => {
    state.roles = [{ role: "resident" }];
    state.profile = { email: "r@axis.test", role: "resident" };
    const { resolveAgentContext } = await import("@/lib/tools/context");

    expect(await resolveAgentContext()).toBeNull();
  });
});

/**
 * The provisioning half, and it is SYMMETRIC: both channels belong to the
 * workspace. A co-manager sends from the owner's line and the owner's address
 * and never gets a Request button for either, because a prospect reaching the
 * workspace must not be able to tell (and should never be bounced by) which
 * teammate set the channel up. These read the source so neither rule can
 * quietly flip.
 */
describe("the work email belongs to the workspace, exactly like the work number", () => {
  const messaging = readFileSync("src/app/api/manager/messaging-number/route.ts", "utf8");
  const assistantEmail = readFileSync("src/app/api/manager/assistant-email/route.ts", "utf8");

  it("assistant-email's canRequest is off for a pure co-manager, and POST refuses before billing", () => {
    const start = assistantEmail.indexOf("canRequest:");
    expect(start).toBeGreaterThan(-1);
    expect(assistantEmail.slice(start, start + 200)).toContain("!pureCoManager");
    const post = assistantEmail.slice(assistantEmail.indexOf("export async function POST"));
    expect(post.indexOf("workspace_email_shared")).toBeGreaterThan(-1);
    expect(post.indexOf("workspace_email_shared")).toBeLessThan(
      post.indexOf("const entitlement = await reconcileManagerSmsEntitlement("),
    );
  });

  it("messaging-number's canRequest is off for a pure co-manager, and POST refuses before billing", () => {
    const start = messaging.indexOf("canRequest:");
    expect(start).toBeGreaterThan(-1);
    expect(messaging.slice(start, start + 200)).toContain("!pureCoManager");
    const post = messaging.slice(messaging.indexOf("export async function POST"));
    expect(post.indexOf("workspace_number_shared")).toBeGreaterThan(-1);
    expect(post.indexOf("workspace_number_shared")).toBeLessThan(post.indexOf("const entitlement = await reconcileManagerSmsEntitlement("));
  });

  it("the assistant-email panel gives a co-manager the workspace address, not a Request button", () => {
    const source = readFileSync("src/components/portal/pro-assistant-email-settings-panel.tsx", "utf8");
    expect(source).toContain("status.workspaceEmail");
    expect(source).toContain('label="Managed by"');
  });
});

/**
 * The identity half: a manager's outbound mail carries the WORKSPACE work email with the
 * sender's own name on it, from BOTH send paths — the compose route was the one still
 * leaving as the shared "PropLane" sender.
 */
describe("outbound identity is the workspace address on every manager send path", () => {
  it("the shared delivery path resolves the sender's workspace work email", () => {
    const delivery = readFileSync("src/lib/portal-inbox-delivery.ts", "utf8");
    expect(delivery).toContain("resolveManagerOutboundFrom");
    expect(delivery).toContain("fromAddress");
  });

  it("the compose route does too, for manager senders only", () => {
    const route = readFileSync("src/app/api/portal/send-inbox-message/route.ts", "utf8");
    expect(route).toContain("resolveManagerOutboundFrom(db, user.id)");
    expect(route).toMatch(/senderRole === "manager"\s*\?\s*await resolveManagerOutboundFrom/);
  });

  it("the identity resolver reads the workspace address", () => {
    const identity = readFileSync("src/lib/manager-outbound-identity.server.ts", "utf8");
    expect(identity).toContain("resolveWorkspaceWorkEmail");
  });

  it("the email transport prefers it over the shared sender", () => {
    const send = readFileSync("src/lib/portal-email-send.server.ts", "utf8");
    expect(send).toMatch(/opts\.fromAddress\?\.trim\(\)\s*\|\|\s*process\.env\.RESEND_FROM/);
  });
});
