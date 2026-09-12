import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Every manager gets their own work number, their own work email, and the PropLane assistant —
 * co-manager or not, and with the SAME reach on every surface.
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
 * The provisioning half — and it is deliberately ASYMMETRIC now.
 *
 * Work EMAIL stays per manager: a co-manager gets their own address. Work
 * NUMBER is per WORKSPACE: a co-manager sends from the owner's line and never
 * gets a Request button, because a prospect texting the workspace must not be
 * able to tell (and should never be bounced by) which teammate set the line
 * up. These read the source so neither rule can quietly flip.
 */
describe("work email is open to co-managers; the work number belongs to the workspace", () => {
  const messaging = readFileSync("src/app/api/manager/messaging-number/route.ts", "utf8");
  const assistantEmail = readFileSync("src/app/api/manager/assistant-email/route.ts", "utf8");

  it("assistant-email's canRequest does not depend on being the primary manager", () => {
    const start = assistantEmail.indexOf("canRequest:");
    expect(start).toBeGreaterThan(-1);
    const clause = assistantEmail.slice(start, start + 400);
    expect(clause).not.toContain('workspaceRole === "primary"');
    expect(clause).not.toContain("!pureCoManager");
  });

  it("messaging-number's canRequest is off for a pure co-manager, and POST refuses before billing", () => {
    const start = messaging.indexOf("canRequest:");
    expect(start).toBeGreaterThan(-1);
    expect(messaging.slice(start, start + 200)).toContain("!pureCoManager");
    const post = messaging.slice(messaging.indexOf("export async function POST"));
    expect(post.indexOf("workspace_number_shared")).toBeGreaterThan(-1);
    expect(post.indexOf("workspace_number_shared")).toBeLessThan(post.indexOf("const entitlement = await reconcileManagerSmsEntitlement("));
  });

  it("the assistant-email panel uses the co-manager flag for wording only, never to hide the control", () => {
    const source = readFileSync("src/components/portal/pro-assistant-email-settings-panel.tsx", "utf8");
    expect(source).not.toMatch(/isCoManager\s*\?\s*null/);
    expect(source).not.toMatch(/!isCoManager\s*&&\s*</);
  });
});

/**
 * The identity half: a manager's outbound mail carries their OWN work email, which is what
 * makes "each manager gets their own" true rather than cosmetic.
 */
describe("outbound identity is per manager", () => {
  it("the shared delivery path resolves the sender's own work email", () => {
    const delivery = readFileSync("src/lib/portal-inbox-delivery.ts", "utf8");
    expect(delivery).toContain("resolveManagerOutboundFrom");
    expect(delivery).toContain("fromAddress");
  });

  it("the email transport prefers it over the shared sender", () => {
    const send = readFileSync("src/lib/portal-email-send.server.ts", "utf8");
    expect(send).toMatch(/opts\.fromAddress\?\.trim\(\)\s*\|\|\s*process\.env\.RESEND_FROM/);
  });
});
