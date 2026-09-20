import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/co-manager-notification.server", () => ({
  notifyPromotedToMainManager: vi.fn(),
  notifyDemotedToCoManager: vi.fn(),
}));

const updateMock = vi.fn();
const eqMock = vi.fn();
const fromMock = vi.fn();

function chain() {
  const self = {
    select: vi.fn(() => self),
    eq: eqMock.mockImplementation(() => self),
    or: vi.fn(() => self),
    maybeSingle: vi.fn(),
    update: updateMock.mockImplementation(() => self),
    insert: vi.fn(() => self),
    in: vi.fn(() => self),
  };
  return self;
}

type Resp = { data?: unknown; error?: unknown };

/**
 * A `db.from(table)` dispatcher: each call pops the next queued response for
 * that table (used by whichever chain method resolves — `.maybeSingle()`,
 * or nothing at all for a fire-and-forget `.update()`/`.insert()`) and
 * defaults to `{ data: null, error: null }` once the queue is empty. Every
 * built chain is kept in `created[table]` in call order so a test can assert
 * on the exact payload passed to `.update()`/`.insert()`.
 */
function buildQueueDb(responses: Record<string, Resp[]>) {
  const created: Record<string, ReturnType<typeof buildChain>[]> = {};

  function buildChain(resp: Resp) {
    const self = {
      select: vi.fn(() => self),
      or: vi.fn(() => self),
      in: vi.fn(() => self),
      eq: vi.fn(() => self),
      maybeSingle: vi.fn().mockResolvedValue({ data: resp.data ?? null, error: resp.error ?? null }),
      update: vi.fn((payload: unknown) => {
        (self as { updatePayload?: unknown }).updatePayload = payload;
        return self;
      }) as unknown as (payload: unknown) => typeof self,
      insert: vi.fn((payload: unknown) => {
        (self as { insertPayload?: unknown }).insertPayload = payload;
        return self;
      }) as unknown as (payload: unknown) => typeof self,
    };
    return self;
  }

  const from = vi.fn((table: string) => {
    const queue = responses[table] ?? [];
    const resp = queue.length ? queue.shift()! : { data: null, error: null };
    const built = buildChain(resp);
    (created[table] ??= []).push(built);
    return built;
  });

  return { db: { from } as never, created };
}

const PROPERTY_ROW = {
  id: "prop-1",
  manager_user_id: "owner-1",
  property_data: { buildingName: "Bay House", unitLabel: "1A" },
};

const LINK_ROW = (assigned: string[]) => ({
  id: "link-1",
  assigned_property_ids: assigned,
  property_co_manager_permissions: {},
  co_manager_permissions: {},
  payout_percent_for_manager: 15,
});

const PROFILE_ROW = (name: string, axisId: string) => ({
  manager_id: axisId,
  full_name: name,
  email: `${name.toLowerCase().replace(/\s+/g, ".")}@example.com`,
});

describe("transferPropertyOwnership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fromMock.mockImplementation(() => chain());
  });

  it("rejects when caller is not property owner", async () => {
    const db = { from: fromMock } as never;
    const { transferPropertyOwnership } = await import("@/lib/property-ownership-transfer");

    const propertyChain = chain();
    propertyChain.maybeSingle.mockResolvedValue({
      data: { id: "prop-1", manager_user_id: "other-user", property_data: {} },
      error: null,
    });
    fromMock.mockReturnValueOnce(propertyChain);

    const result = await transferPropertyOwnership(db, {
      propertyId: "prop-1",
      currentOwnerUserId: "owner-1",
      newManagerUserId: "new-1",
      formerOwnerPermissions: { applications: true },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
    }
  });

  it("with a non-empty former-owner map, inserts the reverse link with workspace_id, house_scope selected and a team_role — and never re-inserts the old link", async () => {
    const { db, created } = buildQueueDb({
      manager_property_records: [
        { data: PROPERTY_ROW, error: null }, // ownership lookup
        { data: { workspace_id: "ws-new" }, error: null }, // ownership update .select("workspace_id")
      ],
      account_link_invites: [
        { data: LINK_ROW(["prop-1", "prop-2"]), error: null }, // linkRow lookup
        { data: { assigned_property_ids: ["prop-2"] }, error: null }, // refreshedLinkRow (still has a house — not cancelled)
        { data: null, error: null }, // reverseLink lookup — not found
      ],
      profiles: [
        { data: PROFILE_ROW("Owner One", "AX-OWNER"), error: null },
        { data: PROFILE_ROW("New Manager", "AX-NEW"), error: null },
      ],
    });

    const { transferPropertyOwnership } = await import("@/lib/property-ownership-transfer");

    const result = await transferPropertyOwnership(db, {
      propertyId: "prop-1",
      currentOwnerUserId: "owner-1",
      newManagerUserId: "new-1",
      formerOwnerPermissions: { applications: true },
    });

    expect(result.ok).toBe(true);

    const linkCalls = created.account_link_invites;
    // select linkRow, select refreshedLinkRow, select reverseLink, insert reverse row — no cancel update.
    expect(linkCalls).toHaveLength(4);

    const insertPayload = (linkCalls[3] as unknown as { insertPayload: Record<string, unknown> }).insertPayload;
    expect(insertPayload).toMatchObject({
      inviter_user_id: "new-1",
      invitee_user_id: "owner-1",
      workspace_id: "ws-new",
      house_scope: "selected",
    });
    expect(typeof insertPayload.team_role).toBe("string");
    expect(insertPayload.team_role).toBeTruthy();

    // The old cancel+re-insert-under-the-new-manager behavior must be gone:
    // no insert should ever carry the old link's direction.
    for (const call of linkCalls) {
      const payload = (call as unknown as { insertPayload?: Record<string, unknown> }).insertPayload;
      if (payload) {
        expect(payload).not.toMatchObject({ inviter_user_id: "owner-1", invitee_user_id: "new-1" });
      }
    }
  });

  it("with an empty former-owner map, cancels an exhausted old link and never touches a reverse link", async () => {
    const { db, created } = buildQueueDb({
      manager_property_records: [
        { data: PROPERTY_ROW, error: null },
        { data: { workspace_id: "ws-new" }, error: null },
      ],
      account_link_invites: [
        { data: LINK_ROW(["prop-1"]), error: null }, // linkRow lookup — only this one house
        { data: { assigned_property_ids: [] }, error: null }, // refreshedLinkRow — trigger pruned it to empty
      ],
      profiles: [
        { data: PROFILE_ROW("Owner One", "AX-OWNER"), error: null },
        { data: PROFILE_ROW("New Manager", "AX-NEW"), error: null },
      ],
    });

    const { transferPropertyOwnership } = await import("@/lib/property-ownership-transfer");

    const result = await transferPropertyOwnership(db, {
      propertyId: "prop-1",
      currentOwnerUserId: "owner-1",
      newManagerUserId: "new-1",
      formerOwnerPermissions: {},
    });

    expect(result.ok).toBe(true);

    const linkCalls = created.account_link_invites;
    // select linkRow, select refreshedLinkRow, update cancel — no reverse-link lookup or insert.
    expect(linkCalls).toHaveLength(3);

    const cancelPayload = (linkCalls[2] as unknown as { updatePayload: Record<string, unknown> }).updatePayload;
    expect(cancelPayload).toMatchObject({ status: "cancelled" });

    for (const call of linkCalls) {
      const insertPayload = (call as unknown as { insertPayload?: unknown }).insertPayload;
      expect(insertPayload).toBeUndefined();
    }
  });
});
