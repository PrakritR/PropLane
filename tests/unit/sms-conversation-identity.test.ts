import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildConversationKey,
  conversationPhoneRef,
  deriveCounterpartyRole,
} from "@/lib/sms-conversation-identity";

// resolveManagerWorkNumber hits twilio-provisioning; stub it out.
vi.mock("@/lib/twilio-provisioning", () => ({
  resolveManagerWorkNumber: vi.fn(async () => "+12053690702"),
}));

/**
 * Table-dispatching Supabase stub. Every chain method returns `this`; the
 * builder is awaitable (resolves the canned array for its table) and also
 * supports `.maybeSingle()` (resolves a single row). Filters are ignored — the
 * grouping under test does its own in-app scoping, which is exactly what we are
 * verifying.
 */
function makeDb(canned: {
  managerApplications?: unknown[];
  profilesByEmail?: unknown[];
  profileSingle?: unknown;
  inbound?: unknown[];
  managerMessages?: unknown[];
  relayThreads?: unknown[];
  relayMessages?: unknown[];
  relayBindings?: unknown[];
  smsContacts?: unknown[];
}) {
  const tableData: Record<string, unknown[]> = {
    manager_application_records: canned.managerApplications ?? [],
    profiles: canned.profilesByEmail ?? [],
    inbound_sms_log: canned.inbound ?? [],
    manager_sms_messages: canned.managerMessages ?? [],
    sms_relay_threads: canned.relayThreads ?? [],
    sms_relay_messages: canned.relayMessages ?? [],
    sms_relay_bindings: canned.relayBindings ?? [],
    manager_sms_contacts: canned.smsContacts ?? [],
  };
  const from = (table: string) => {
    const builder: Record<string, unknown> = {};
    const self = () => builder;
    for (const m of ["select", "eq", "in", "order", "limit", "range"]) builder[m] = self;
    builder.maybeSingle = async () => ({ data: canned.profileSingle ?? null, error: null });
    builder.then = (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
      resolve({ data: tableData[table] ?? [], error: null });
    return builder;
  };
  return { from } as never;
}

const M = "mgr-1111-1111-1111-111111111111";
const ALICE = "alice-1111-1111-1111-111111111111";
const BOB = "bob-1111-1111-1111-1111-11111111111";

describe("conversation identity helpers", () => {
  it("normalizes phones consistently for a stable person ref", () => {
    expect(conversationPhoneRef("(415) 555-1212")).toBe("+14155551212");
    expect(conversationPhoneRef("4155551212")).toBe("+14155551212");
    expect(conversationPhoneRef("+1 415 555 1212")).toBe("+14155551212");
  });

  it("keys by owner + role + person, preferring the account id over the phone", () => {
    expect(
      buildConversationKey({ ownerManagerUserId: M, role: "resident", counterpartyUserId: ALICE }),
    ).toBe(`${M}:resident:${ALICE}`);
    expect(
      buildConversationKey({ ownerManagerUserId: M, role: "prospect", counterpartyPhone: "4155551212" }),
    ).toBe(`${M}:prospect:+14155551212`);
  });

  it("splits the same phone across roles but never across people", () => {
    const prospect = buildConversationKey({ ownerManagerUserId: M, role: "prospect", counterpartyPhone: "4155551212" });
    const resident = buildConversationKey({ ownerManagerUserId: M, role: "resident", counterpartyPhone: "4155551212" });
    expect(prospect).not.toBe(resident); // same person, two roles → two threads
    const aliceKey = buildConversationKey({ ownerManagerUserId: M, role: "resident", counterpartyUserId: ALICE });
    const bobKey = buildConversationKey({ ownerManagerUserId: M, role: "resident", counterpartyUserId: BOB });
    expect(aliceKey).not.toBe(bobKey); // two people → two threads (tenant isolation)
  });

  it("derives roles conservatively", () => {
    expect(deriveCounterpartyRole({ threadTopic: "leasing" })).toBe("prospect");
    expect(deriveCounterpartyRole({ tenancyStatus: "applicant" })).toBe("applicant");
    expect(deriveCounterpartyRole({ hasResidentUserId: true })).toBe("resident");
    expect(deriveCounterpartyRole({})).toBe("unknown");
  });
});

describe("fetchManagerSmsConversations — per-counterparty threading & tenant isolation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns a saved phone contact before any message exists", async () => {
    const { fetchManagerSmsConversations } = await import("@/lib/manager-sms-messages.server");
    const phone = "+14155550123";
    const db = makeDb({
      smsContacts: [
        {
          manager_user_id: M,
          phone_e164: phone,
          counterparty_role: "unknown",
          display_name: "Jordan Lee",
          last_inbound_at: null,
        },
      ],
    });

    const payload = await fetchManagerSmsConversations(db, M, { scopeManagerIdsOverride: [M] });

    expect(payload.residents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        conversationKey: `${M}:unknown:${phone}`,
        ownerManagerUserId: M,
        phone,
        savedContactName: "Jordan Lee",
        counterpartyRole: "unknown",
        messages: [],
      }),
    ]));
  });

  it("decorates an unknown texter with the manager's private saved label", async () => {
    const { fetchManagerSmsConversations } = await import("@/lib/manager-sms-messages.server");
    const phone = "+14155550199";
    const db = makeDb({
      managerMessages: [
        {
          id: "m-prospect",
          manager_user_id: M,
          resident_user_id: null,
          resident_phone: phone,
          body: "Is unit 4 still available?",
          from_phone: phone,
          to_phone: "+12053690702",
          message_sid: "SMprospect",
          source: "work_number",
          created_at: "2026-08-26T12:00:00Z",
          direction: "inbound",
          counterparty_role: "prospect",
          conversation_key: `${M}:prospect:${phone}`,
        },
      ],
      smsContacts: [
        {
          manager_user_id: M,
          phone_e164: phone,
          counterparty_role: "prospect",
          display_name: "Jordan · Unit 4 inquiry",
          last_inbound_at: "2026-08-26T12:00:00Z",
        },
      ],
    });

    const payload = await fetchManagerSmsConversations(db, M, { scopeManagerIdsOverride: [M] });
    const prospect = payload.residents.find((row) => row.counterpartyRole === "prospect");
    expect(prospect?.savedContactName).toBe("Jordan · Unit 4 inquiry");
  });

  it("keeps two residents on ONE shared line in two separate threads", async () => {
    const { fetchManagerSmsConversations } = await import("@/lib/manager-sms-messages.server");
    const db = makeDb({
      managerApplications: [
        { manager_user_id: M, resident_email: "alice@example.com", row_data: { bucket: "approved", name: "Alice", phone: "+14150000001" } },
        { manager_user_id: M, resident_email: "bob@example.com", row_data: { bucket: "approved", name: "Bob", phone: "+14150000002" } },
      ],
      profilesByEmail: [
        { id: ALICE, email: "alice@example.com", phone: "+14150000001", full_name: "Alice A" },
        { id: BOB, email: "bob@example.com", phone: "+14150000002", full_name: "Bob B" },
      ],
      managerMessages: [
        {
          id: "m-alice", manager_user_id: M, resident_user_id: ALICE, resident_phone: "+14150000001",
          body: "SECRET-ALICE", from_phone: null, to_phone: "+12053690702", message_sid: "SMa",
          source: "automated", created_at: "2026-07-20T10:00:00Z", direction: "inbound",
          counterparty_role: "resident", conversation_key: `${M}:resident:${ALICE}`,
        },
        {
          id: "m-bob", manager_user_id: M, resident_user_id: BOB, resident_phone: "+14150000002",
          body: "SECRET-BOB", from_phone: null, to_phone: "+12053690702", message_sid: "SMb",
          source: "automated", created_at: "2026-07-20T11:00:00Z", direction: "inbound",
          counterparty_role: "resident", conversation_key: `${M}:resident:${BOB}`,
        },
      ],
    });

    const payload = await fetchManagerSmsConversations(db, M, { scopeManagerIdsOverride: [M] });
    const alice = payload.residents.find((r) => r.residentUserId === ALICE);
    const bob = payload.residents.find((r) => r.residentUserId === BOB);

    expect(alice).toBeTruthy();
    expect(bob).toBeTruthy();
    expect(alice!.conversationKey).not.toBe(bob!.conversationKey);
    // Tenant isolation: Alice's thread carries only Alice's text, never Bob's.
    expect(alice!.messages.map((m) => m.body)).toEqual(["SECRET-ALICE"]);
    expect(alice!.messages.some((m) => m.body === "SECRET-BOB")).toBe(false);
    expect(bob!.messages.map((m) => m.body)).toEqual(["SECRET-BOB"]);
  });

  it("splits a leasing prospect and a resident who share the SAME phone into two threads", async () => {
    const { fetchManagerSmsConversations } = await import("@/lib/manager-sms-messages.server");
    const sharedPhone = "+14159999999";
    const db = makeDb({
      managerApplications: [
        { manager_user_id: M, resident_email: "carol@example.com", row_data: { bucket: "approved", name: "Carol", phone: sharedPhone } },
      ],
      profilesByEmail: [{ id: ALICE, email: "carol@example.com", phone: sharedPhone, full_name: "Carol C" }],
      managerMessages: [
        {
          id: "m-res", manager_user_id: M, resident_user_id: ALICE, resident_phone: sharedPhone,
          body: "resident-text", from_phone: null, to_phone: "+12053690702", message_sid: "SMr",
          source: "automated", created_at: "2026-07-20T12:00:00Z", direction: "inbound",
          counterparty_role: "resident", conversation_key: `${M}:resident:${ALICE}`,
        },
        {
          id: "m-pro", manager_user_id: M, resident_user_id: null, resident_phone: sharedPhone,
          body: "prospect-text", from_phone: null, to_phone: "+12053690702", message_sid: "SMp",
          source: "automated", created_at: "2026-07-20T09:00:00Z", direction: "inbound",
          counterparty_role: "prospect", conversation_key: `${M}:prospect:${sharedPhone}`,
        },
      ],
    });

    const payload = await fetchManagerSmsConversations(db, M, { scopeManagerIdsOverride: [M] });
    const resident = payload.residents.find((r) => r.counterpartyRole === "resident");
    const prospect = payload.residents.find((r) => r.counterpartyRole === "prospect");
    expect(resident?.messages.map((m) => m.body)).toEqual(["resident-text"]);
    expect(prospect?.messages.map((m) => m.body)).toEqual(["prospect-text"]);
    // The resident thread must NOT absorb the prospect-era text and vice versa.
    expect(resident?.messages.some((m) => m.body === "prospect-text")).toBe(false);
  });

  /**
   * Admin oversight threads across the whole shared-line cohort, so the resident
   * scan is batched with `.in("manager_user_id", …)` rather than one call per
   * manager. Two things must hold: each seed stays attributed to the manager who
   * actually owns it (a cross-owner mix-up here would put one manager's resident
   * in another's list), and the round-trip count must not grow with the cohort.
   */
  it("attributes residents to their own manager and scans the cohort in one batched query", async () => {
    const { fetchManagerSmsConversations } = await import("@/lib/manager-sms-messages.server");
    const M2 = "mgr-2222-2222-2222-222222222222";
    let appScans = 0;
    const appRows = [
      { manager_user_id: M, resident_email: "alice@example.com", row_data: { bucket: "approved", name: "Alice" } },
      { manager_user_id: M2, resident_email: "bob@example.com", row_data: { bucket: "approved", name: "Bob" } },
    ];
    const db = {
      from: (table: string) => {
        if (table === "manager_application_records") appScans += 1;
        const builder: Record<string, unknown> = {};
        const self = () => builder;
        for (const m of ["select", "eq", "in", "order", "limit", "range"]) builder[m] = self;
        builder.maybeSingle = async () => ({ data: null, error: null });
        builder.then = (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
          resolve({
            data:
              table === "manager_application_records"
                ? appRows
                : table === "profiles"
                  ? [
                      { id: ALICE, email: "alice@example.com", phone: "+14150000001", full_name: "Alice A" },
                      { id: BOB, email: "bob@example.com", phone: "+14150000002", full_name: "Bob B" },
                    ]
                  : [],
            error: null,
          });
        return builder;
      },
    } as never;

    const payload = await fetchManagerSmsConversations(db, M, { scopeManagerIdsOverride: [M, M2] });
    const alice = payload.residents.find((r) => r.residentUserId === ALICE);
    const bob = payload.residents.find((r) => r.residentUserId === BOB);
    expect(alice?.ownerManagerUserId).toBe(M);
    expect(bob?.ownerManagerUserId).toBe(M2);
    // One page fetched for the whole cohort — NOT one scan per manager.
    expect(appScans).toBe(1);
  });
});
