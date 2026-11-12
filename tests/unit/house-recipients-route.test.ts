import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveCtx = vi.fn();
const resolveGrant = vi.fn();
const propertyInWorkspace = vi.fn();
const loadRecipients = vi.fn();

vi.mock("@/lib/listing-channels/route-context.server", () => ({
  resolveListingChannelContext: (...args: unknown[]) => resolveCtx(...args),
  propertyInWorkspace: (...args: unknown[]) => propertyInWorkspace(...args),
}));
vi.mock("@/lib/one-number/communication-grant.server", async () => {
  const actual = await vi.importActual<typeof import("@/lib/one-number/communication-grant.server")>("@/lib/one-number/communication-grant.server");
  return { ...actual, resolveCommunicationGrant: (...args: unknown[]) => resolveGrant(...args) };
});
vi.mock("@/lib/house-message-recipients.server", () => ({
  loadHouseMessageRecipients: (...args: unknown[]) => loadRecipients(...args),
}));

import { GET } from "@/app/api/portal/house-recipients/route";

const ctx = { db: {}, userId: "u1", workspace: { id: "w1", ownerUserId: "owner", propertyIds: ["p1"] } };
const call = (query: string) => GET(new Request(`http://localhost/api/portal/house-recipients?${query}`));

describe("GET /api/portal/house-recipients", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveCtx.mockResolvedValue(ctx);
    resolveGrant.mockResolvedValue({ ok: true, grant: { isOwner: true, grantedPropertyIds: null } });
    propertyInWorkspace.mockResolvedValue({ id: "p1", live: true });
    loadRecipients.mockResolvedValue({ people: [], excludedGuests: 0, unaddressable: 0 });
  });

  it("is 401 without a manager session", async () => {
    resolveCtx.mockResolvedValue(null);
    expect((await call("propertyId=p1")).status).toBe(401);
    expect(loadRecipients).not.toHaveBeenCalled();
  });

  it("refuses another workspace's property (404) and never loads people", async () => {
    propertyInWorkspace.mockResolvedValue(null);
    const res = await call("propertyId=p-other");
    expect(res.status).toBe(404);
    expect(loadRecipients).not.toHaveBeenCalled();
  });

  it("refuses a house the teammate's Communication grant does not cover", async () => {
    resolveGrant.mockResolvedValue({ ok: true, grant: { isOwner: false, grantedPropertyIds: new Set(["p2"]) } });
    expect((await call("propertyId=p1")).status).toBe(404);
    expect(loadRecipients).not.toHaveBeenCalled();
  });

  it("is 403 for a teammate with no Communication access", async () => {
    resolveGrant.mockResolvedValue({ ok: false, status: 403, error: "You do not have access to Communication for this workspace." });
    expect((await call("propertyId=p1")).status).toBe(403);
  });

  it("asks for no guests by default and for guests only with includeGuests=1", async () => {
    await call("propertyId=p1");
    expect(loadRecipients).toHaveBeenLastCalledWith(ctx.db, expect.objectContaining({ propertyId: "p1", includeGuests: false, ownerUserId: "owner" }));
    await call("propertyId=p1&includeGuests=1");
    expect(loadRecipients).toHaveBeenLastCalledWith(ctx.db, expect.objectContaining({ includeGuests: true }));
  });

  it("derives the owner from the workspace, never from the query", async () => {
    await call("propertyId=p1&ownerUserId=attacker&workspaceId=w-evil");
    expect(loadRecipients).toHaveBeenLastCalledWith(ctx.db, expect.objectContaining({ ownerUserId: "owner" }));
  });
});
