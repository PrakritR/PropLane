import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonRequest, parseJsonResponse } from "../../helpers/api-request";

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
  cookies: vi.fn().mockResolvedValue(new Map()),
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: vi.fn(),
}));

vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: vi.fn(),
}));

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(() => ({ ok: true })),
  clientIpFrom: vi.fn(() => "127.0.0.1"),
}));

vi.mock("@/lib/auth/admin-preview", () => ({
  isAdminUser: vi.fn().mockResolvedValue(false),
}));

vi.mock("@/lib/auth/resident-relationship", () => ({
  managerOwnsResident: vi.fn().mockResolvedValue(true),
}));

vi.mock("@/lib/twilio", () => ({
  sendSms: vi.fn().mockResolvedValue({ sent: false }),
}));

vi.mock("@/lib/test-workspaces/index.server", () => ({
  resolveAuthenticatedBusinessAccess: vi.fn().mockResolvedValue({ kind: "normal" }),
  resolveTestWorkspaceClassification: vi.fn().mockResolvedValue({ kind: "normal" }),
}));

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { rateLimit } from "@/lib/rate-limit";
import { POST as sendInboxMessage } from "@/app/api/portal/send-inbox-message/route";
import * as inboxRecipientScope from "@/lib/inbox-recipient-scope";

const MANAGER_SCOPE = "axis_portal_inbox_manager_v1";
const RESIDENT_SCOPE = "axis_portal_inbox_resident_v1";
const VENDOR_SCOPE = "axis_portal_inbox_vendor_v1";

function makeSelectedReplyDb(options: {
  rowData: Record<string, unknown>;
  recipientProfiles: Array<{ id: string; email: string; role: string }>;
  broadcastRows?: Array<{ manager_user_id: string; resident_email: string; row_data: Record<string, unknown> }>;
  threadRows?: Array<Record<string, unknown>>;
}) {
  const upsert = vi.fn().mockResolvedValue({ error: null });
  const insert = vi.fn();
  const selectedThread = {
    id: "selected-thread",
    owner_user_id: "mgr_1",
    participant_email: "resident-a@example.com",
    scope: MANAGER_SCOPE,
    thread_type: "portal_message",
    row_data: options.rowData,
  };
  const rows = [selectedThread, ...(options.threadRows ?? [])] as Array<Record<string, unknown>>;
  const matches = (filters: Map<string, string>, row: Record<string, unknown>) =>
    [...filters.entries()].every(([column, value]) => {
      if (column.startsWith("row_data->>")) {
        const field = column.slice("row_data->>".length);
        return String((row.row_data as Record<string, unknown> | undefined)?.[field] ?? "") === value;
      }
      return String(row[column] ?? "") === value;
    });
  const from = vi.fn().mockImplementation((table: string) => {
    if (table === "portal_inbox_thread_records") {
      const filters = new Map<string, string>();
      const query: Record<string, unknown> = {
        eq: vi.fn((column: string, value: string) => {
          filters.set(column, value);
          return query;
        }),
        maybeSingle: vi.fn().mockImplementation(async () => ({ data: rows.find((row) => matches(filters, row)) ?? null, error: null })),
        order: vi.fn(() => query),
        limit: vi.fn().mockImplementation(async () => ({ data: rows.filter((row) => matches(filters, row)), error: null })),
      };
      return {
        select: vi.fn().mockReturnValue(query),
        upsert: upsert.mockImplementation(async (written: Record<string, unknown>) => {
          const index = rows.findIndex((row) => row.id === written.id);
          if (index >= 0) rows[index] = { ...rows[index], ...written };
          else rows.push(written);
          return { error: null };
        }),
        insert: insert.mockImplementation(async (written: Record<string, unknown>) => {
          rows.push(written);
          return { error: null };
        }),
      };
    }
    if (table === "manager_application_records") {
      const query: Record<string, unknown> = {
        ilike: vi.fn(() => query),
        in: vi.fn().mockResolvedValue({ data: options.broadcastRows ?? [], error: null }),
        limit: vi.fn().mockResolvedValue({ data: options.broadcastRows ?? [], error: null }),
      };
      return { select: vi.fn().mockReturnValue(query), upsert };
    }
    const query: Record<string, unknown> = {
      eq: vi.fn(() => query),
      in: vi.fn().mockResolvedValue({ data: options.recipientProfiles, error: null }),
      maybeSingle: vi.fn().mockResolvedValue({ data: { role: "manager" }, error: null }),
    };
    return { select: vi.fn().mockReturnValue(query), upsert };
  });
  return { from, upsert, insert, rows };
}

