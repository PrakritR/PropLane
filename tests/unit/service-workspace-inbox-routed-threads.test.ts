/**
 * A PropLane-line text the router routed to a PropLane Service workspace shows in THAT workspace's inbox (and in no other),
 * even with no house tag and though the line itself is held by the service owner's default workspace. A thread stamped with
 * an ordinary workspace is placed by the old rules.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";
import type { SmsProjectionSummary } from "@/lib/sms/sms-projection.server";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({ active: "ws-svc" as string | null }));

const SO = "owner-so";
const CLIENT = "owner-client";
const LINE = "+12066781909";

// The service owner holds the PropLane line on their DEFAULT workspace; the viewer is looking at a service workspace.
vi.mock("@/lib/communication/conversation-visibility.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/communication/conversation-visibility.server")>()),
  resolveCommunicationScope: async (_db: unknown, viewerId: string) => ({
    viewerId,
    level: "read",
    ownerIds: [viewerId],
    grantedHousesByOwner: new Map(),
    workspaceHouseIds: new Set<string>(),
    untaggedOwnedVisible: false,
    activeWorkspaceId: state.active,
    workspaceByLine: new Map([["2066781909", new Set(["ws-default"])]]),
  }),
}));
vi.mock("@/lib/manager-sms-messages.server", () => ({ loadWorkspaceHouseLabels: async () => new Map() }));
vi.mock("@/lib/sms/sms-projection.server", () => ({ loadSmsProjectionViewStates: async () => [] }));
vi.mock("@/lib/sms/manager-workspace-role.server", () => ({ resolveViewerWorkNumber: async () => null }));

import { visibleManagerSmsProjectionIds } from "@/lib/sms/sms-projection-inbox.server";

const summary = (id: string, owner: string): SmsProjectionSummary => ({
  id, ownerManagerUserId: owner, counterpartyRole: "prospect",
  workLineId: "line-1", workLinePhone: LINE, identityKey: `phone:${id}`,
  identityKind: "phone", counterpartyUserId: null, phone: "+15550001111", legacyKey: `legacy-${id}`,
  lastBody: "hi", lastDirection: "inbound", lastEventAt: "2026-10-20T12:00:00.000Z",
  lastEventId: null, lastInboundAt: "2026-10-20T12:00:00.000Z", lastInboundEventId: null,
  count: 1, metadata: {},
});

let db: ReturnType<typeof createMemoryDb>;
const visible = async (viewer: string, ...rows: SmsProjectionSummary[]) => [...(await visibleManagerSmsProjectionIds(db as never, viewer, rows))].sort();

beforeEach(() => {
  state.active = "ws-svc";
  db = createMemoryDb({
    portal_workspaces: [
      { id: "ws-svc", owner_user_id: SO, is_service: true, is_default: false },
      { id: "ws-svc-2", owner_user_id: SO, is_service: true, is_default: false },
      { id: "ws-default", owner_user_id: SO, is_service: false, is_default: true },
    ],
    sms_projection_conversations: [
      { id: "c-routed", workspace_id: "ws-svc", owner_manager_user_id: SO },
      { id: "c-routed-2", workspace_id: "ws-svc-2", owner_manager_user_id: SO },
      { id: "c-plain", workspace_id: "ws-default", owner_manager_user_id: SO },
      { id: "c-unstamped", workspace_id: null, owner_manager_user_id: SO },
    ],
  });
});

describe("a service workspace's inbox", () => {
  it("shows the PropLane-line threads routed to it, with no house tag", async () => {
    expect(await visible(SO, summary("c-routed", SO))).toEqual(["c-routed"]);
  });

  it("never shows another service workspace's routed thread", async () => {
    expect(await visible(SO, summary("c-routed", SO), summary("c-routed-2", SO))).toEqual(["c-routed"]);
    state.active = "ws-svc-2";
    expect(await visible(SO, summary("c-routed", SO), summary("c-routed-2", SO))).toEqual(["c-routed-2"]);
  });

  it("a thread stamped with an ordinary workspace, or unstamped, keeps the old rules (the PropLane line's holder only)", async () => {
    expect(await visible(SO, summary("c-plain", SO), summary("c-unstamped", SO))).toEqual([]);
    state.active = "ws-default";
    expect(await visible(SO, summary("c-plain", SO), summary("c-unstamped", SO))).toEqual(["c-plain", "c-unstamped"]);
  });

  it("the default workspace no longer carries a thread that was routed to a service workspace", async () => {
    state.active = "ws-default";
    expect(await visible(SO, summary("c-routed", SO))).toEqual([]);
  });

  it("a failed read of the stamp places nothing (the old rules apply)", async () => {
    const broken = {
      ...db,
      from: (table: string) =>
        table === "sms_projection_conversations"
          ? { select: () => ({ in: async () => ({ data: null, error: { message: "down" } }) }) }
          : db.from(table),
    };
    // Unplaced, the thread is the PropLane line's like any other: the holder's default workspace carries it, the service workspace does not.
    const read = async () => [...(await visibleManagerSmsProjectionIds(broken as never, SO, [summary("c-routed", SO)]))];
    state.active = "ws-default";
    expect(await read()).toEqual(["c-routed"]);
    state.active = "ws-svc";
    expect(await read()).toEqual([]);
  });

  it("another owner's routed thread still needs the viewer's house grant", async () => {
    // The viewer is not the owner and holds no grant: the stamp never widens access.
    expect(await visible("staff-1", summary("c-routed", CLIENT))).toEqual([]);
  });
});
