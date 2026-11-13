import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";

/**
 * Delivery receipts (provider ids + failure reasons) belong to the sender. A resident reading the
 * conversation a manager sent them must not receive them in the list payload.
 */

const RESIDENT_SCOPE = "axis_portal_inbox_resident_v1";
const RESIDENT = "resident-1";
const MANAGER = "manager-1";

const receipt = [{ channel: "email", state: "failed", providerId: "re_secret_123", reason: "550 mailbox unavailable" }];

const state = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("@/lib/portal-inbox-thread-scope", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveInboxScopeUser: async () => ({ user: { id: "resident-1", email: "res@example.test", role: "resident" }, db: state.db }),
  applyPortalInboxThreadScope: (query: { in: (col: string, ids: string[]) => unknown }) => query,
}));
vi.mock("@/lib/auth/view-as.server", () => ({ isViewAsSessionOpen: async () => true }));
vi.mock("@/lib/agent/resident-inbox-agent.server", () => ({ ensureResidentAgentThread: vi.fn() }));
vi.mock("@/lib/communication/resident-conversations.server", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  applyResidentConversationExtras: async (_db: unknown, _viewer: unknown, rows: unknown[]) => ({ rows, phone: null }),
}));
vi.mock("@/lib/portal-inbox-storage", () => ({
  collapseAssistantInboxThreads: (rows: unknown[]) => rows,
  collapsePersonInboxThreads: (rows: unknown[]) => rows,
}));

import { GET } from "@/app/api/portal-inbox-threads/route";

describe("GET /api/portal-inbox-threads - resident read", () => {
  beforeEach(() => {
    state.db = createMemoryDb({
      portal_inbox_thread_records: [
        {
          id: "t-1",
          scope: RESIDENT_SCOPE,
          owner_user_id: RESIDENT,
          participant_email: "res@example.test",
          thread_type: null,
          updated_at: "2026-09-15T00:00:00.000Z",
          row_data: {
            id: "t-1",
            from: "Manager",
            email: "res@example.test",
            subject: "Hello",
            body: "Hi",
            time: "Sep 15, 9:00 AM",
            unread: false,
            managerUserId: MANAGER,
            rootDeliveries: receipt,
            messages: [{ id: "m-1", from: "Manager", body: "Second", outbound: false, deliveries: receipt }],
          },
        },
      ],
    });
  });

  it("strips provider ids and failure reasons from the row and every message", async () => {
    const response = await GET(new Request(`https://example.test/api/portal-inbox-threads?scope=${RESIDENT_SCOPE}`));
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain("re_secret_123");
    expect(text).not.toContain("mailbox unavailable");
    const body = JSON.parse(text) as { rows: Array<Record<string, unknown>> };
    const row = body.rows.find((r) => r.id === "t-1");
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty("rootDeliveries");
    expect((row!.messages as Array<Record<string, unknown>>)[0]).not.toHaveProperty("deliveries");
    expect((row!.messages as Array<Record<string, unknown>>)[0].body).toBe("Second");
  });
});
