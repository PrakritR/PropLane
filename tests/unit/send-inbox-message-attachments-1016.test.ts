/**
 * QA C3: attachments ride beside the message as chips. The absolute links are added to the copy
 * that LEAVES the app (email / SMS) only; the in-app thread, its preview and the sender's copy
 * store the message text as typed.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  senderRole: "manager" as string,
  access: { allowed: true } as
    | { allowed: true }
    | { allowed: false; reason: "trial" | "plan_unreadable"; status: 402 | 503; message: string },
  assertForWorkspace: vi.fn(),
  writes: [] as string[],
  sides: [] as { folder: string; body: string; preview: string; attachments?: unknown }[],
  recipients: [{ id: "res-1", email: "res@example.com", role: "resident" }] as { id: string; email: string; role: string }[],
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "mate-1", email: "mate@example.com" } } }) },
  }),
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from(table: string) {
      let isIn = false;
      const chain: Record<string, unknown> = {};
      const rows = () => {
        if (table === "profiles") return isIn ? h.recipients : { role: "manager", full_name: "Mate", email: "mate@example.com" };
        return isIn ? [] : null;
      };
      for (const m of ["select", "eq", "ilike", "order", "limit", "or", "neq", "is", "gte", "lte"]) chain[m] = () => chain;
      chain.in = () => {
        isIn = true;
        return chain;
      };
      for (const m of ["insert", "upsert", "update", "delete"]) {
        chain[m] = () => {
          h.writes.push(`${table}.${m}`);
          return chain;
        };
      }
      chain.maybeSingle = async () => ({ data: rows(), error: null });
      chain.single = async () => ({ data: rows(), error: null });
      chain.then = (resolve: (v: unknown) => unknown) => resolve({ data: rows(), error: null });
      return chain;
    },
    rpc: async () => ({ data: null, error: null }),
  }),
}));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: async () => ({ ok: true }), clientIpFrom: () => "127.0.0.1" }));
vi.mock("@/lib/test-workspaces/index.server", () => ({
  resolveAuthenticatedBusinessAccess: async () => ({ kind: "live" }),
}));
vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: async () => false }));
vi.mock("@/lib/inbox-portal-sender", () => ({ resolveInboxSenderRoleForPortal: async () => h.senderRole }));
vi.mock("@/lib/communication/conversation-visibility.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/communication/conversation-visibility.server")>()),
  resolveCommunicationScope: async () => ({
    viewerId: "mate-1",
    level: "edit",
    ownerIds: ["mate-1"],
    grantedHousesByOwner: new Map(),
    workspaceHouseIds: null,
    untaggedOwnedVisible: true,
    activeWorkspaceId: "ws-owner",
    workspaceByLine: new Map(),
  }),
}));
vi.mock("@/lib/inbox-recipient-scope", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/inbox-recipient-scope")>()),
  filterRecipientsBySenderScope: async (_db: unknown, _sender: unknown, recipients: unknown[]) => ({
    allowed: recipients,
  }),
}));
vi.mock("@/lib/property-owner/access.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/property-owner/access.server")>()),
  applyOwnerMessageInboxScope: async (_db: unknown, _who: unknown, recipients: unknown[]) => recipients,
}));
vi.mock("@/lib/portal-inbox-delivery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/portal-inbox-delivery")>()),
  deliverPortalMessageThreadSide: async (_db: unknown, args: { folder: string; body: string; preview: string; attachments?: unknown }) => {
    h.sides.push({ folder: args.folder, body: args.body, preview: args.preview, attachments: args.attachments });
    return { action: "create", threadId: "t" };
  },
}));
vi.mock("@/lib/manager-communication-access.server", () => ({
  assertManagerCommunicationAllowedForWorkspace: (...args: unknown[]) => {
    h.assertForWorkspace(...args);
    return Promise.resolve(h.access);
  },
}));

import { POST } from "@/app/api/portal/send-inbox-message/route";

beforeEach(() => {
  h.senderRole = "manager";
  h.access = { allowed: true };
  h.writes.length = 0;
  h.sides.length = 0;
  h.recipients = [{ id: "res-1", email: "res@example.com", role: "resident" }];
});

describe("send-inbox-message attachments", () => {
  it("keeps the attachment links out of the stored in-app copy and its preview", async () => {
    const res = await POST(
      new Request("http://localhost/api/portal/send-inbox-message", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          subject: "Photo",
          text: "Here is the photo",
          toEmails: ["res@example.com"],
          senderPortal: "manager",
          deliverViaEmail: false,
          attachmentUrls: ["/api/portal/inbox-attachments?path=mate-1%2Fphoto.png"],
        }),
      }),
    );
    expect(res.status).toBe(200);
    expect(h.sides.length).toBeGreaterThan(0);
    for (const side of h.sides) {
      expect(side.body).toBe("Here is the photo");
      expect(side.body).not.toMatch(/Attachments:|inbox-attachments/);
      expect(side.preview).toBe("Here is the photo");
      expect(side.attachments).toBeTruthy();
    }
  });

  it("hands EVERY in-app delivery the stored text and the attachments, never the email copy", () => {
    // The resident -> property-manager chat and the admin shared inbox write their turn
    // verbatim from the body they are handed; passing `text` there put the email's
    // "Attachments:" URL block in the bubble, so both take `storedText` + `attachments`.
    const source = readFileSync(
      join(__dirname, "..", "..", "src", "app", "api", "portal", "send-inbox-message", "route.ts"),
      "utf8",
    );
    for (const call of ["deliverResidentPropertyManagerChatMessage(", "deliverPortalMessageToAdminSharedInbox("]) {
      const start = source.indexOf(call);
      expect(start).toBeGreaterThan(-1);
      const args = source.slice(start, source.indexOf("});", start));
      expect(args).toMatch(/(message|body): storedText/);
      expect(args).toMatch(/attachments: inboxAttachmentsFromUrls\(attachmentUrls\)/);
      expect(args).not.toMatch(/(message|body): text,/);
    }
  });

  it("an attachment-only message is stored as '(attachment)', not as a bare link", async () => {
    await POST(
      new Request("http://localhost/api/portal/send-inbox-message", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          subject: "Photo",
          text: "",
          toEmails: ["res@example.com"],
          senderPortal: "manager",
          deliverViaEmail: false,
          attachmentUrls: ["/api/portal/inbox-attachments?path=mate-1%2Fphoto.png"],
        }),
      }),
    );
    expect(h.sides.map((side) => side.body)).toEqual(expect.arrayContaining(["(attachment)"]));
    for (const side of h.sides) expect(side.body).not.toMatch(/inbox-attachments/);
  });
});
