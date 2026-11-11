/**
 * `getPortalAccessContext` starts the viewer's role read beside the phone gate. The gate still decides first:
 * when it redirects the roles are never returned, and a failed role read is "no roles" (never a thrown error,
 * never a role the account does not hold).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  needsPhone: false,
  roleRows: [{ role: "manager" }] as { role: string }[],
  roleError: null as { message: string } | null,
  roleThrows: false,
  roleReads: 0,
}));

vi.mock("react", async (orig) => ({ ...(await orig<typeof import("react")>()), cache: <T,>(fn: T) => fn }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => ({ get: () => null }),
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  },
}));
vi.mock("@/lib/auth/server-profile", () => ({
  getServerSessionProfile: async () => ({ user: { id: "u1" }, profile: null, viewAs: null }),
}));
vi.mock("@/lib/auth/phone-auth.server", () => ({ needsPhoneVerification: async () => state.needsPhone }));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    from: () => ({
      select: () => ({
        eq: async () => {
          state.roleReads += 1;
          if (state.roleThrows) throw new Error("db down");
          return { data: state.roleRows, error: state.roleError };
        },
      }),
    }),
  }),
}));

import { getPortalAccessContext } from "@/lib/auth/portal-access";

beforeEach(() => {
  state.needsPhone = false;
  state.roleRows = [{ role: "manager" }];
  state.roleError = null;
  state.roleThrows = false;
  state.roleReads = 0;
});

describe("getPortalAccessContext: roles overlap the phone gate, the gate still wins", () => {
  it("an unverified phone redirects and returns no context, even though the role read started", async () => {
    state.needsPhone = true;
    await expect(getPortalAccessContext()).rejects.toThrow(/NEXT_REDIRECT/);
  });

  it("a verified account gets its roles", async () => {
    const ctx = await getPortalAccessContext();
    expect(ctx.roles).toEqual(["manager"]);
    expect(state.roleReads).toBe(1);
  });

  it("a role read error or throw is no roles, never a thrown error and never a granted role", async () => {
    state.roleError = { message: "boom" };
    expect((await getPortalAccessContext()).roles).toEqual([]);
    state.roleError = null;
    state.roleThrows = true;
    expect((await getPortalAccessContext()).roles).toEqual([]);
  });
});
