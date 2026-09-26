import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  visible: vi.fn(async () => new Set<string>()),
  record: null as Record<string, unknown> | null,
  turns: null as Record<string, unknown>[] | null,
  summaries: null as Record<string, unknown>[] | null,
}));
vi.mock("@/lib/sms/sms-projection-inbox.server", () => ({ visibleManagerSmsProjectionIds: mocks.visible }));
vi.mock("@/lib/communication/conversation-visibility.server", () => ({
  resolveCommunicationScope: vi.fn(async () => ({ ownerIds: ["owner-1", "viewer-1"] })),
  filterVisibleInboxThreadRecords: vi.fn(async (_db, _scope, rows) => rows),
}));
vi.mock("@/lib/agent-notify.server", () => ({ ensureManagerAgentNoticeThread: vi.fn(async () => undefined) }));
vi.mock("@/lib/workspaces/active.server", () => ({ resolveActiveWorkspaceFromRequest: vi.fn(async () => ({ id: "workspace-1", isDefault: true })) }));
vi.mock("@/lib/portal-inbox-storage", () => ({
  collapsePersonInboxThreads: (rows: unknown[]) => rows,
  collapseAssistantInboxThreads: (rows: unknown[]) => rows,
}));
vi.mock("@/lib/portal-inbox-thread-scope", () => ({
  ADMIN_INBOX_SCOPE: "axis_portal_inbox_admin_v1",
  MANAGER_INBOX_SCOPE: "axis_portal_inbox_manager_v1",
  RESIDENT_INBOX_SCOPE: "axis_portal_inbox_resident_v1",
  resolveInboxScopeUser: async () => ({ user: { id: "viewer-1", role: "manager" }, db }),
  applyPortalInboxThreadScope: (query: unknown) => query,
}));

const body = "Exact prospect original";
const marker = {
  ownerManagerUserId: "owner-1", sourceNamespace: "twilio:owner-1:ACtest", sourceEventId: "SMexact",
  counterpartyRole: "prospect", workLineId: "line-1", occurredAt: "2026-09-25T12:00:00.000Z",
  bodySha256: createHash("sha256").update(body).digest("hex"),
};
const db = {
  from(table: string) {
    const values: Record<string, unknown>[] = table === "portal_inbox_thread_records" ? [mocks.record!] :
      table === "sms_projection_turns" ? mocks.turns ?? [{ owner_manager_user_id: "owner-1", source_namespace: marker.sourceNamespace,
        source_event_id: marker.sourceEventId, conversation_id: "conv-1", body,
        occurred_at: marker.occurredAt }] :
      table === "sms_projection_conversations" ? mocks.summaries ?? [{ id: "conv-1", owner_manager_user_id: "owner-1",
        counterparty_role: "prospect", work_line_id: "line-1", work_line_phone: "+15550009999",
        identity_key: "phone:+15550001111", identity_kind: "phone", counterparty_user_id: null,
        counterparty_phone: "+15550001111", legacy_conversation_key: "legacy", metadata: {} }] : [];
    const q: Record<string, unknown> = {};
    for (const method of ["select", "eq", "in", "order", "limit"]) q[method] = () => q;
    q.maybeSingle = async () => ({ data: table === "sms_projection_cutover" ? { ready: true } : null, error: null });
    q.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: values, error: null }).then(resolve);
    return q;
  },
};

import { GET } from "@/app/api/portal-inbox-threads/route";

beforeEach(() => {
  mocks.visible.mockReset().mockResolvedValue(new Set());
  mocks.turns = null;
  mocks.summaries = null;
  mocks.record = {
    id: "sms_notice_owner_1", scope: "axis_portal_inbox_manager_v1", owner_user_id: "viewer-1",
    participant_email: null, thread_type: "claw_leasing_sms", updated_at: "2026-09-25T12:00:01.000Z",
    row_data: { id: "sms_notice_owner_1", folder: "inbox", from: "+15550001111", email: "",
      subject: "Text from +15550001111", body, preview: body, rootMessageId: "leasing_SMexact",
      rootOriginalSmsEvent: marker, messages: [{ id: "annotation-1", body: "A separate note", from: "+15550001111",
        at: "2026-09-25T12:00:02.000Z" }], unread: true },
  };
});

describe("manager notice replacement visibility", () => {
  it("suppresses only the bound original when this co-manager can see its projection", async () => {
    mocks.visible.mockResolvedValue(new Set(["conv-1"]));
    const response = await GET(new Request("https://example.test/api/portal-inbox-threads?scope=axis_portal_inbox_manager_v1"));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.rows).toHaveLength(1);
    expect(payload.rows[0].body).toBe("A separate note");
    expect(payload.rows[0].rootMessageId).toBe("annotation-1");
  });

  it("retains the exact original when its replacement is not visible to this co-manager", async () => {
    const response = await GET(new Request("https://example.test/api/portal-inbox-threads?scope=axis_portal_inbox_manager_v1"));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.rows[0].body).toBe(body);
    expect(payload.rows[0].messages).toHaveLength(1);
  });

  it("checks replacement visibility beyond the first forty distinct summaries", async () => {
    const markers = Array.from({ length: 41 }, (_, i) => ({ ...marker, sourceEventId: `SM${i}` }));
    mocks.turns = markers.map((item, i) => ({ owner_manager_user_id: "owner-1", source_namespace: item.sourceNamespace,
      source_event_id: item.sourceEventId, conversation_id: `conv-${i}`, body, occurred_at: item.occurredAt }));
    mocks.summaries = markers.map((_, i) => ({ id: `conv-${i}`, owner_manager_user_id: "owner-1",
      counterparty_role: "prospect", work_line_id: "line-1", work_line_phone: "+15550009999",
      identity_key: `phone:+1555000${String(i).padStart(4, "0")}`, identity_kind: "phone",
      counterparty_user_id: null, counterparty_phone: null, legacy_conversation_key: null, metadata: {} }));
    mocks.record = { ...mocks.record!, row_data: { ...(mocks.record!.row_data as object),
      rootOriginalSmsEvent: markers[0],
      messages: markers.slice(1).map((item, i) => ({ id: `original-${i + 1}`, body, at: item.occurredAt,
        originalSmsEvent: item })) } };
    mocks.visible.mockImplementation(async (_db, _viewer, candidates) =>
      new Set(candidates.map((candidate: { id: string }) => candidate.id)));
    const response = await GET(new Request("https://example.test/api/portal-inbox-threads?scope=axis_portal_inbox_manager_v1"));
    expect(response.status).toBe(200);
    expect((await response.json()).rows).toHaveLength(0);
    expect(mocks.visible).toHaveBeenCalledTimes(2);
    expect(mocks.visible.mock.calls.map((call) => call[2].length)).toEqual([40, 1]);
  });
});
