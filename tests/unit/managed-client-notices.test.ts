/**
 * The client (Property owner of record) of an admin-owned managed workspace is a SECOND notice recipient, resolved from the
 * owner seat (`resolveManagedPayee`): payments, financials and urgent notices only, each gated by the seat's owner keys.
 * The workspace owner is the admin and never the client.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const ADMIN = "11111111-1111-4111-8111-111111111111";
const CLIENT = "22222222-2222-4222-8222-222222222222";
const WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const HOUSE = "house-1";

const notifyManager = vi.hoisted(() => vi.fn(async () => ({ delivered: true, suppressed: false })));
let PAYEE: string | null = CLIENT;
let SEAT_PERMS: Record<string, unknown> = {};

vi.mock("@/lib/agent-notify.server", () => ({ notifyManagerFromAgent: notifyManager }));
vi.mock("@/lib/work-number-recipients.server", () => ({ notifyWorkNumberRecipients: vi.fn(async () => undefined) }));
vi.mock("@/lib/service/service-alert-targets.server", () => ({
  isManagedWorkspaceId: async () => true,
  notifyServiceAlertTargets: async () => undefined,
}));
vi.mock("@/lib/service/service-manager-alerts.server", () => ({ alertServiceManagerFromNotice: async () => "skipped" }));
vi.mock("@/lib/communication/manager-assistant-workspace.server", () => ({
  resolveManagerAssistantWorkspace: async () => ({ workspaceId: WS }),
  userDefaultWorkspaceId: async () => WS,
}));
vi.mock("@/lib/managed-finance/payee.server", () => ({ resolveManagedPayee: async () => PAYEE }));
vi.mock("@/lib/team-comms.server", () => ({
  ensureWorkspaceTeamThread: async () => undefined,
  postTeamThreadMessage: async () => undefined,
  relayTeamChatMessageToSms: async () => undefined,
  resolveWorkspaceTeamMembersWithGrants: async () => [],
}));
vi.mock("@/lib/workspace-team-recipients.server", () => ({
  memberReceivesNotice: () => false,
  resolveWorkspaceNoticeRecipients: async () => [{ userId: ADMIN }],
}));

import { managedClientNoticeOwnerKey, notifyPropertyScopedManagersFromAgent } from "@/lib/co-manager-notification-recipients.server";

const db = {
  from: () => {
    const q: Record<string, unknown> = {
      select: () => q,
      eq: () => q,
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve({
          data: [{ workspace_id: WS, assigned_property_ids: [HOUSE], property_co_manager_permissions: SEAT_PERMS, co_manager_permissions: {}, house_scope: "selected" }],
          error: null,
        }).then(resolve),
    };
    return q;
  },
} as never;

const view = { read: true, notification: false };
const base = { ownerManagerUserId: ADMIN, propertyId: HOUSE, workspaceId: WS, subject: "S", text: "T", idempotencyKey: "k" };
const landlords = () => notifyManager.mock.calls.map((c) => (c as unknown as [unknown, { landlordId: string }])[1].landlordId);

beforeEach(() => {
  notifyManager.mockClear();
  PAYEE = CLIENT;
  SEAT_PERMS = { [HOUSE]: { ownerPerformance: view, ownerStatements: view, ownerDocuments: view } };
});

describe("managedClientNoticeOwnerKey (the allowlist)", () => {
  it("payments and financials need ownerStatements, an urgent notice ownerPerformance, everything else nothing", () => {
    expect(managedClientNoticeOwnerKey({ module: "payments", urgent: false })).toBe("ownerStatements");
    expect(managedClientNoticeOwnerKey({ module: "financials", urgent: false })).toBe("ownerStatements");
    expect(managedClientNoticeOwnerKey({ module: "services", urgent: true })).toBe("ownerPerformance");
    expect(managedClientNoticeOwnerKey({ module: "services", urgent: false })).toBeNull();
    expect(managedClientNoticeOwnerKey({ module: "calendar", urgent: false })).toBeNull();
    expect(managedClientNoticeOwnerKey({ module: "payments", urgent: true, category: "payment_reminders" })).toBeNull();
  });
});

describe("the client hears an admin-owned workspace's allowlisted notices", () => {
  it("a payments notice reaches the admin (owner) AND the client", async () => {
    await notifyPropertyScopedManagersFromAgent(db, { ...base, module: "payments" });
    expect(landlords().sort()).toEqual([ADMIN, CLIENT].sort());
  });

  it("an urgent services notice reaches the client; a routine one reaches nobody extra", async () => {
    await notifyPropertyScopedManagersFromAgent(db, { ...base, module: "services", urgent: true });
    expect(landlords()).toContain(CLIENT);
    notifyManager.mockClear();
    await notifyPropertyScopedManagersFromAgent(db, { ...base, module: "services" });
    expect(landlords()).not.toContain(CLIENT);
  });

  it("is gated by the seat's owner keys: no ownerStatements means no payments notice", async () => {
    SEAT_PERMS = { [HOUSE]: { ownerPerformance: view } };
    await notifyPropertyScopedManagersFromAgent(db, { ...base, module: "payments" });
    expect(landlords()).not.toContain(CLIENT);
  });

  it("no payee, or the payee being the workspace owner (legacy attached shape), adds no second delivery", async () => {
    PAYEE = null;
    await notifyPropertyScopedManagersFromAgent(db, { ...base, module: "payments" });
    expect(landlords()).not.toContain(CLIENT);
    notifyManager.mockClear();
    PAYEE = ADMIN;
    await notifyPropertyScopedManagersFromAgent(db, { ...base, module: "payments" });
    expect(landlords().filter((id) => id === ADMIN)).toHaveLength(1);
  });

  it("the actor is never told twice", async () => {
    await notifyPropertyScopedManagersFromAgent(db, { ...base, module: "payments", excludeUserIds: [CLIENT] });
    expect(landlords()).not.toContain(CLIENT);
  });
});
