/**
 * POST /api/portal/send-inbox-message, typed new-contact addresses: the account lookup is case-insensitive and fails
 * closed, only a POSITIVE "no account" read lets an address through as a new contact, and new contacts are capped
 * per send and per workspace per day.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  profileResult: { data: [] as Record<string, unknown>[], error: null as null | { message: string } },
  emailLookups: [] as Array<{ column: string; values: readonly string[] }>,
  scopeOptions: [] as Record<string, unknown>[],
  rateLimitCalls: [] as Array<{ key: string; cost: number }>,
  rateLimitResult: { ok: true } as { ok: boolean; unavailable?: true },
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "mgr-1", email: "mgr@example.com" } } }) },
  }),
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from(table: string) {
      let isOr = false;
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "ilike", "order", "limit", "neq", "is", "gte", "lte"]) chain[m] = () => chain;
      chain.in = (column: string, values: readonly string[]) => {
        if (table === "profiles") {
          if (column === "email_lower") h.emailLookups.push({ column, values });
          isOr = true;
        }
        return chain;
      };
      chain.or = () => {
        if (table === "profiles") isOr = true;
        return chain;
      };
      for (const m of ["insert", "upsert", "update", "delete"]) chain[m] = () => chain;
      const rows = () => {
        if (table === "profiles") return isOr ? h.profileResult.data : { role: "manager", full_name: "Mgr", email: "mgr@example.com" };
        return isOr ? [] : null;
      };
      const error = () => (table === "profiles" && isOr ? h.profileResult.error : null);
      chain.maybeSingle = async () => ({ data: rows(), error: null });
      chain.single = async () => ({ data: rows(), error: null });
      chain.then = (resolve: (v: unknown) => unknown) => resolve({ data: rows(), error: error() });
      return chain;
    },
    rpc: async () => ({ data: null, error: null }),
  }),
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: async (key: string, _limit: number, _windowMs: number, cost = 1) => {
    // The route's own per-sender limiters are not under test.
    if (!key.startsWith("typed-contacts:")) return { ok: true };
    h.rateLimitCalls.push({ key, cost });
    return h.rateLimitResult;
  },
  clientIpFrom: () => "127.0.0.1",
}));
vi.mock("@/lib/test-workspaces/index.server", () => ({
  resolveAuthenticatedBusinessAccess: async () => ({ kind: "live" }),
}));
vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: async () => false }));
vi.mock("@/lib/inbox-portal-sender", () => ({ resolveInboxSenderRoleForPortal: async () => "manager" }));
vi.mock("@/lib/communication/conversation-visibility.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/communication/conversation-visibility.server")>()),
  resolveCommunicationScope: async () => ({
    viewerId: "mgr-1",
    level: "edit",
    ownerIds: ["mgr-1"],
    grantedHousesByOwner: new Map(),
    workspaceHouseIds: null,
    untaggedOwnedVisible: true,
    activeWorkspaceId: "ws-1",
    workspaceByLine: new Map(),
  }),
}));
vi.mock("@/lib/inbox-recipient-scope", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/inbox-recipient-scope")>()),
  managerMayMessageNewContacts: async () => true,
  // Mirrors the real rule: only an address in the route's confirmed set passes as a typed new contact.
  filterRecipientsBySenderScope: async (
    _db: unknown,
    _sender: unknown,
    recipients: { email: string; userId: string | null }[],
    options: { confirmedAccountlessEmails?: ReadonlySet<string> },
  ) => {
    h.scopeOptions.push(options as Record<string, unknown>);
    const allowed = recipients.filter((r) => !r.userId && options.confirmedAccountlessEmails?.has(r.email) === true);
    return {
      allowed,
      blocked: recipients.filter((r) => !allowed.includes(r)),
      typedNewContacts: allowed.map((r) => r.email),
    };
  },
}));
vi.mock("@/lib/property-owner/access.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/property-owner/access.server")>()),
  applyOwnerMessageInboxScope: async (_db: unknown, _who: unknown, recipients: unknown[]) => recipients,
}));
vi.mock("@/lib/manager-communication-access.server", () => ({
  assertManagerCommunicationAllowedForWorkspace: async () => ({
    allowed: false,
    reason: "trial",
    status: 402,
    message: "stop here",
  }),
}));

import { POST } from "@/app/api/portal/send-inbox-message/route";

const post = (toEmails: string[]) =>
  POST(
    new Request("http://localhost/api/portal/send-inbox-message", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subject: "Hi", text: "Hello there", toEmails, senderPortal: "manager" }),
    }),
  );

beforeEach(() => {
  h.profileResult = { data: [], error: null };
  h.emailLookups.length = 0;
  h.scopeOptions.length = 0;
  h.rateLimitCalls.length = 0;
  h.rateLimitResult = { ok: true };
});

describe("send-inbox-message typed new contacts", () => {
  it("a failed account lookup is a 503, never 'no account'", async () => {
    h.profileResult = { data: [], error: { message: "boom" } };
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await post(["new@example.com"]);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, error: "Could not check recipients. Try again." });
    expect(h.scopeOptions).toEqual([]);
  });

  it("matches accounts case-insensitively on the indexed lowercase column, wildcards and all", async () => {
    await post(["A_b%C@Example.com"]);
    expect(h.emailLookups).toEqual([{ column: "email_lower", values: ["a_b%c@example.com"] }]);
  });

  it("an address whose account is stored in a different case is NOT confirmed account-less", async () => {
    h.profileResult = { data: [{ id: "u-1", email: "Real.Person@Example.com", role: "resident" }], error: null };
    await post(["real.person@example.com", "brand.new@example.com"]);
    const confirmed = h.scopeOptions[0]!.confirmedAccountlessEmails as Set<string>;
    expect(confirmed.has("real.person@example.com")).toBe(false);
    expect(confirmed.has("brand.new@example.com")).toBe(true);
  });

  it("more than 5 typed new contacts in one send is a 400 and consumes no daily budget", async () => {
    const res = await post(Array.from({ length: 6 }, (_, i) => `new${i}@example.com`));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "You can add up to 5 new addresses per message." });
    expect(h.rateLimitCalls).toEqual([]);
  });

  it("counts only addresses that passed as new contacts, once each, in ONE all-or-nothing reservation", async () => {
    h.profileResult = { data: [{ id: "u-1", email: "known@example.com", role: "resident" }], error: null };
    await post(["known@example.com", "new1@example.com", "new2@example.com"]);
    // One call carrying the whole cost: separate calls let a refused send keep the tokens it was granted.
    expect(h.rateLimitCalls).toEqual([{ key: "typed-contacts:ws-1", cost: 2 }]);
  });

  it("a refused budget spends nothing, so the next single-address send is still served", async () => {
    h.rateLimitResult = { ok: false };
    const refused = await post(["new1@example.com", "new2@example.com", "new3@example.com"]);
    expect(refused.status).toBe(429);
    expect(h.rateLimitCalls).toEqual([{ key: "typed-contacts:ws-1", cost: 3 }]);
  });

  it("an exhausted daily budget is a 429, and an unavailable limiter fails closed with 503", async () => {
    h.rateLimitResult = { ok: false };
    const limited = await post(["new1@example.com"]);
    expect(limited.status).toBe(429);
    h.rateLimitResult = { ok: false, unavailable: true };
    const unavailable = await post(["new1@example.com"]);
    expect(unavailable.status).toBe(503);
  });
});
