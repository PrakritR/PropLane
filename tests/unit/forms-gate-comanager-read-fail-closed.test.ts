/**
 * The forms gate (loadCallerScopedResidentBlockingForms) asks "does the caller hold this form?" through the
 * co-manager link read. A failed read there used to log and come back as "no grant" — the form was dropped
 * from the count and the gate opened. It must report readFailed (the route turns that into a 503).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/workspaces/scope.server", () => ({ activeWorkspacePropertyScope: vi.fn(async () => null) }));

const CALLER = "mgr-caller";
type Fail = { links?: boolean; property?: boolean };

function makeDb(fail: Fail) {
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const result = () => {
        if (table === "resident_move_in_forms") {
          return {
            data: [
              {
                id: "f1",
                form_id: "x",
                status: "sent",
                snapshot: { kind: "other", blocks: "approval" },
                manager_user_id: "someone-else",
                property_id: "p1",
                resident_user_id: null,
              },
            ],
            error: null,
          };
        }
        if (table === "account_link_invites") {
          return fail.links ? { data: null, error: { message: "connection reset" } } : { data: [], error: null };
        }
        if (table === "manager_property_records") {
          if (filters.manager_user_id) return { data: [], error: null };
          return fail.property
            ? { data: null, error: { message: "timeout" } }
            : { data: { manager_user_id: "someone-else" }, error: null };
        }
        return { data: [], error: null };
      };
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (c: string, v: unknown) => {
          filters[c] = v;
          return builder;
        },
        in: () => builder,
        maybeSingle: () => Promise.resolve(result()),
        then: (resolve: (v: unknown) => unknown) => Promise.resolve(result()).then(resolve),
      };
      return builder;
    },
  };
}

async function gate(fail: Fail) {
  const { loadCallerScopedResidentBlockingForms } = await import("@/lib/resident-approval.server");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return loadCallerScopedResidentBlockingForms(makeDb(fail) as any, { userId: CALLER, isAdmin: false }, "r@example.com");
}

describe("forms gate fails closed on a co-manager read error", () => {
  it("a failed account_link_invites read reports readFailed, never 'not held'", async () => {
    const result = await gate({ links: true });
    expect(result.readFailed).toBe(true);
    expect(result.approval).toBe(true);
  });

  it("a failed manager_property_records owner read reports readFailed", async () => {
    const result = await gate({ property: true });
    expect(result.readFailed).toBe(true);
  });

  it("healthy reads still treat another landlord's form as not held (no block, no readFailed)", async () => {
    const result = await gate({});
    expect(result.readFailed).toBeUndefined();
    expect(result.approval).toBe(false);
  });

  it("the default (non-strict) co-manager helpers still degrade for unrelated list reads", async () => {
    const { collectLinkedPropertyPermissionsForUser } = await import("@/lib/auth/manager-lease-scope");
    vi.spyOn(console, "error").mockImplementation(() => {});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const map = await collectLinkedPropertyPermissionsForUser(makeDb({ links: true }) as any, CALLER);
    expect(map.size).toBe(0);
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      collectLinkedPropertyPermissionsForUser(makeDb({ links: true }) as any, CALLER, { strict: true }),
    ).rejects.toThrow(/lookup failed/);
  });
});
