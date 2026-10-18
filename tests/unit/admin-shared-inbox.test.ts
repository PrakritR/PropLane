import { describe, expect, it, vi, beforeEach } from "vitest";
import { ADMIN_INBOX_SCOPE } from "@/lib/portal-inbox-thread-scope";
import { PRIMARY_ADMIN_EMAIL } from "@/lib/auth/primary-admin";
import { PRIMARY_AXIS_ADMIN_LABEL } from "@/data/inbox-scoped-directory";
import {
  adminPortalThreadIdForSender,
  deliverAdminReplyFromSharedInbox,
  deliverPortalMessageToAdminSharedInbox,
  isPrimaryAdminRecipientEmail,
} from "@/lib/admin-shared-inbox.server";

vi.mock("@/lib/portal-inbox-delivery", () => ({
  deliverPortalMessageThreadSide: vi.fn().mockResolvedValue({ action: "create", threadId: "mgr-thread" }),
  scopeForRole: vi.fn(() => "axis_portal_inbox_manager_v1"),
}));

import { deliverPortalMessageThreadSide } from "@/lib/portal-inbox-delivery";

type Row = {
  id: string;
  scope: string;
  participant_email: string | null;
  row_data: Record<string, unknown>;
  updated_at?: string;
};

function makeDb(initial: Row[] = []) {
  const rows = [...initial];
  return {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(function eq(this: unknown, col: string, val: unknown) {
          return {
            eq: eq.bind(this),
            order: vi.fn(() => ({
              limit: vi.fn(async () => ({
                data: rows
                  .filter((r) => {
                    if (col === "scope" && val === ADMIN_INBOX_SCOPE) return r.scope === ADMIN_INBOX_SCOPE;
                    if (col === "participant_email") return r.participant_email === val;
                    if (col === "id") return r.id === val;
                    return true;
                  })
                  .sort((a, b) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? ""))),
              })),
            })),
            maybeSingle: vi.fn(async () => {
              const match = rows.find((r) => r.id === val);
              return { data: match ?? null };
            }),
            ilike: vi.fn(() => ({
              maybeSingle: vi.fn(async () => ({ data: { id: "mgr-user-1" } })),
            })),
          };
        }),
        ilike: vi.fn(() => ({
          maybeSingle: vi.fn(async () => ({ data: { id: "mgr-user-1" } })),
        })),
      })),
      upsert: vi.fn(async (record: Row) => {
        const idx = rows.findIndex((r) => r.id === record.id);
        const next = {
          id: record.id,
          scope: record.scope,
          participant_email: record.participant_email ?? null,
          row_data: record.row_data,
          updated_at: new Date().toISOString(),
        };
        if (idx === -1) rows.push(next);
        else rows[idx] = next;
        return { error: null };
      }),
      insert: vi.fn(),
    })),
    _rows: rows,
  };
}

describe("admin-shared-inbox.server", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("detects the primary admin recipient email", () => {
    expect(isPrimaryAdminRecipientEmail(PRIMARY_ADMIN_EMAIL)).toBe(true);
    expect(isPrimaryAdminRecipientEmail("other@example.com")).toBe(false);
  });

  it("uses a stable thread id per sender email", () => {
    const a = adminPortalThreadIdForSender("manager@test.com");
    const b = adminPortalThreadIdForSender("manager@test.com");
    const c = adminPortalThreadIdForSender("other@test.com");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a.startsWith("admin_portal_")).toBe(true);
  });

  it("creates one shared admin thread for the first portal message", async () => {
    const db = makeDb();
    const result = await deliverPortalMessageToAdminSharedInbox(db as never, {
      senderEmail: "manager@test.com",
      senderName: "Test Manager",
      senderRole: "manager",
      subject: "Help",
      body: "First message",
    });
    expect(result.created).toBe(true);
    expect(db._rows).toHaveLength(1);
    expect(db._rows[0]!.scope).toBe(ADMIN_INBOX_SCOPE);
    expect(db._rows[0]!.participant_email).toBe("manager@test.com");
    expect(db._rows[0]!.row_data.body).toBe("First message");
  });

  it("stores the sender's files beside the body, never as links inside it", async () => {
    const db = makeDb();
    const attachments = [{ url: "/api/portal/inbox-attachments?path=mgr-1%2Flease.pdf", name: "lease.pdf" }];
    await deliverPortalMessageToAdminSharedInbox(db as never, {
      senderEmail: "manager@test.com",
      senderName: "Test Manager",
      senderRole: "manager",
      subject: "Help",
      body: "The lease is attached",
      attachments,
    });
    expect(db._rows[0]!.row_data.attachments).toEqual(attachments);
    expect(String(db._rows[0]!.row_data.body)).toBe("The lease is attached");
    expect(String(db._rows[0]!.row_data.body)).not.toMatch(/Attachments:|inbox-attachments/);
  });

  it("appends follow-up portal messages into the same admin thread", async () => {
    const threadId = adminPortalThreadIdForSender("manager@test.com");
    const db = makeDb([
      {
        id: threadId,
        scope: ADMIN_INBOX_SCOPE,
        participant_email: "manager@test.com",
        row_data: {
          id: threadId,
          name: "Test Manager",
          email: "manager@test.com",
          participantEmail: "manager@test.com",
          topic: "Help",
          body: "First message",
          createdAt: "2026-01-01T00:00:00.000Z",
          read: true,
          folder: "inbox",
          senderRole: "manager",
          thread: [],
          scope: ADMIN_INBOX_SCOPE,
        },
      },
    ]);
    const result = await deliverPortalMessageToAdminSharedInbox(db as never, {
      senderEmail: "manager@test.com",
      senderName: "Test Manager",
      senderRole: "manager",
      subject: "Follow up",
      body: "Second message",
    });
    expect(result.created).toBe(false);
    const thread = db._rows[0]!.row_data.thread as { body: string }[];
    expect(thread).toHaveLength(1);
    expect(thread[0]!.body).toBe("Second message");
    expect(db._rows[0]!.row_data.read).toBe(false);
  });

  it("delivers admin replies as PropLane admin into the sender inbox", async () => {
    const threadId = adminPortalThreadIdForSender("manager@test.com");
    const db = makeDb([
      {
        id: threadId,
        scope: ADMIN_INBOX_SCOPE,
        participant_email: "manager@test.com",
        row_data: {
          id: threadId,
          name: "Test Manager",
          email: "manager@test.com",
          participantEmail: "manager@test.com",
          topic: "Help",
          body: "First message",
          createdAt: "2026-01-01T00:00:00.000Z",
          read: false,
          folder: "inbox",
          senderRole: "manager",
          thread: [],
          scope: ADMIN_INBOX_SCOPE,
        },
      },
    ]);
    const result = await deliverAdminReplyFromSharedInbox(db as never, {
      threadId,
      replyText: "We can help with that.",
    });
    expect(result.ok).toBe(true);
    const replies = db._rows[0]!.row_data.thread as { authorLabel: string; body: string }[];
    expect(replies[0]!.authorLabel).toBe(PRIMARY_AXIS_ADMIN_LABEL);
    expect(replies[0]!.body).toBe("We can help with that.");
    expect(deliverPortalMessageThreadSide).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        folder: "inbox",
        otherPartyEmail: PRIMARY_ADMIN_EMAIL,
        fromName: PRIMARY_AXIS_ADMIN_LABEL,
        body: "We can help with that.",
      }),
    );
  });
});
