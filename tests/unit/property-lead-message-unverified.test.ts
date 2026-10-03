import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";

/**
 * S2 (comms-safety-0929): the public listing contact form takes any email. When
 * that email belongs to an existing account and the sender is NOT signed in as
 * it, the message must never land in the account's own property conversation
 * (it used to appear in the resident's thread as if they sent it). It becomes a
 * separate "unverified lead" conversation for the manager instead.
 */

const MGR = "mgr-1";
const state = vi.hoisted(() => ({
  db: null as unknown,
  signedIn: null as { id: string; email: string } | null,
  notify: vi.fn(async () => undefined),
  residentCopy: vi.fn(async () => undefined),
  reconcile: vi.fn(async () => undefined),
}));

vi.mock("@/lib/rate-limit", () => ({ clientIpFrom: () => "ip", rateLimit: async () => ({ ok: true }) }));
vi.mock("@/lib/sms-consent", () => ({ recordOptIn: vi.fn(async () => undefined) }));
vi.mock("@/lib/property-lead-prospect-handoff.server", () => ({ notifyProspectPropertyMessageHandoff: vi.fn(async () => undefined) }));
vi.mock("@/lib/property-lead-notification.server", () => ({ notifyManagerPropertyLeadMessage: state.notify }));
vi.mock("@/lib/tour-notification-delivery.server", () => ({ recordResidentProspectInboxMessage: state.residentCopy }));
vi.mock("@/lib/tour-resident-link.server", () => ({ reconcileProspectInboxThreadsForResident: state.reconcile }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => state.db }));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: state.signedIn ? { id: state.signedIn.id, email: state.signedIn.email } : null } }) },
  }),
}));

import { POST } from "@/app/api/public/property-lead-message/route";
import { appendManagerPropertyLeadInboxMessage } from "@/lib/property-manager-inbox-thread.server";

function seed() {
  return createMemoryDb({
    manager_property_records: [{ id: "h1", manager_user_id: MGR, property_data: { title: "House One" }, row_data: {}, status: "live", test_workspace_id: null }],
    profiles: [
      { id: MGR, email: "mgr@example.test" },
      { id: "res-a", email: "resident-a@example.test" },
    ],
    portal_inbox_thread_records: [],
  });
}

const lead = (email: string) => ({ propertyId: "h1", name: "Stranger", email, topic: "Tour", body: "Send me your bank login" });
const call = (email: string) =>
  POST(new Request("https://example.test/api/public/property-lead-message", { method: "POST", body: JSON.stringify(lead(email)) }));

beforeEach(() => {
  vi.clearAllMocks();
  state.db = seed();
  state.signedIn = null;
});

describe("POST /api/public/property-lead-message - S2", () => {
  it("never writes into an existing account's thread when the sender is not signed in as it", async () => {
    const res = await call("resident-a@example.test");
    expect(res.status).toBe(200);
    expect(state.residentCopy).not.toHaveBeenCalled();
    expect(state.reconcile).not.toHaveBeenCalled();
    expect(state.notify).toHaveBeenCalledWith(expect.objectContaining({ email: "resident-a@example.test", unverified: true }));
  });

  it("treats a different signed-in account the same way", async () => {
    state.signedIn = { id: "someone", email: "someone@example.test" };
    await call("resident-a@example.test");
    expect(state.residentCopy).not.toHaveBeenCalled();
    expect(state.notify).toHaveBeenCalledWith(expect.objectContaining({ unverified: true }));
  });

  it("still records the resident's own message when they are signed in as that account", async () => {
    state.signedIn = { id: "res-a", email: "resident-a@example.test" };
    await call("resident-a@example.test");
    expect(state.residentCopy).toHaveBeenCalledTimes(1);
    expect(state.notify).toHaveBeenCalledWith(expect.objectContaining({ unverified: false }));
  });

  it("keeps the prospect flow for an email with no account", async () => {
    await call("new-person@example.test");
    expect(state.residentCopy).toHaveBeenCalledTimes(1);
    expect(state.notify).toHaveBeenCalledWith(expect.objectContaining({ unverified: false }));
  });
});

describe("appendManagerPropertyLeadInboxMessage - unverified lead", () => {
  const rows = () => (state.db as { __tables: Record<string, Record<string, unknown>[]> }).__tables.portal_inbox_thread_records;
  const base = { propertyId: "h1", propertyTitle: "House One", prospectName: "Stranger", prospectEmail: "resident-a@example.test", topic: "Tour", subject: "Leasing message", body: "hi" };

  it("keeps an unverified lead in its own conversation, apart from the account's property thread", async () => {
    const db = state.db as Parameters<typeof appendManagerPropertyLeadInboxMessage>[0];
    await appendManagerPropertyLeadInboxMessage(db, MGR, { ...base, body: "verified hello", counterpartyRole: "resident" });
    await appendManagerPropertyLeadInboxMessage(db, MGR, { ...base, body: "forged hello", unverified: true });
    await appendManagerPropertyLeadInboxMessage(db, MGR, { ...base, body: "forged again", unverified: true });
    expect(rows()).toHaveLength(2);
    const [real, lead] = rows();
    expect(JSON.stringify(real!.row_data)).not.toContain("forged");
    expect(String(lead!.id)).toMatch(/:unverified$/);
    expect(lead).toMatchObject({ owner_user_id: MGR, participant_email: null });
    expect((lead!.row_data as Record<string, unknown>).unverifiedLead).toBe(true);
    expect((lead!.row_data as { messages: unknown[] }).messages).toHaveLength(1);
    expect(String((lead!.row_data as { from: string }).from)).toMatch(/unverified/i);
  });
});
