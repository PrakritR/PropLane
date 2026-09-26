import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SmsProjectionSummary } from "@/lib/sms/sms-projection.server";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ grant: true }));
vi.mock("@/lib/communication/conversation-visibility.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/communication/conversation-visibility.server")>()),
  resolveCommunicationScope: async () => ({
    viewerId: "co-1", level: "read", ownerIds: ["co-1", "owner-1"],
    grantedHousesByOwner: new Map([["owner-1", mocks.grant ? new Set(["house-a"]) : new Set()]]),
    workspaceHouseIds: null, untaggedOwnedVisible: true, activeWorkspaceId: null,
    workspaceByLine: new Map(),
  }),
}));
vi.mock("@/lib/manager-sms-messages.server", () => ({
  loadWorkspaceHouseLabels: async () => new Map([["house-a", { label: "House A", ownerUserId: "owner-1", aliases: [] }]]),
}));
vi.mock("@/lib/sms/sms-projection.server", () => ({
  loadSmsProjectionViewStates: async () => [],
}));
vi.mock("@/lib/sms/manager-workspace-role.server", () => ({ resolveViewerWorkNumber: async () => null }));

import { visibleManagerSmsProjectionIds } from "@/lib/sms/sms-projection-inbox.server";

const summary: SmsProjectionSummary = {
  id: "conv-1", ownerManagerUserId: "owner-1", counterpartyRole: "prospect",
  workLineId: "line-1", workLinePhone: "+15550009999", identityKey: "phone:+15550001111",
  identityKind: "phone", counterpartyUserId: null, phone: "+15550001111", legacyKey: "legacy-1",
  lastBody: "original", lastDirection: "inbound", lastEventAt: "2026-09-25T12:00:00.000Z",
  lastEventId: null, lastInboundAt: "2026-09-25T12:00:00.000Z", lastInboundEventId: null,
  count: 1, metadata: {},
};

const db = {
  from(table: string) {
    const rows = table === "sms_projection_aliases" ? [{ conversation_id: "conv-1", alias_value: "legacy-1", alias_kind: "legacy_key" }] :
      table === "manager_sms_conversation_houses" ? [{ manager_user_id: "owner-1", conversation_key: "legacy-1", property_id: "house-a" }] : [];
    const q: Record<string, unknown> = {};
    for (const method of ["select", "in", "eq", "order", "limit"]) q[method] = () => q;
    q.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(resolve);
    return q;
  },
};

beforeEach(() => { mocks.grant = true; });

describe("per-viewer projected replacement visibility", () => {
  it("allows exact notice suppression for a co-manager granted its tagged house", async () => {
    expect(await visibleManagerSmsProjectionIds(db as never, "co-1", [summary])).toEqual(new Set(["conv-1"]));
  });
  it("retains the notice when that co-manager's house grant is revoked", async () => {
    mocks.grant = false;
    expect(await visibleManagerSmsProjectionIds(db as never, "co-1", [summary])).toEqual(new Set());
  });
});
