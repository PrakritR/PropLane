/**
 * POST /api/portal/send-inbox-message is the manager's compose send. A manager acting in a
 * workspace whose OWNER is on a live signup trial is refused (402) before anything is stored or
 * delivered; a paid owner's workspace, a resident sender, and a write to PropLane support are not.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  senderRole: "manager" as string,
  access: { allowed: true } as
    | { allowed: true }
    | { allowed: false; reason: "trial" | "plan_unreadable"; status: 402 | 503; message: string },
  assertForWorkspace: vi.fn(),
  writes: [] as string[],
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
vi.mock("@/lib/manager-communication-access.server", () => ({
  assertManagerCommunicationAllowedForWorkspace: (...args: unknown[]) => {
    h.assertForWorkspace(...args);
    return Promise.resolve(h.access);
  },
}));

import { POST } from "@/app/api/portal/send-inbox-message/route";
import { PRIMARY_ADMIN_EMAIL } from "@/lib/auth/primary-admin";

const post = (body: Record<string, unknown>) =>
  POST(
    new Request("http://localhost/api/portal/send-inbox-message", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subject: "Hi", text: "Hello there", toEmails: ["res@example.com"], senderPortal: "manager", ...body }),
    }),
  );

const TRIAL = { allowed: false, reason: "trial", status: 402, message: "Communication is available on a paid plan." } as const;

beforeEach(() => {
  h.senderRole = "manager";
  h.access = { allowed: true };
  h.assertForWorkspace.mockClear();
  h.writes.length = 0;
  h.recipients = [{ id: "res-1", email: "res@example.com", role: "resident" }];
});

describe("send-inbox-message and a live signup trial", () => {
  it("refuses a manager send in a trial owner's workspace with 402 and writes nothing", async () => {
    h.access = TRIAL;
    const res = await post({});
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({
      ok: false,
      error: "Communication is available on a paid plan.",
      code: "communication_trial",
    });
    // The plan checked is the workspace owner's: the route names the active workspace.
    expect(h.assertForWorkspace).toHaveBeenCalledWith(expect.anything(), "mate-1", "ws-owner");
    expect(h.writes).toEqual([]);
  });

  it("answers 503 when the plan cannot be read (fail closed)", async () => {
    h.access = { allowed: false, reason: "plan_unreadable", status: 503, message: "We could not verify your plan." };
    const res = await post({});
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, code: "communication_plan_unreadable" });
    expect(h.writes).toEqual([]);
  });

  it("does not refuse when the workspace owner is paid", async () => {
    const res = await post({});
    expect(h.assertForWorkspace).toHaveBeenCalled();
    expect(res.status).not.toBe(402);
    expect(res.status).not.toBe(503);
  });

  it("never asks the question of a resident sender (inbound to the workspace is not gated)", async () => {
    h.senderRole = "resident";
    h.access = TRIAL;
    const res = await post({ senderPortal: "resident" });
    expect(h.assertForWorkspace).not.toHaveBeenCalled();
    expect(res.status).not.toBe(402);
  });

  it("leaves a message to PropLane support open", async () => {
    h.access = TRIAL;
    h.recipients = [{ id: "admin-1", email: PRIMARY_ADMIN_EMAIL, role: "admin" }];
    const res = await post({ toEmails: [PRIMARY_ADMIN_EMAIL] });
    expect(h.assertForWorkspace).not.toHaveBeenCalled();
    expect(res.status).not.toBe(402);
  });
});
