import { describe, expect, it, vi } from "vitest";
import { inboxStoreOwnerIds } from "@/lib/communication/inbox-store-owner-ids";
import {
  conversationVisible,
  filterVisibleInboxThreadRecords,
  managedWorkspaceOwnerOf,
  storedThreadWorkspaceId,
  type CommunicationScope,
} from "@/lib/communication/conversation-visibility.server";
import { mergeInboxThreadRowData } from "@/lib/communication/shared-thread-merge";
import { recipientReachFromScope, managerMayMessageNewContacts } from "@/lib/inbox-recipient-scope";

vi.mock("server-only", () => ({}));

/**
 * One managed workspace's Communication shows every conversation stamped with it, whoever holds the row, and the
 * operator's OWN workspace never shows another workspace's threads. Fixture mirrors the production shape: the
 * client owner holds most rows; the operator (service staff) holds some stamped with the managed workspace.
 */
const STAFF = "staff-prakrit";
const CLIENT = "client-ambika";
const MANAGED_WS = "ws-ambika";
const OWN_WS = "ws-prakrit";

function scope(over: Partial<CommunicationScope> = {}): CommunicationScope {
  return {
    viewerId: STAFF,
    level: "read",
    ownerIds: [STAFF],
    grantedHousesByOwner: new Map(),
    workspaceHouseIds: new Set(["house-ambika"]),
    untaggedOwnedVisible: false,
    activeWorkspaceId: MANAGED_WS,
    workspaceByLine: new Map(),
    staffWorkspaceOwners: new Map([[MANAGED_WS, CLIENT]]),
    ...over,
  };
}
const ownWorkspace = scope({
  workspaceHouseIds: new Set(["house-prakrit"]),
  untaggedOwnedVisible: true,
  activeWorkspaceId: OWN_WS,
  staffWorkspaceOwners: new Map(),
});

/** A permissive chainable DB: every read is empty (no houses, no managed-owner identity). */
function emptyDb(): never {
  const chain: unknown = new Proxy(() => chain, {
    get: (_t, prop) => (prop === "then" ? (resolve: (v: unknown) => void) => resolve({ data: [], error: null }) : chain),
    apply: () => chain,
  });
  return { from: () => chain } as never;
}

type Rec = { id: string; owner_user_id: string; thread_type: string; workspace_id: string | null; row_data: Record<string, unknown> };
const rec = (id: string, owner: string, workspace: string | null, rowWs?: string, type = "portal_message"): Rec => ({
  id,
  owner_user_id: owner,
  thread_type: type,
  workspace_id: workspace,
  row_data: { ...(rowWs ? { workspaceId: rowWs } : {}) },
});

const rows: Rec[] = [
  rec("client-msg", CLIENT, MANAGED_WS),
  rec("client-sms-notice", CLIENT, null, MANAGED_WS, "claw_leasing_sms"),
  rec("staff-owned-stamped", STAFF, MANAGED_WS),
  rec("staff-owned-notice", STAFF, null, MANAGED_WS, "claw_leasing_sms"),
  rec("staff-own-ws", STAFF, OWN_WS),
  rec("client-other-ws", CLIENT, "ws-elsewhere"),
];

describe("managed workspace Communication lists every conversation stamped with it", () => {
  it("fetches the client owner's rows for staff (store query owners)", () => {
    expect(inboxStoreOwnerIds(scope())).toEqual([STAFF, CLIENT]);
    expect(inboxStoreOwnerIds(ownWorkspace)).toEqual([STAFF]);
  });

  it("staff see client-owned and staff-owned rows stamped with the workspace, including notices stamped only in row_data", async () => {
    const visible = await filterVisibleInboxThreadRecords(emptyDb(), scope(), rows);
    expect(visible.map((r) => r.id).sort()).toEqual(
      ["client-msg", "client-sms-notice", "staff-owned-notice", "staff-owned-stamped"].sort(),
    );
  });

  it("the operator's own workspace never lists the managed workspace's threads, whoever owns them", async () => {
    const visible = await filterVisibleInboxThreadRecords(emptyDb(), ownWorkspace, rows);
    expect(visible.map((r) => r.id)).toEqual(["staff-own-ws"]);
  });

  it("a stamp in row_data places an unstamped-column thread; the column wins when both exist", () => {
    expect(storedThreadWorkspaceId({ workspace_id: null, row_data: { workspaceId: MANAGED_WS } })).toBe(MANAGED_WS);
    expect(storedThreadWorkspaceId({ workspace_id: OWN_WS, row_data: { workspaceId: MANAGED_WS } })).toBe(OWN_WS);
    expect(storedThreadWorkspaceId({ workspace_id: null, row_data: {} })).toBeNull();
  });

  it("a non-staff co-manager is not widened by the same rows", () => {
    const coManager = scope({ staffWorkspaceOwners: new Map(), grantedHousesByOwner: new Map([[CLIENT, new Set(["house-x"])]]) });
    expect(conversationVisible(coManager, { ownerId: CLIENT, houseIds: [], workspaceId: MANAGED_WS })).toBe(false);
  });
});

