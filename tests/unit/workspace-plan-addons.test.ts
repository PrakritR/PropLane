import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getEffectiveManagerSkuTier: vi.fn(),
}));

vi.mock("@/lib/manager-access-server", () => ({
  getEffectiveManagerSkuTier: mocks.getEffectiveManagerSkuTier,
}));

import { loadWorkspacePlan } from "@/lib/workspaces/server";

const OWNER = "owner-123";

const workspaces = [
  {
    id: "default",
    name: "My workspace",
    ownerUserId: OWNER,
    owned: true,
    isDefault: true,
    propertyIds: ["house-1", "house-2"],
    propertyPermissions: {},
  },
  {
    id: "second",
    name: "Second team",
    ownerUserId: OWNER,
    owned: true,
    isDefault: false,
    propertyIds: ["house-3"],
    propertyPermissions: {},
  },
  {
    id: "shared",
    name: "Shared team",
    ownerUserId: "other-owner",
    owned: false,
    isDefault: false,
    propertyIds: ["house-4"],
    propertyPermissions: {},
  },
];

function dbFor(options: { addonRows?: unknown[]; addonError?: { message: string } | null } = {}) {
  const addonRows = options.addonRows ?? [];
  const addonError = options.addonError ?? null;
  return {
    from(table: string) {
      const q: Record<string, unknown> = {};
      q.select = vi.fn(() => q);
      q.eq = vi.fn(() => q);
      q.then = (resolve: (value: unknown) => unknown) => {
        if (table === "account_link_invites") return Promise.resolve({ count: 4, error: null }).then(resolve);
        if (table === "manager_vendor_records") return Promise.resolve({ count: 2, error: null }).then(resolve);
        if (table === "manager_plan_addons") return Promise.resolve({ data: addonRows, error: addonError }).then(resolve);
        throw new Error(`unexpected workspace-plan table: ${table}`);
      };
      return q;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getEffectiveManagerSkuTier.mockResolvedValue({ ok: true, tier: "business" });
});

describe("loadWorkspacePlan add-on capacity", () => {
  it("adds paid quantities on top of the normal plan caps", async () => {
    const plan = await loadWorkspacePlan(
      dbFor({
        addonRows: [
          { addon_id: "extra_workspace", quantity: 2 },
          // A retired `extra_listing` row (PLAN-DOOR step 2: paid tiers price
          // doors, not listings) must not crash this read or inflate
          // `propertyLimit` — it is silently ignored, exactly like any other
          // unrecognized `addon_id`.
          { addon_id: "extra_listing", quantity: 3 },
          { addon_id: "extra_seat", quantity: 4 },
        ],
      }) as never,
      OWNER,
      workspaces,
    );

    expect(plan).toMatchObject({
      tier: "business",
      unknown: false,
      // Business includes 2 workspaces (PLAN-0920) + the 2 held by the add-on.
      workspaceLimit: 4,
      propertyLimit: 20,
      recordsPerWorkspace: 10,
      teamLimit: 24,
      usage: { workspaces: 2, properties: 3, team: 4, vendors: 2 },
    });
  });

  it("treats a successful empty add-on read as zero purchased capacity", async () => {
    const plan = await loadWorkspacePlan(dbFor() as never, OWNER, workspaces);

    expect(plan).toMatchObject({
      tier: "business",
      unknown: false,
      workspaceLimit: 2,
      propertyLimit: 20,
      teamLimit: 20,
    });
  });

  it("grandfathers an existing Business account already holding 3 workspaces (2 owned + 1 more) rather than stranding it below the new 2-workspace cap", async () => {
    const threeOwnedWorkspaces = [
      ...workspaces,
      {
        id: "third",
        name: "Third team",
        ownerUserId: OWNER,
        owned: true,
        isDefault: false,
        propertyIds: ["house-5"],
        propertyPermissions: {},
      },
    ];

    const plan = await loadWorkspacePlan(dbFor() as never, OWNER, threeOwnedWorkspaces);

    // 3 owned workspaces exceeds the new 2-workspace plan cap; the account keeps all 3.
    expect(plan.workspaceLimit).toBe(3);
    expect(plan.usage.workspaces).toBe(3);
  });

  it.each([
    ["an ordinary read failure", "manager_plan_addons read timed out"],
    ["a PostgREST schema-cache failure", "Could not find the table 'public.manager_plan_addons' in the schema cache"],
    ["a PostgreSQL missing-relation failure", 'relation "public.manager_plan_addons" does not exist'],
  ])("marks the plan unknown for %s", async (_label, message) => {
    const plan = await loadWorkspacePlan(
      dbFor({ addonError: { message } }) as never,
      OWNER,
      workspaces,
    );

    expect(plan.unknown).toBe(true);
    expect(plan.tier).toBe("business");
    expect(plan.workspaceLimit).not.toBe(0);
    expect(plan.propertyLimit).toBeNull();
    expect(plan.teamLimit).toBeNull();
  });
});
