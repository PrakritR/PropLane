/**
 * A "View as" session provisions nothing.
 *
 * `ensure_default_portal_workspace` INSERTs, and `rpc()` is outside the
 * service-role write guard (`view-as-read-only.ts` says so), so every
 * heal-on-read path has to ask `isViewAsSessionOpen()` itself. Both callers of
 * the provisioning rpc now go through `ensureDefaultWorkspaceId`: the workspace
 * resolver and the communication wallet, which `GET /api/manager/usage-summary`
 * reaches with no workspace named.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signViewAsToken, VIEW_AS_TTL_SECONDS } from "@/lib/auth/view-as-token";

const SECRET = "p".repeat(40);
const OWNER = "owner-uuid";

const state = vi.hoisted(() => ({ cookieValue: undefined as string | undefined }));
const mocks = vi.hoisted(() => ({ loadWorkspaces: vi.fn() }));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => (name === "axis_view_as" && state.cookieValue ? { value: state.cookieValue } : undefined),
  })),
}));
vi.mock("@/lib/workspaces/server", () => ({ loadWorkspaces: mocks.loadWorkspaces }));
vi.mock("@/lib/manager-access-server", () => ({ getEffectiveManagerSkuTier: vi.fn() }));

const { ensureDefaultWorkspaceId } = await import("@/lib/workspaces/active.server");
const { resolveDefaultCommsWorkspace } = await import("@/lib/comms-billing/wallet.server");

function workspace(id: string, overrides: Record<string, unknown> = {}) {
  return { id, name: "Workspace", ownerUserId: OWNER, owned: true, isDefault: true, propertyIds: [], ...overrides };
}

async function openSession() {
  const iat = Math.floor(Date.now() / 1000);
  state.cookieValue = await signViewAsToken(
    {
      v: 1,
      adminId: "admin-1",
      targetId: OWNER,
      portal: "manager",
      iat,
      exp: iat + VIEW_AS_TTL_SECONDS,
      sid: "session-1",
    },
    SECRET,
  );
}

beforeEach(() => {
  vi.stubEnv("PROPLANE_VIEW_AS_SECRET", SECRET);
  state.cookieValue = undefined;
  mocks.loadWorkspaces.mockReset();
});

describe("ensureDefaultWorkspaceId", () => {
  it("provisions when no session is open", async () => {
    const rpc = vi.fn(async () => ({ data: "fresh-ws", error: null }));
    await expect(ensureDefaultWorkspaceId({ rpc } as never, OWNER)).resolves.toBe("fresh-ws");
    expect(rpc).toHaveBeenCalledWith("ensure_default_portal_workspace", { p_owner: OWNER });
  });

  it("reads the owner's existing default and never calls the rpc while viewing", async () => {
    await openSession();
    const rpc = vi.fn(async () => ({ data: "fresh-ws", error: null }));
    mocks.loadWorkspaces.mockResolvedValue([workspace("existing-ws")]);
    await expect(ensureDefaultWorkspaceId({ rpc } as never, OWNER)).resolves.toBe("existing-ws");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("refuses rather than provisioning when the viewed account owns none", async () => {
    await openSession();
    const rpc = vi.fn(async () => ({ data: "fresh-ws", error: null }));
    mocks.loadWorkspaces.mockResolvedValue([]);
    await expect(ensureDefaultWorkspaceId({ rpc } as never, OWNER)).rejects.toThrow(/workspace/i);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("resolveDefaultCommsWorkspace", () => {
  it("provisions the owner's default workspace outside a session", async () => {
    const rpc = vi.fn(async () => ({ data: "wallet-ws", error: null }));
    await expect(resolveDefaultCommsWorkspace({ rpc } as never, OWNER)).resolves.toBe("wallet-ws");
    expect(rpc).toHaveBeenCalledWith("ensure_default_portal_workspace", { p_owner: OWNER });
  });

  it("writes nothing while viewing: the existing default, or an error", async () => {
    await openSession();
    const rpc = vi.fn(async () => ({ data: "wallet-ws", error: null }));
    mocks.loadWorkspaces.mockResolvedValue([workspace("existing-ws")]);
    await expect(resolveDefaultCommsWorkspace({ rpc } as never, OWNER)).resolves.toBe("existing-ws");

    mocks.loadWorkspaces.mockResolvedValue([]);
    await expect(resolveDefaultCommsWorkspace({ rpc } as never, OWNER)).rejects.toThrow(
      "We could not load your communication credit. Try again.",
    );
    expect(rpc).not.toHaveBeenCalled();
  });
});
