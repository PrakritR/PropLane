import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const service = vi.hoisted(() => vi.fn());
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: service }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: vi.fn() }));
vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: vi.fn() }));
// Keep the sender, classification, effect capture and request-local context real.
import { sendPortalConversationEmails } from "@/lib/portal-email-send.server";
import { captureSmsTestDelivery } from "@/lib/sms/sms-test-transport.server";

const ACTOR = "11111111-1111-4111-8111-111111111111";
const WORKSPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const recipients = ["vendor@example.test", "second@example.test"];
const membership = () => ({ workspace_id: WORKSPACE, portal_role: "manager", state: "active", expires_at: null, workspace: { status: "active" } });
const send = (toEmails = recipients, extra: Partial<Parameters<typeof sendPortalConversationEmails>[0]> = {}) =>
  sendPortalConversationEmails({ senderUserId: ACTOR, toEmails, subject: "Service reply", text: "Which pipe?", html: "<p>Which pipe?</p>", ...extra });

function storage(row: unknown = membership(), options: { lookupError?: boolean; lookupThrow?: boolean; auditError?: boolean; auditThrow?: boolean; afterLookup?: () => void } = {}) {
  const inserts: Record<string, unknown>[] = [];
  const eq = vi.fn(() => query);
  const query = {
    select: vi.fn(() => query), eq,
    maybeSingle: vi.fn(async () => {
      if (options.lookupThrow) throw new Error("Lookup unavailable");
      options.afterLookup?.();
      return { data: row, error: options.lookupError ? { message: "Lookup unavailable" } : null };
    }),
  };
  const insert = vi.fn(async (value: Record<string, unknown>) => {
    if (options.auditThrow) throw new Error("Audit unavailable");
    if (options.auditError) return { error: { message: "Audit unavailable" } };
    inserts.push(value);
    return { error: null };
  });
  const from = vi.fn((table: string) => {
    if (table === "test_workspace_members") return query;
    if (table === "audit_log") return { insert };
    throw new Error(`Unexpected table ${table}`);
  });
  service.mockReturnValue({ from });
  return { inserts, eq, insert, from };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("RESEND_API_KEY", "re_fake");
  vi.stubEnv("PROPLANE_TEST_WORKSPACES_ENABLED", "false");
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: "provider-id" })));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("portal conversation durable test-workspace boundary", () => {
  it.each([1, 2])("retains ordinary-request audit before reporting %i captured recipients without credentials", async (count) => {
    const db = storage();
    vi.stubEnv("RESEND_API_KEY", "");
    expect(captureSmsTestDelivery({ kind: "email", summary: "No request context", status: "captured" })).toBe(false);
    const result = await send(recipients.slice(0, count), { fromAddress: "Other identity <other@example.test>" });
    expect([...result.values()]).toEqual(Array.from({ length: count }, () => ({ sent: true, resendId: "test_workspace_captured" })));
    expect(db.eq).toHaveBeenCalledWith("user_id", ACTOR);
    expect(db.inserts).toEqual([{
      landlord_id: ACTOR, actor_user_id: ACTOR, action: "test_workspace_effect_captured",
      tool_name: "test_workspace_effect_boundary", input_summary: { kind: "email" },
      result_summary: { outcome: "captured", summary: "Service reply" }, test_workspace_id: WORKSPACE,
    }]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { ...membership(), state: "suspended" },
    { ...membership(), expires_at: "2000-01-01T00:00:00Z" },
    { ...membership(), workspace: { status: "suspended" } },
  ])("captures disabled or expired classified identities", async (row) => {
    const db = storage(row);
    expect([...(await send()).values()].every(value => value.resendId === "test_workspace_captured")).toBe(true);
    expect(db.inserts).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["lookupError", "lookupThrow", "auditError", "auditThrow", "invalid", "construction"])("fails closed and unsent on %s", async (failure) => {
    const db = storage(failure === "invalid" ? { ...membership(), portal_role: "vendor" } : membership(), { [failure]: true });
    if (failure === "construction") service.mockImplementationOnce(() => { throw new Error("Client unavailable"); });
    expect([...(await send()).values()]).toEqual(recipients.map(() => ({ sent: false, resendId: null })));
    expect(db.inserts).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does no classification or delivery for an empty send", async () => {
    expect((await send([])).size).toBe(0);
    expect(service).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["false", "throw", "multiple"])("refuses %s authorization before capture", async (mode) => {
    const db = storage();
    const authorizeDelivery = vi.fn(async () => { if (mode === "throw") throw new Error("Denied"); return false; });
    const result = await send(mode === "multiple" ? recipients : recipients.slice(0, 1), { authorizeDelivery });
    expect([...result.values()].every(value => !value.sent && value.resendId === null)).toBe(true);
    expect(db.inserts).toEqual([]);
    expect(service).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rechecks final authorization after normal classification before provider handoff", async () => {
    let permitted = true;
    const db = storage(null, { afterLookup: () => { permitted = false; } });
    const authorizeDelivery = vi.fn(async () => permitted);
    const result = await send(recipients.slice(0, 1), { authorizeDelivery });
    expect(authorizeDelivery).toHaveBeenCalledTimes(2);
    expect(result.get(recipients[0]!)).toEqual({ sent: false, resendId: null });
    expect(db.inserts).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("normal classification without a provider key stays unsent", async () => {
    const db = storage(null);
    vi.stubEnv("RESEND_API_KEY", "");
    expect([...(await send()).values()].every(value => !value.sent)).toBe(true);
    expect(db.inserts).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
});
