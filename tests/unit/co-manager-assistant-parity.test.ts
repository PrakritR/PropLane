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
 * The provisioning half. Both capabilities were once gated on being the PRIMARY manager; the
 * refusals are gone, and these read the source so a gate cannot quietly come back — a returned
 * `canRequest: false` is invisible in a diff but removes the button entirely.
 */
describe("work number and work email are open to co-managers", () => {
  const messaging = readFileSync("src/app/api/manager/messaging-number/route.ts", "utf8");
  const assistantEmail = readFileSync("src/app/api/manager/assistant-email/route.ts", "utf8");

  it("neither route's canRequest depends on being the primary manager", () => {
    for (const [name, source] of [["messaging-number", messaging], ["assistant-email", assistantEmail]] as const) {
      const start = source.indexOf("canRequest:");
      expect(start, `${name} has no canRequest`).toBeGreaterThan(-1);
      const clause = source.slice(start, start + 400);
      expect(clause, name).not.toContain('workspaceRole === "primary"');
      expect(clause, name).not.toContain("!pureCoManager");
    }
  });

  it("the UI panels use the co-manager flag for wording only, never to hide the control", () => {
    for (const path of [
      "src/components/portal/pro-messaging-settings-panel.tsx",
      "src/components/portal/pro-assistant-email-settings-panel.tsx",
    ]) {
      const source = readFileSync(path, "utf8");
      // A gate would read `isCoManager ? null :` or `!isCoManager &&` around the request action.
      expect(source, path).not.toMatch(/isCoManager\s*\?\s*null/);
      expect(source, path).not.toMatch(/!isCoManager\s*&&\s*</);
    }
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