describe("staff answer as the workspace", () => {
  it("the managed owner is derived from the seat, only for the active workspace", () => {
    expect(managedWorkspaceOwnerOf(scope())).toBe(CLIENT);
    expect(managedWorkspaceOwnerOf(ownWorkspace)).toBeNull();
    expect(managedWorkspaceOwnerOf(scope({ activeWorkspaceId: "ws-other" }))).toBeNull();
  });

  it("staff may append an outbound turn to the client's thread with no house grant, attributed by the server", () => {
    const merged = mergeInboxThreadRowData({
      stored: { messages: [{ id: "m1", from: "Guest", body: "hi", outbound: false, houseId: "house-ambika" }] },
      requested: { messages: [{ id: "m1", body: "hi" }, { id: "m2", from: "SPOOF", body: "hello", outbound: true }] },
      rule: { kind: "staff", authorUserId: STAFF, authorName: "Prakrit" },
    });
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    const turns = merged.rowData.messages as Array<Record<string, unknown>>;
    expect(turns).toHaveLength(2);
    expect(turns[1]).toMatchObject({ from: "Prakrit", outbound: true, authorUserId: STAFF });
  });

  it("staff cannot author the counterparty's side", () => {
    const merged = mergeInboxThreadRowData({
      stored: { messages: [] },
      requested: { messages: [{ id: "m9", from: "Guest", body: "fake", outbound: false }] },
      rule: { kind: "staff", authorUserId: STAFF, authorName: "Prakrit" },
    });
    expect(merged).toEqual({ ok: false, reason: "inbound_turn_not_authorable" });
  });

  it("a delegate with no house grant still cannot write (the staff rule is not a loophole)", () => {
    const merged = mergeInboxThreadRowData({
      stored: { messages: [] },
      requested: { messages: [{ id: "m2", body: "x", outbound: true }] },
      rule: { kind: "delegate", allowedHouses: new Set(), conversationHouseIds: [], authorUserId: STAFF, authorName: "P" },
    });
    expect(merged).toEqual({ ok: false, reason: "house_not_granted" });
  });

  it("recipient reach and new-contact allowance include the managed workspace's houses for staff only", async () => {
    const reach = recipientReachFromScope(scope());
    expect([...(reach.grantedHousesByOwner.get(CLIENT) ?? [])]).toEqual(["house-ambika"]);
    expect(recipientReachFromScope(ownWorkspace).grantedHousesByOwner.has(CLIENT)).toBe(false);
    const db = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { owner_user_id: CLIENT }, error: null }) }) }) }) } as never;
    expect(await managerMayMessageNewContacts(db, scope({ level: "edit" }))).toBe(true);
    expect(await managerMayMessageNewContacts(db, scope({ level: "edit", staffWorkspaceOwners: new Map() }))).toBe(false);
  });
});

describe("thread open + send as staff", () => {
  it("resolveInboxThreadReplyTarget authorizes staff on a house-less client thread through its workspace stamp", async () => {
    vi.resetModules();
    vi.doMock("@/lib/communication/conversation-visibility.server", async () => {
      const actual = await vi.importActual<typeof import("@/lib/communication/conversation-visibility.server")>(
        "@/lib/communication/conversation-visibility.server",
      );
      return {
        ...actual,
        resolveCommunicationScope: async () => scope({ level: "edit" }),
        // The real decision, minus the house-label reads (no database here).
        visibleInboxThreadRecord: async (
          _db: unknown,
          _viewer: string,
          _level: string,
          record: Rec,
          s: CommunicationScope,
        ) =>
          actual.conversationVisible(s, {
            ownerId: record.owner_user_id,
            houseIds: [],
            threadType: record.thread_type,
            threadId: record.id,
            workspaceId: actual.storedThreadWorkspaceId(record),
          })
            ? { ...record, houses: [] }
            : null,
      };
    });
    const { resolveInboxThreadReplyTarget } = await import("@/lib/portal-inbox-delivery");
    const stored = (workspace_id: string | null) => ({
      id: "client-msg",
      row_data: { messages: [] },
      owner_user_id: CLIENT,
      participant_email: null,
      scope: "axis_portal_inbox_manager_v1",
      thread_type: "portal_message",
      workspace_id,
    });
    const dbWith = (row: ReturnType<typeof stored>) =>
      ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }) }) }) as never;

    const target = await resolveInboxThreadReplyTarget(dbWith(stored(MANAGED_WS)), {
      threadId: "client-msg",
      senderUserId: STAFF,
      senderEmail: "staff@example.com",
    });
    expect(target).toMatchObject({ ownerUserId: CLIENT, coHost: true, staff: true });

    // A thread stamped with a different workspace is not the open workspace's: no send.
    const other = await resolveInboxThreadReplyTarget(dbWith(stored("ws-elsewhere")), {
      threadId: "client-msg",
      senderUserId: STAFF,
      senderEmail: "staff@example.com",
    });
    expect(other).toBeNull();
    vi.doUnmock("@/lib/communication/conversation-visibility.server");
  });

  it("a new conversation by staff is keyed in the managed workspace, owned by its owner", async () => {
    vi.resetModules();
    vi.doMock("@/lib/service/service-mode.server", () => ({
      loadServiceStaffWorkspaces: async () => [{ id: MANAGED_WS, ownerUserId: CLIENT }],
    }));
    const { resolveWorkspaceContext } = await import("@/lib/communication/conversation-key.server");
    const db = {
      from: (table: string) => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: table === "portal_workspaces" ? { id: MANAGED_WS, owner_user_id: CLIENT, is_default: true } : null, error: null }),
          }),
        }),
      }),
    } as never;
    // Staff: the named workspace resolves to the managed one (not the operator's own default).
    expect(await resolveWorkspaceContext(db, STAFF, { workspaceId: MANAGED_WS })).toMatchObject({
      workspaceId: MANAGED_WS,
      workspaceOwnerId: CLIENT,
    });
    // The owner is the conversation's owner: the route passes the owner as the manager, who always may use it.
    expect(await resolveWorkspaceContext(db, CLIENT, { workspaceId: MANAGED_WS })).toMatchObject({ workspaceId: MANAGED_WS });
    vi.doUnmock("@/lib/service/service-mode.server");
  });
});