function makeDbMock(options: { senderRole?: string; recipientEmail?: string; recipientId?: string } = {}) {
  const upsert = vi.fn().mockResolvedValue({ error: null });
  const maybeSingle = vi.fn().mockResolvedValue({
    data: options.recipientId
      ? { id: options.recipientId, email: options.recipientEmail ?? "recipient@example.com", role: options.senderRole ?? "manager" }
      : { role: options.senderRole ?? "manager" },
    error: null,
  });
  const select = vi.fn().mockReturnThis();
  const from = vi.fn().mockReturnValue({
    select,
    upsert,
    update: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    ilike: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    maybeSingle,
  });
  return { from, upsert };
}

describe("POST /api/portal/send-inbox-message", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.RESEND_FROM = "PropLane <test@axis.local>";
    vi.mocked(rateLimit).mockReturnValue({ ok: true } as ReturnType<typeof rateLimit>);
  });

  it("returns 401 when unauthenticated", async () => {
    vi.mocked(createSupabaseServerClient).mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) },
    } as never);

    const req = jsonRequest("http://localhost/api/portal/send-inbox-message", {
      method: "POST",
      body: { subject: "Hello", text: "Body" },
    });
    const res = await sendInboxMessage(req);
    expect(res.status).toBe(401);
  });

  it("returns 400 when subject is missing", async () => {
    vi.mocked(createSupabaseServerClient).mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "user_1", email: "mgr@example.com" } } }) },
    } as never);
    const { from } = makeDbMock({ senderRole: "manager" });
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue({ from } as never);

    const req = jsonRequest("http://localhost/api/portal/send-inbox-message", {
      method: "POST",
      body: { text: "No subject" },
    });
    const res = await sendInboxMessage(req);
    expect(res.status).toBe(400);
  });

  it("returns 400 when text is missing", async () => {
    vi.mocked(createSupabaseServerClient).mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "user_1", email: "mgr@example.com" } } }) },
    } as never);
    const { from } = makeDbMock({ senderRole: "manager" });
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue({ from } as never);

    const req = jsonRequest("http://localhost/api/portal/send-inbox-message", {
      method: "POST",
      body: { subject: "A subject" },
    });
    const res = await sendInboxMessage(req);
    expect(res.status).toBe(400);
  });

  it("rejects a malformed client send id", async () => {
    vi.mocked(createSupabaseServerClient).mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "user_1", email: "resident@example.com" } } }) },
    } as never);

    const res = await sendInboxMessage(jsonRequest("http://localhost/api/portal/send-inbox-message", {
      method: "POST",
      body: { subject: "Hello", text: "Body", sendId: "reuse-this" },
    }));

    expect(res.status).toBe(400);
    await expect(parseJsonResponse(res)).resolves.toMatchObject({ data: { error: "Invalid send id." } });
  });

  it("returns 429 when rate limited", async () => {
    vi.mocked(rateLimit).mockReturnValue({ ok: false } as ReturnType<typeof rateLimit>);
    vi.mocked(createSupabaseServerClient).mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "user_1", email: "mgr@example.com" } } }) },
    } as never);

    const req = jsonRequest("http://localhost/api/portal/send-inbox-message", {
      method: "POST",
      body: { subject: "Hi", text: "Msg" },
    });
    const res = await sendInboxMessage(req);
    expect(res.status).toBe(429);
  });

  it("manager → resident: creates sender Sent + recipient inbox record in correct scopes", async () => {
    // Recipient-scope authorization has its own focused coverage. This test is
    // for the post-authorization delivery contract, so keep the fixture on the
    // allowed side of that boundary instead of accidentally depending on every
    // relationship table queried by the scope resolver.
    vi.spyOn(inboxRecipientScope, "filterRecipientsBySenderScope").mockImplementation(
      async (_db, _sender, recipients) => ({ allowed: recipients, blocked: [] }),
    );
    vi.mocked(createSupabaseServerClient).mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "mgr_1", email: "mgr@example.com" } } }) },
    } as never);

    const upsert = vi.fn().mockResolvedValue({ error: null });
    const insert = vi.fn().mockResolvedValue({ error: null });
    const maybeSingleFns: ReturnType<typeof vi.fn>[] = [];

    // profiles.select().eq().maybeSingle() → sender role
    const senderProfileMaybeSingle = vi.fn().mockResolvedValue({ data: { role: "manager" }, error: null });
    // profiles.select().in() → recipient profiles (by userId)
    const recipientProfilesData = vi.fn().mockResolvedValue({
      data: [{ id: "res_1", email: "resident@example.com", role: "resident" }],
      error: null,
    });

    const from = vi.fn().mockImplementation(() => {
      const obj: Record<string, unknown> = {};
      obj.upsert = upsert;
      obj.insert = insert;
      // Chainable stand-in for the person-thread lookup
      // (findExistingPortalMessageThread): .eq()×5 → .order() → .limit(), plus
      // .maybeSingle() for the profiles sender-role lookup. No existing thread,
      // so each send creates a fresh sent/inbox row.
      const threadQuery: Record<string, unknown> = {
        eq: vi.fn(() => threadQuery),
        order: vi.fn(() => threadQuery),
        limit: vi.fn().mockResolvedValue({ data: [], error: null }),
        maybeSingle: senderProfileMaybeSingle,
      };
      obj.select = vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue(threadQuery),
        in: vi.fn().mockReturnValue(recipientProfilesData()),
        ilike: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        maybeSingle: senderProfileMaybeSingle,
      });
      return obj;
    });
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue({ from } as never);

    // Mock fetch (Resend) to return success
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "email_123" }), { status: 200 }),
    ) as never;

    const req = jsonRequest("http://localhost/api/portal/send-inbox-message", {
      method: "POST",
      body: {
        subject: "Test message",
        text: "Hello resident",
        toEmails: "resident@example.com",
        senderPortal: "manager",
        deliverToPortalInbox: true,
        deliverViaEmail: false,
      },
    });
    const res = await sendInboxMessage(req);
    const { status } = await parseJsonResponse(res);

    // Should succeed (200 or skipped ok)
    expect(status).toBeLessThan(500);

    // Fresh compose creates both records through insert. Existing threads use upsert.
    expect(upsert).not.toHaveBeenCalled();
    expect(insert).toHaveBeenCalledTimes(2);
    const [senderCall, recipientCall] = insert.mock.calls;
    expect(senderCall[0]).toMatchObject({ scope: MANAGER_SCOPE, row_data: expect.objectContaining({ folder: "sent" }) });
    expect(recipientCall[0]).toMatchObject({ scope: RESIDENT_SCOPE, row_data: expect.objectContaining({ folder: "inbox" }) });
  });

  it("vendor → manager via toEmails: recipient inbox uses manager scope", async () => {
    const filterSpy = vi.spyOn(inboxRecipientScope, "filterRecipientsBySenderScope").mockImplementation(
      async (_db, _sender, recipients) => ({ allowed: recipients, blocked: [] }),
    );

    vi.mocked(createSupabaseServerClient).mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "ven_1", email: "vendor@example.com" } } }) },
    } as never);

    const upsert = vi.fn().mockResolvedValue({ error: null });
    const insert = vi.fn().mockResolvedValue({ error: null });
    const senderProfileMaybeSingle = vi.fn().mockResolvedValue({ data: { role: "vendor" }, error: null });
    const recipientProfilesData = vi.fn().mockResolvedValue({
      data: [{ id: "mgr_1", email: "mgr@example.com", role: "manager" }],
      error: null,
    });

    const from = vi.fn().mockImplementation(() => {
      const obj: Record<string, unknown> = {};
      obj.upsert = upsert;
      obj.insert = insert;
      const threadQuery: Record<string, unknown> = {
        eq: vi.fn(() => threadQuery),
        order: vi.fn(() => threadQuery),
        limit: vi.fn().mockResolvedValue({ data: [], error: null }),
        maybeSingle: senderProfileMaybeSingle,
      };
      obj.select = vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue(threadQuery),
        in: vi.fn().mockReturnValue(recipientProfilesData()),
        ilike: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        maybeSingle: senderProfileMaybeSingle,
      });
      return obj;
    });
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue({ from } as never);

    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "email_123" }), { status: 200 }),
    ) as never;

    const req = jsonRequest("http://localhost/api/portal/send-inbox-message", {
      method: "POST",
      body: {
        subject: "Vendor note",
        text: "Hello manager",
        senderPortal: "vendor",
        toEmails: "mgr@example.com",
        deliverToPortalInbox: true,
        deliverViaEmail: false,
      },
    });
    const res = await sendInboxMessage(req);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(upsert).not.toHaveBeenCalled();
    expect(insert).toHaveBeenCalledTimes(2);
    const recipientCall = insert.mock.calls.find(
      (call) => (call[0] as { scope?: string }).scope === MANAGER_SCOPE,
    );
    expect(recipientCall).toBeTruthy();
    expect(recipientCall![0]).toMatchObject({
      scope: MANAGER_SCOPE,
      owner_user_id: "mgr_1",
      row_data: expect.objectContaining({ folder: "inbox" }),
    });
    expect(insert.mock.calls[0]?.[0]).toMatchObject({
      scope: VENDOR_SCOPE,
      owner_user_id: "ven_1",
      row_data: expect.objectContaining({ folder: "sent" }),
    });
  });

  it("deliverToPortalInbox:false skips upserts", async () => {
    vi.mocked(createSupabaseServerClient).mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "mgr_1", email: "mgr@example.com" } } }) },
    } as never);

    const upsert = vi.fn().mockResolvedValue({ error: null });
    const from = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({ maybeSingle: vi.fn().mockResolvedValue({ data: { role: "manager" }, error: null }) }),
        in: vi.fn().mockResolvedValue({ data: [], error: null }),
        ilike: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: { role: "manager" }, error: null }),
      }),
      upsert,
    });
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue({ from } as never);

    const req = jsonRequest("http://localhost/api/portal/send-inbox-message", {
      method: "POST",
      body: {
        subject: "No inbox",
        text: "Skip portal",
        toEmails: "resident@example.com",
        deliverToPortalInbox: false,
        deliverViaEmail: false,
      },
    });
    await sendInboxMessage(req);
    // No upserts should be made for inbox records when portal delivery is off
    const inboxUpserts = upsert.mock.calls.filter((call) => {
      const data = call[0] as { row_data?: { folder?: string } };
      return data?.row_data?.folder === "sent" || data?.row_data?.folder === "inbox";
    });
    expect(inboxUpserts).toHaveLength(0);
  });

  it("non-staff sender restricted to managed recipients only", async () => {
    const { managerOwnsResident } = await import("@/lib/auth/resident-relationship");
    vi.mocked(managerOwnsResident).mockResolvedValue(false);

    vi.mocked(createSupabaseServerClient).mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "res_1", email: "resident@example.com" } } }) },
    } as never);

    const from = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({ maybeSingle: vi.fn().mockResolvedValue({ data: { role: "resident" }, error: null }) }),
        in: vi.fn().mockResolvedValue({
          data: [{ id: "other_mgr", email: "other@example.com", role: "manager" }],
          error: null,
        }),
        ilike: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: { role: "resident" }, error: null }),
      }),
      upsert: vi.fn().mockResolvedValue({ error: null }),
    });
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue({ from } as never);

    const req = jsonRequest("http://localhost/api/portal/send-inbox-message", {
      method: "POST",
      body: {
        subject: "Hello manager",
        text: "Can I message?",
        toUserIds: ["other_mgr"],
        deliverViaEmail: false,
      },
    });
    const res = await sendInboxMessage(req);
    expect(res.status).toBe(403);
  });

  /**
   * The thread append used to run at the TOP of the route, before the
   * recipient-scope gate. So a refused send answered 403 while the message was
   * already written into `portal_inbox_thread_records` — and, because the append
   * also rewrites `preview`, the conversation list showed it as the newest
   * message in the thread. A resident whose linked rows named a stale manager
   * address hit this on every send and believed their messages had gone out.
   */
  it("a refused send writes nothing into the thread it targeted", async () => {
    const { managerOwnsResident } = await import("@/lib/auth/resident-relationship");
    vi.mocked(managerOwnsResident).mockResolvedValue(false);

    vi.mocked(createSupabaseServerClient).mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "res_1", email: "resident@example.com" } } }) },
    } as never);

    const threadUpserts: unknown[] = [];
    const threadRow = {
      id: "thr_1",
      owner_user_id: "res_1",
      participant_email: "resident@example.com",
      scope: RESIDENT_SCOPE,
      thread_type: "",
      row_data: { subject: "Leak", preview: "original preview", messages: [{ id: "m1", from: "Test Manager", body: "hi", at: "Jul 1" }] },
    };

    const from = vi.fn().mockImplementation((table: string) => ({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({
            data: table === "portal_inbox_thread_records" ? threadRow : { role: "resident" },
            error: null,
          }),
        }),
        in: vi.fn().mockResolvedValue({
          data: table === "profiles" ? [{ id: "other_mgr", email: "other@example.com", role: "manager" }] : [],
          error: null,
        }),
        ilike: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: { role: "resident" }, error: null }),
      }),
      upsert: vi.fn().mockImplementation((row: unknown) => {
        if (table === "portal_inbox_thread_records") threadUpserts.push(row);
        return Promise.resolve({ error: null });
      }),
    }));
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue({ from } as never);

    const req = jsonRequest("http://localhost/api/portal/send-inbox-message", {
      method: "POST",
      body: {
        threadId: "thr_1",
        subject: "Re: Leak",
        text: "REFUSED reply must not land in the thread",
        toUserIds: ["other_mgr"],
        deliverToPortalInbox: true,
        deliverViaEmail: false,
      },
    });
    const res = await sendInboxMessage(req);

    expect(res.status).toBe(403);
    expect(threadUpserts).toHaveLength(0);
  });

  it("refuses a selected property-A thread when the requested recipient is property-B", async () => {
    vi.spyOn(inboxRecipientScope, "filterRecipientsBySenderScope").mockImplementation(
      async (_db, _sender, recipients) => ({ allowed: recipients, blocked: [] }),
    );
    vi.mocked(createSupabaseServerClient).mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "mgr_1", email: "manager@example.com" } } }) },
    } as never);

    const threadUpserts: unknown[] = [];
    const selectedThread = {
      id: "property-a-thread",
      owner_user_id: "mgr_1",
      participant_email: "resident-a@example.com",
      scope: MANAGER_SCOPE,
      thread_type: "portal_message",
      row_data: {
        email: "resident-a@example.com",
        identityProvenance: [{ managerUserId: "mgr_1", propertyId: "property-a", counterpartyRole: "resident" }],
        messages: [{ id: "a1", body: "A history" }],
      },
    };
    const from = vi.fn().mockImplementation((table: string) => {
      const threadQuery = {
        eq: vi.fn(() => threadQuery),
        maybeSingle: vi.fn().mockResolvedValue({ data: selectedThread, error: null }),
      };
      const profilesQuery = {
        eq: vi.fn(() => profilesQuery),
        in: vi.fn().mockResolvedValue({ data: [{ id: "resident-b", email: "resident-b@example.com", role: "resident" }], error: null }),
        maybeSingle: vi.fn().mockResolvedValue({ data: { role: "manager" }, error: null }),
      };
      return {
        select: vi.fn().mockReturnValue(table === "portal_inbox_thread_records" ? threadQuery : profilesQuery),
        upsert: vi.fn().mockImplementation((row: unknown) => {
          if (table === "portal_inbox_thread_records") threadUpserts.push(row);
          return Promise.resolve({ error: null });
        }),
      };
    });
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue({ from } as never);

    const res = await sendInboxMessage(jsonRequest("http://localhost/api/portal/send-inbox-message", {
      method: "POST",
      body: {
        threadId: "property-a-thread",
        subject: "A reply",
        text: "Must not cross into B",
        toEmails: "resident-b@example.com",
        senderPortal: "manager",
        deliverToPortalInbox: true,
        deliverViaEmail: false,
      },
    }));

    expect(res.status).toBe(403);
    expect(threadUpserts).toHaveLength(0);
  });

  it("writes no turn when the selected source is not authorized for the sender", async () => {
    vi.mocked(createSupabaseServerClient).mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "mgr_2", email: "delegate@example.com" } } }) },
    } as never);

    const threadUpserts: unknown[] = [];
    const from = vi.fn().mockImplementation(() => {
      const query: Record<string, unknown> = {
        eq: vi.fn(() => query),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      };
      return {
        select: vi.fn().mockReturnValue(query),
        upsert: vi.fn().mockImplementation((row: unknown) => {
          threadUpserts.push(row);
          return Promise.resolve({ error: null });
        }),
      };
    });
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue({ from } as never);

    const res = await sendInboxMessage(jsonRequest("http://localhost/api/portal/send-inbox-message", {
      method: "POST",
      body: {
        threadId: "owner-a-thread-without-delegated-edit",
        subject: "Forged reply",
        text: "Must not degrade into fresh compose",
        toEmails: "resident-a@example.com",
        senderPortal: "manager",
        deliverToPortalInbox: true,
        deliverViaEmail: false,
      },
    }));

    expect(res.status).toBe(403);
    expect(threadUpserts).toHaveLength(0);
  });

  it("appends a selected property-A reply to manager and counterpart A histories while leaving newer B untouched", async () => {
    vi.spyOn(inboxRecipientScope, "filterRecipientsBySenderScope").mockImplementation(
      async (_db, _sender, recipients) => ({ allowed: recipients, blocked: [] }),
    );
    vi.mocked(createSupabaseServerClient).mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "mgr_1", email: "manager@example.com" } } }) },
    } as never);

    const managerAIdentity = {
      managerUserId: "mgr_1",
      propertyId: "property-a",
      counterpartyRole: "resident",
      smsConversationKey: "mgr_1:resident:resident-a",
    };
    const residentAIdentity = { managerUserId: "mgr_1", propertyId: "property-a", counterpartyRole: "manager" };
    const selectedA = {
      id: "manager-a-thread",
      owner_user_id: "mgr_1",
      participant_email: "resident-a@example.com",
      scope: MANAGER_SCOPE,
      thread_type: "portal_message",
      row_data: {
        id: "manager-a-thread", folder: "sent", email: "resident-a@example.com", ...managerAIdentity,
        identityProvenance: [managerAIdentity], messages: [{ id: "a1", body: "A history" }],
      },
    };
    const counterpartA = {
      id: "resident-a-thread",
      owner_user_id: "resident-a",
      participant_email: "resident-a@example.com",
      scope: RESIDENT_SCOPE,
      row_data: {
        id: "resident-a-thread", folder: "inbox", email: "manager@example.com", ...residentAIdentity,
        identityProvenance: [residentAIdentity], messages: [{ id: "a2", body: "A counterpart history" }],
      },
      updated_at: "2026-09-18T10:00:00.000Z",
    };
    const newerB = {
      id: "resident-b-thread",
      // A and B are two property partitions of the same resident. Keeping the
      // owner/email identical makes the fixture exercise identity resolution,
      // rather than an accidental different-person shortcut.
      owner_user_id: "resident-a",
      participant_email: "resident-a@example.com",
      scope: RESIDENT_SCOPE,
      row_data: {
        id: "resident-b-thread", folder: "inbox", email: "manager@example.com",
        managerUserId: "mgr_1", propertyId: "property-b", counterpartyRole: "manager",
        identityProvenance: [{ managerUserId: "mgr_1", propertyId: "property-b", counterpartyRole: "manager" }],
        messages: [{ id: "b1", body: "B must remain unchanged" }],
      },
      updated_at: "2026-09-18T11:00:00.000Z",
    };
    const threadUpserts: Array<{ id?: string; row_data?: Record<string, unknown> }> = [];
    let selectedLookupCount = 0;
    const from = vi.fn().mockImplementation((table: string) => {
      const threadFilters = new Map<string, string>();
      const threadQuery: Record<string, unknown> = {
        eq: vi.fn((column: string, value: string) => {
          threadFilters.set(column, value);
          return threadQuery;
        }),
        order: vi.fn(() => threadQuery),
        limit: vi.fn().mockImplementation(async () => ({
          data: [newerB, counterpartA].filter((row) =>
            [...threadFilters.entries()].every(([column, value]) => {
              if (column.startsWith("row_data->>")) {
                const field = column.slice("row_data->>".length);
                return String((row.row_data as Record<string, unknown> | undefined)?.[field] ?? "") === value;
              }
              return String(row[column as keyof typeof row] ?? "") === value;
            }),
          ),
          error: null,
        })),
        maybeSingle: vi.fn().mockImplementation(async () => {
          selectedLookupCount += 1;
          return { data: selectedLookupCount <= 2 ? selectedA : null, error: null };
        }),
      };
      const profilesQuery: Record<string, unknown> = {
        eq: vi.fn(() => profilesQuery),
        in: vi.fn().mockResolvedValue({ data: [{ id: "resident-a", email: "resident-a@example.com", role: "resident" }], error: null }),
        maybeSingle: vi.fn().mockResolvedValue({ data: { role: "manager" }, error: null }),
      };
      return {
        select: vi.fn().mockReturnValue(table === "portal_inbox_thread_records" ? threadQuery : profilesQuery),
        upsert: vi.fn().mockImplementation((row: { id?: string; row_data?: Record<string, unknown> }) => {
          if (table === "portal_inbox_thread_records") threadUpserts.push(row);
          return Promise.resolve({ error: null });
        }),
      };
    });
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue({ from } as never);

    const res = await sendInboxMessage(jsonRequest("http://localhost/api/portal/send-inbox-message", {
      method: "POST",
      body: {
        threadId: "manager-a-thread",
        subject: "A reply",
        text: "The selected A reply",
        toEmails: "resident-a@example.com",
        senderPortal: "manager",
        deliverToPortalInbox: true,
        deliverViaEmail: false,
      },
    }));

    expect(res.status).toBe(200);
    expect(threadUpserts).toHaveLength(2);
    expect(threadUpserts.map((row) => row.id)).toEqual(["manager-a-thread", "resident-a-thread"]);
    expect(threadUpserts[0]?.row_data).toMatchObject({
      propertyId: "property-a",
      counterpartyRole: "resident",
      smsConversationKey: "mgr_1:resident:resident-a",
      preview: "The selected A reply",
    });
    expect(threadUpserts[1]?.row_data).toMatchObject({
      managerUserId: "mgr_1",
      propertyId: "property-a",
      counterpartyRole: "manager",
      preview: "The selected A reply",
    });
    expect(threadUpserts[1]?.row_data).not.toHaveProperty("smsConversationKey");
    expect(threadUpserts.some((row) => row.id === newerB.id)).toBe(false);
    expect(newerB.row_data.messages).toEqual([{ id: "b1", body: "B must remain unchanged" }]);
  });

  it("preserves an unknown selected reply in the unknown-only counterpart partition", async () => {
    vi.spyOn(inboxRecipientScope, "filterRecipientsBySenderScope").mockImplementation(
      async (_db, _sender, recipients) => ({ allowed: recipients, blocked: [] }),
    );
    vi.mocked(createSupabaseServerClient).mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "mgr_1", email: "manager@example.com" } } }) },
    } as never);
    const fixture = makeSelectedReplyDb({
      rowData: {
        folder: "sent",
        email: "resident-a@example.com",
        messages: [{ id: "selected-root", body: "Selected unknown history" }],
      },
      recipientProfiles: [{ id: "resident-a", email: "resident-a@example.com", role: "resident" }],
      threadRows: [
        {
          id: "resident-b-thread",
          owner_user_id: "resident-a",
          participant_email: "resident-a@example.com",
          scope: RESIDENT_SCOPE,
          thread_type: "portal_message",
          row_data: {
            folder: "inbox",
            email: "manager@example.com",
            propertyId: "property-b",
            identityProvenance: [{ managerUserId: "mgr_1", propertyId: "property-b", counterpartyRole: "manager" }],
            messages: [{ id: "b1", body: "Known B must remain unchanged" }],
          },
        },
        {
          id: "resident-unknown-thread",
          owner_user_id: "resident-a",
          participant_email: "resident-a@example.com",
          scope: RESIDENT_SCOPE,
          thread_type: "portal_message",
          row_data: {
            folder: "inbox",
            email: "manager@example.com",
            messages: [{ id: "u1", body: "Older unknown history" }],
          },
        },
      ],
    });
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue({ from: fixture.from } as never);

    const res = await sendInboxMessage(jsonRequest("http://localhost/api/portal/send-inbox-message", {
      method: "POST",
      body: {
        threadId: "selected-thread",
        subject: "Reply",
        text: "Unknown reply stays in unknown history",
        toEmails: "resident-a@example.com",
        senderPortal: "manager",
        deliverToPortalInbox: true,
        deliverViaEmail: false,
      },
    }));

    expect(res.status).toBe(200);
    expect(fixture.upsert).toHaveBeenCalledTimes(2);
    const writes = fixture.upsert.mock.calls.map(([row]) => row as { id: string; row_data: { messages: Array<{ body: string }> } });
    expect(writes.map((row) => row.id)).toEqual(["selected-thread", "resident-unknown-thread"]);
    expect(writes[0]?.row_data.messages.at(-1)?.body).toBe("Unknown reply stays in unknown history");
    expect(writes[1]?.row_data.messages.at(-1)?.body).toBe("Unknown reply stays in unknown history");
    const knownB = fixture.rows.find((row) => row.id === "resident-b-thread");
    expect(knownB?.row_data).toEqual({
      folder: "inbox",
      email: "manager@example.com",
      propertyId: "property-b",
      identityProvenance: [{ managerUserId: "mgr_1", propertyId: "property-b", counterpartyRole: "manager" }],
      messages: [{ id: "b1", body: "Known B must remain unchanged" }],
    });
  });

  it("refuses a conflicted selected source before any write", async () => {
    vi.spyOn(inboxRecipientScope, "filterRecipientsBySenderScope").mockImplementation(
      async (_db, _sender, recipients) => ({ allowed: recipients, blocked: [] }),
    );
    vi.mocked(createSupabaseServerClient).mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "mgr_1", email: "manager@example.com" } } }) },
    } as never);
    const fixture = makeSelectedReplyDb({
      rowData: {
        email: "resident-a@example.com",
        identityProvenance: [
          { managerUserId: "mgr_1", propertyId: "property-a", counterpartyRole: "resident" },
          { managerUserId: "mgr_1", propertyId: "property-b", counterpartyRole: "resident" },
        ],
        messages: [{ id: "c1", body: "Conflicted history" }],
      },
      recipientProfiles: [{ id: "resident-a", email: "resident-a@example.com", role: "resident" }],
    });
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue({ from: fixture.from } as never);

    const res = await sendInboxMessage(jsonRequest("http://localhost/api/portal/send-inbox-message", {
      method: "POST",
      body: {
        threadId: "selected-thread",
        subject: "Reply",
        text: "Must fail closed",
        toEmails: "resident-a@example.com",
        senderPortal: "manager",
        deliverToPortalInbox: true,
        deliverViaEmail: false,
      },
    }));

    expect(res.status).toBe(409);
    expect(fixture.upsert).not.toHaveBeenCalled();
  });

  it("creates a separate unknown counterpart when no unknown history exists", async () => {
    vi.spyOn(inboxRecipientScope, "filterRecipientsBySenderScope").mockImplementation(
      async (_db, _sender, recipients) => ({ allowed: recipients, blocked: [] }),
    );
    vi.mocked(createSupabaseServerClient).mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "mgr_1", email: "manager@example.com" } } }) },
    } as never);
    const fixture = makeSelectedReplyDb({
      rowData: { folder: "sent", email: "resident-a@example.com", messages: [{ id: "selected-root", body: "Selected history" }] },
      recipientProfiles: [{ id: "resident-a", email: "resident-a@example.com", role: "resident" }],
      threadRows: [{
        id: "resident-b-thread",
        owner_user_id: "resident-a",
        participant_email: "resident-a@example.com",
        scope: RESIDENT_SCOPE,
        thread_type: "portal_message",
        row_data: {
          folder: "inbox",
          email: "manager@example.com",
          propertyId: "property-b",
          identityProvenance: [{ managerUserId: "mgr_1", propertyId: "property-b", counterpartyRole: "manager" }],
          messages: [{ id: "b1", body: "Known B remains untouched" }],
        },
      }],
    });
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue({ from: fixture.from } as never);

    const res = await sendInboxMessage(jsonRequest("http://localhost/api/portal/send-inbox-message", {
      method: "POST",
      body: {
        threadId: "selected-thread",
        subject: "Reply",
        text: "Create unknown-only counterpart",
        toEmails: "resident-a@example.com",
        senderPortal: "manager",
        deliverToPortalInbox: true,
        deliverViaEmail: false,
      },
    }));

    expect(res.status).toBe(200);
    expect(fixture.upsert).toHaveBeenCalledTimes(1);
    expect(fixture.insert).toHaveBeenCalledTimes(1);
    expect(fixture.insert.mock.calls[0]?.[0]).toMatchObject({
      scope: RESIDENT_SCOPE,
      owner_user_id: "resident-a",
      participant_email: "resident-a@example.com",
      row_data: expect.objectContaining({ body: "Create unknown-only counterpart" }),
    });
    expect(fixture.rows.find((row) => row.id === "resident-b-thread")?.row_data).toMatchObject({
      messages: [{ id: "b1", body: "Known B remains untouched" }],
    });
  });

  it.each([
    ["two explicit recipients", { toEmails: "resident-a@example.com,resident-b@example.com" }],
    ["a broadcast recipient", {
      toEmails: "resident-a@example.com",
      toBroadcast: ["resident"],
    }],
  ])("rejects a selected property-A reply with %s before any write", async (_label, recipients) => {
    vi.spyOn(inboxRecipientScope, "filterRecipientsBySenderScope").mockImplementation(
      async (_db, _sender, allowedRecipients) => ({ allowed: allowedRecipients, blocked: [] }),
    );
    vi.mocked(createSupabaseServerClient).mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "mgr_1", email: "manager@example.com" } } }) },
    } as never);
    const fixture = makeSelectedReplyDb({
      rowData: {
        email: "resident-a@example.com",
        identityProvenance: [{ managerUserId: "mgr_1", propertyId: "property-a", counterpartyRole: "resident" }],
        messages: [{ id: "a1", body: "A history" }],
      },
      recipientProfiles: [
        { id: "resident-a", email: "resident-a@example.com", role: "resident" },
        { id: "resident-b", email: "resident-b@example.com", role: "resident" },
      ],
      broadcastRows: [{ manager_user_id: "mgr_1", resident_email: "resident-b@example.com", row_data: { bucket: "approved" } }],
    });
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue({ from: fixture.from } as never);

    const res = await sendInboxMessage(jsonRequest("http://localhost/api/portal/send-inbox-message", {
      method: "POST",
      body: {
        threadId: "selected-thread",
        subject: "Reply",
        text: "A reply cannot broadcast",
        senderPortal: "manager",
        ...recipients,
        deliverToPortalInbox: true,
        deliverViaEmail: false,
      },
    }));

    expect(res.status).toBe(403);
    expect(fixture.upsert).not.toHaveBeenCalled();
  });
});
