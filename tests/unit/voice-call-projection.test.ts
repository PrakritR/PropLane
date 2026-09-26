import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  project: vi.fn(async () => ({ conversationId: "conversation-1", eventId: "turn-1", inserted: true, eventCount: 1 })),
  resolveLine: vi.fn(async () => ({ workLineId: "line-1", phoneNumber: "+15550009999", workspaceId: null })),
  enqueue: vi.fn(async () => undefined),
}));
vi.mock("@/lib/sms/sms-projection.server", () => ({
  projectOriginalEvent: mocks.project,
  resolveSmsProjectionWorkLine: mocks.resolveLine,
  enqueueSmsProjectionRetry: mocks.enqueue,
}));

import { projectManagerSmsEvent } from "@/lib/sms/project-manager-sms-event.server";

beforeEach(() => vi.clearAllMocks());

describe("voice call notes in the manager projection", () => {
  it("stores a call-tagged annotation without claiming a provider SMS SID", async () => {
    const ok = await projectManagerSmsEvent({} as never, {
      ownerManagerUserId: "manager-1", counterpartyRole: "manager", counterpartyUserId: "actor-1",
      counterpartyPhone: "+15550001111", workPhone: "+15550009999",
      legacyConversationKey: "manager-1:manager:actor-1", messageSid: "voice:CAcall1:user:abc",
      direction: "inbound", body: "Spoken call note", occurredAt: "2026-09-25T12:00:00.000Z",
      fromPhone: "+15550001111", toPhone: "+15550009999", source: "work_number",
    });
    expect(ok).toBe(true);
    expect(mocks.project).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      sourceNamespace: "voice:manager-1", sourceEventId: "voice:CAcall1:user:abc",
      body: "Spoken call note", metadata: { annotationKind: "call" },
    }));
  });
});
