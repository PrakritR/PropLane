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
 * Table-dispatching Supabase stub. Filters are applied before the result is
 * returned so these tests exercise the same exact binding/thread/message
 * narrowing as PostgREST. A canned table error fails closed like Supabase.
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
  smsOutbox?: unknown[];
  errors?: Partial<Record<string, { message: string }>>;
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
    sms_outbox: canned.smsOutbox ?? [],
  };
  const errors = canned.errors ?? {};
  const from = (table: string) => {
    const builder: Record<string, unknown> = {};
    const filters: ((row: Record<string, unknown>) => boolean)[] = [];
    let limit: number | null = null;
    let range: [number, number] | null = null;
    const self = () => builder;
    builder.select = self;
    builder.eq = (column: string, value: unknown) => {
      filters.push((row) => String(row[column] ?? "") === String(value));
      return builder;
    };
    builder.neq = (column: string, value: unknown) => {
      filters.push((row) => String(row[column] ?? "") !== String(value));
      return builder;
    };
    builder.in = (column: string, values: unknown[]) => {
      const allowed = new Set(values.map(String));
      filters.push((row) => allowed.has(String(row[column] ?? "")));
      return builder;
    };
    builder.order = self;
    builder.range = (from: number, to: number) => { range = [from, to]; return builder; };
    builder.not = (column: string, _operator: string, value: unknown) => {
      filters.push((row) => String(row[column] ?? "") !== String(value));
      return builder;
    };
    builder.limit = (value: number) => { limit = value; return builder; };
    const result = () => {
      const error = errors[table] ?? null;
      if (error) return { data: [], error };
      let rows = (tableData[table] ?? []).filter((row) => filters.every((filter) => filter(row as Record<string, unknown>)));
      if (range) rows = rows.slice(range[0], range[1] + 1);
      return { data: limit == null ? rows : rows.slice(0, limit), error: null };
    };
    builder.maybeSingle = async () => {
      if (table === "profiles" && canned.profileSingle) {
        const candidate = canned.profileSingle as Record<string, unknown>;
        if (filters.every((filter) => filter(candidate))) return { data: candidate, error: null };
      }
      const resolved = result();
      return { data: resolved.error ? null : (resolved.data[0] ?? null), error: resolved.error };
    };
    builder.then = (resolve: (v: { data: unknown[]; error: { message: string } | null }) => unknown) => resolve(result());
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

describe("resident SMS manager identity payload", () => {
  it("publishes only a verified owner/key/profile conversation while retaining the legacy flat feed", async () => {
    const { fetchResidentSmsConversation } = await import("@/lib/manager-sms-messages.server");
    const db = makeDb({
      profileSingle: { id: ALICE, email: "alice@example.com", phone: "+14155550123", phone_verified_at: "2026-09-01T00:00:00Z" },
      profilesByEmail: [{ id: M, email: "manager@example.com", full_name: "Morgan Manager" }],
      managerMessages: [{
        id: "manager-message", manager_user_id: M, resident_user_id: ALICE, resident_phone: "+14155550123",
        body: "Your application is complete.", from_phone: "+12053690702", to_phone: "+14155550123",
        message_sid: "SMmanager", source: "work_number", created_at: "2026-09-18T12:00:00Z", direction: "outbound",
        counterparty_role: "applicant", conversation_key: `${M}:applicant:${ALICE}`,
      }],
    });

    const payload = await fetchResidentSmsConversation(db, ALICE);
    expect(payload.messages.map((message) => message.id)).toContain("manager-message");
    expect(payload.conversations).toEqual([expect.objectContaining({
      conversationKey: `${M}:applicant:${ALICE}`,
      managerUserId: M,
      managerName: "Morgan Manager",
      managerEmail: "manager@example.com",
      counterpartyRole: "applicant",
      messages: [expect.objectContaining({ id: "manager-message" })],
    })]);
  });

  it("keeps exact-owned relay turns in the flat feed when the manager profile is missing", async () => {
    const { fetchResidentSmsConversation } = await import("@/lib/manager-sms-messages.server");
    const phone = "+14155550123";
    const db = makeDb({
      profileSingle: { id: ALICE, email: "alice@example.com", phone, phone_verified_at: "2026-09-01T00:00:00Z" },
      relayBindings: [{ thread_id: "alice-thread", participant_phone: phone, role: "resident", active: true }],
      relayThreads: [{ id: "alice-thread", manager_user_id: M, counterparty_user_id: ALICE }],
      relayMessages: [{ id: "alice-relay", thread_id: "alice-thread", sender_role: "manager", body: "ALICE PRIVATE", created_at: "2026-09-18T12:00:00Z", twilio_sid: "SMalice" }],
    });

    const payload = await fetchResidentSmsConversation(db, ALICE);
    expect(payload.messages.map((message) => message.body)).toEqual(["ALICE PRIVATE"]);
    expect(payload.conversations).toEqual([]);
  });

  it("keeps a shared verified phone's relay history bound to the exact resident in both payloads", async () => {
    const { fetchResidentSmsConversation } = await import("@/lib/manager-sms-messages.server");
    const phone = "+14155550123";
    const db = makeDb({
      profileSingle: { id: ALICE, email: "alice@example.com", phone, phone_verified_at: "2026-09-01T00:00:00Z" },
      profilesByEmail: [{ id: M, email: "manager@example.com", full_name: "Morgan Manager" }],
      relayBindings: [
        { thread_id: "alice-thread", participant_phone: phone, role: "resident", active: true },
        { thread_id: "bob-thread", participant_phone: phone, role: "resident", active: true },
      ],
      relayThreads: [
        { id: "alice-thread", manager_user_id: M, counterparty_user_id: ALICE },
        { id: "bob-thread", manager_user_id: M, counterparty_user_id: BOB },
      ],
      relayMessages: [
        { id: "alice-relay", thread_id: "alice-thread", sender_role: "manager", body: "ALICE PRIVATE", created_at: "2026-09-18T12:00:00Z", twilio_sid: "SMalice" },
        { id: "bob-relay", thread_id: "bob-thread", sender_role: "manager", body: "BOB PRIVATE", created_at: "2026-09-18T12:01:00Z", twilio_sid: "SMbob" },
      ],
    });

    const payload = await fetchResidentSmsConversation(db, ALICE);
    expect(payload.messages.map((message) => message.body)).toEqual(["ALICE PRIVATE"]);
    expect(payload.messages.some((message) => message.body === "BOB PRIVATE")).toBe(false);
    expect(payload.conversations.flatMap((conversation) => conversation.messages.map((message) => message.body))).toEqual(["ALICE PRIVATE"]);
  });

  it.each([
    ["null counterparty", { relayBindings: [{ thread_id: "legacy-thread", participant_phone: "+14155550123", role: "resident", active: true }], relayThreads: [{ id: "legacy-thread", manager_user_id: M, counterparty_user_id: null }] }],
    ["failed binding lookup", { errors: { sms_relay_bindings: { message: "binding lookup failed" } } }],
    ["failed thread lookup", { relayBindings: [{ thread_id: "missing-thread", participant_phone: "+14155550123", role: "resident", active: true }], errors: { sms_relay_threads: { message: "thread lookup failed" } } }],
    ["failed message lookup", { relayBindings: [{ thread_id: "alice-thread", participant_phone: "+14155550123", role: "resident", active: true }], relayThreads: [{ id: "alice-thread", manager_user_id: M, counterparty_user_id: ALICE }], errors: { sms_relay_messages: { message: "message lookup failed" } } }],
  ])("fails closed for %s relay identity or lookup failure", async (_label, scenario) => {
    const { fetchResidentSmsConversation } = await import("@/lib/manager-sms-messages.server");
    const db = makeDb({
      profileSingle: { id: ALICE, email: "alice@example.com", phone: "+14155550123", phone_verified_at: "2026-09-01T00:00:00Z" },
      profilesByEmail: [{ id: M, email: "manager@example.com", full_name: "Morgan Manager" }],
      ...scenario,
    });
    const payload = await fetchResidentSmsConversation(db, ALICE);
    expect(payload.messages).toEqual([]);
    expect(payload.conversations).toEqual([]);
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

  it("keeps ordinary and ambiguous histories when applicant enrichment is a no-op", async () => {
    const { fetchManagerSmsConversations } = await import("@/lib/manager-sms-messages.server");
    const phone = "+14155550131";
    const db = makeDb({
      managerMessages: [
        {
          id: "ordinary-resident-history",
          manager_user_id: M,
          resident_user_id: ALICE,
          resident_phone: phone,
          body: "Existing resident history",
          from_phone: phone,
          to_phone: "+12053690702",
          message_sid: "SMordinary",
          source: "work_number",
          created_at: "2026-09-17T10:00:00Z",
          direction: "inbound",
          counterparty_role: "resident",
          conversation_key: `${M}:resident:${ALICE}`,
        },
        {
          id: "ambiguous-prospect-history",
          manager_user_id: M,
          resident_user_id: null,
          resident_phone: phone,
          body: "Shared phone prospect history",
          from_phone: phone,
          to_phone: "+12053690702",
          message_sid: "SMambiguous",
          source: "work_number",
          created_at: "2026-09-17T11:00:00Z",
          direction: "inbound",
          counterparty_role: "prospect",
          conversation_key: `${M}:prospect:${phone}`,
        },
      ],
    });

    const payload = await fetchManagerSmsConversations(db, M, {
      scopeManagerIdsOverride: [M],
      visibility: "none",
    });

    expect(payload.residents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        conversationKey: `${M}:resident:${ALICE}`,
        messages: [expect.objectContaining({ id: "ordinary-resident-history" })],
      }),
      expect.objectContaining({
        conversationKey: `${M}:prospect:${phone}`,
        messages: [expect.objectContaining({ id: "ambiguous-prospect-history" })],
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

  it("upgrades one retained prospect history with the submitted applicant identity", async () => {
    const { fetchManagerSmsConversations } = await import("@/lib/manager-sms-messages.server");
    const phone = "+14155550142";
    const prospectKey = `${M}:prospect:${phone}`;
    const db = makeDb({
      managerApplications: [{
        manager_user_id: M,
        resident_email: "applicant@example.com",
        row_data: {
          bucket: "pending",
          stage: "Submitted",
          name: "Avery Applicant",
          phone,
          property: "Oak House",
        },
      }],
      managerMessages: [{
        id: "prospect-question",
        manager_user_id: M,
        resident_user_id: null,
        resident_phone: phone,
        body: "Can I tour Oak House?",
        from_phone: phone,
        to_phone: "+12053690702",
        message_sid: "SMprospect-question",
        source: "work_number",
        created_at: "2026-09-17T12:00:00Z",
        direction: "inbound",
        counterparty_role: "prospect",
        conversation_key: prospectKey,
      }],
      smsOutbox: [{
        manager_user_id: M,
        recipient_email: "applicant@example.com",
        recipient_phone: phone,
        conversation_key: prospectKey,
        counterparty_role: "prospect",
        provider_from_phone: "+12053690702",
        purpose: "application_submitted_notification",
      }],
    });

    const payload = await fetchManagerSmsConversations(db, M, {
      scopeManagerIdsOverride: [M],
      visibility: "none",
    });

    expect(payload.residents).toEqual([
      expect.objectContaining({
        conversationKey: prospectKey,
        counterpartyRole: "prospect",
        residentEmail: "applicant@example.com",
        name: "Avery Applicant",
        directoryName: "Avery Applicant",
        tenancyStatus: "applicant",
        propertyLabel: "Oak House",
        messages: [expect.objectContaining({ id: "prospect-question" })],
      }),
    ]);
  });

  it("keeps the exact prospect key and authoritative name through later application lifecycle turns", async () => {
    const { fetchManagerSmsConversations } = await import("@/lib/manager-sms-messages.server");
    const phone = "+14155550144";
    const prospectKey = `${M}:prospect:${phone}`;
    const application = {
      manager_user_id: M,
      resident_email: "avery@example.com",
      row_data: { bucket: "pending", stage: "Submitted", name: "Avery Applicant", phone, property: "Oak House" },
    };
    const messages = [{
      id: "initial-inquiry", manager_user_id: M, resident_user_id: null, resident_phone: phone,
      body: "I would like to apply.", from_phone: phone, to_phone: "+12053690702",
      message_sid: "SMinitial", source: "work_number", created_at: "2026-09-17T12:00:00Z", direction: "inbound",
      counterparty_role: "prospect", conversation_key: prospectKey,
    }];
    const db = makeDb({
      managerApplications: [application],
      managerMessages: messages,
      smsOutbox: [{
        manager_user_id: M,
        recipient_email: "avery@example.com",
        recipient_phone: phone,
        conversation_key: prospectKey,
        counterparty_role: "prospect",
        provider_from_phone: "+12053690702",
        purpose: "application_submitted_notification",
      }],
    });

    const submitted = await fetchManagerSmsConversations(db, M, { scopeManagerIdsOverride: [M], visibility: "none" });
    expect(submitted.residents).toEqual([
      expect.objectContaining({ conversationKey: prospectKey, name: "Avery Applicant", residentEmail: "avery@example.com" }),
    ]);

    application.row_data = { ...application.row_data, bucket: "pending", stage: "Needs information" };
    const needsInfo = await fetchManagerSmsConversations(db, M, { scopeManagerIdsOverride: [M], visibility: "none" });
    expect(needsInfo.residents).toEqual([
      expect.objectContaining({ conversationKey: prospectKey, name: "Avery Applicant", residentEmail: "avery@example.com", tenancyStatus: "applicant" }),
    ]);

    application.row_data = { ...application.row_data, bucket: "rejected", stage: "Rejected" };
    const rejected = await fetchManagerSmsConversations(db, M, { scopeManagerIdsOverride: [M], visibility: "none" });
    expect(rejected.residents).toEqual([
      expect.objectContaining({ conversationKey: prospectKey, name: "Avery Applicant", residentEmail: "avery@example.com", tenancyStatus: "applicant" }),
    ]);

    messages.push({
      id: "approved-turn", manager_user_id: M, resident_user_id: null, resident_phone: phone,
      body: "Your application was approved.", from_phone: "+12053690702", to_phone: phone,
      message_sid: "SMapproved", source: "automated", created_at: "2026-09-18T12:00:00Z", direction: "outbound",
      counterparty_role: "prospect", conversation_key: prospectKey,
    });
    application.row_data = { ...application.row_data, bucket: "approved", stage: "Approved" };

    const approved = await fetchManagerSmsConversations(db, M, { scopeManagerIdsOverride: [M], visibility: "none" });
    expect(approved.residents).toEqual([
      expect.objectContaining({
        conversationKey: prospectKey,
        name: "Avery Applicant",
        residentEmail: "avery@example.com",
        tenancyStatus: "resident",
        messages: [
          expect.objectContaining({ id: "initial-inquiry" }),
          expect.objectContaining({ id: "approved-turn" }),
        ],
      }),
    ]);
  });

  it("does not attach a shared prospect phone to either of two submitted applicants", async () => {
    const { fetchManagerSmsConversations } = await import("@/lib/manager-sms-messages.server");
    const phone = "+14155550143";
    const db = makeDb({
      managerApplications: [
        { manager_user_id: M, resident_email: "one@example.com", row_data: { bucket: "pending", stage: "Submitted", name: "Person One", phone } },
        { manager_user_id: M, resident_email: "two@example.com", row_data: { bucket: "pending", stage: "Submitted", name: "Person Two", phone } },
      ],
      managerMessages: [{
        id: "shared-prospect", manager_user_id: M, resident_user_id: null, resident_phone: phone,
        body: "Shared phone inquiry", from_phone: phone, to_phone: "+12053690702",
        message_sid: "SMshared", source: "work_number", created_at: "2026-09-17T12:00:00Z", direction: "inbound",
        counterparty_role: "prospect", conversation_key: `${M}:prospect:${phone}`,
      }],
    });

    const payload = await fetchManagerSmsConversations(db, M, {
      scopeManagerIdsOverride: [M],
      visibility: "none",
    });
    const prospect = payload.residents.find((row) => row.counterpartyRole === "prospect");
    expect(prospect).toMatchObject({
      conversationKey: `${M}:prospect:${phone}`,
      residentEmail: null,
      directoryName: null,
    });
    expect(payload.residents.filter((row) => row.residentEmail?.endsWith("@example.com"))).toHaveLength(2);
  });

  it("resolves lifecycle delivery only for the exact owner, work number, and eligible role", async () => {
    const { resolveExistingApplicantConversation } = await import("@/lib/application-lifecycle-sms.server");
    const phone = "+14155550143";
    const prospect = {
      conversationKey: `${M}:prospect:${phone}`,
      ownerManagerUserId: M,
      counterpartyRole: "prospect" as const,
      phone,
      messages: [{
        id: "prospect-turn",
        body: "hello",
        direction: "inbound",
        fromPhone: phone,
        toPhone: "+12053690702",
      }],
    };
    const approvedResident = {
      conversationKey: `${M}:resident:${phone}`,
      ownerManagerUserId: M,
      counterpartyRole: "resident" as const,
      phone,
      messages: [{
        id: "resident-turn",
        body: "already lives here",
        direction: "inbound",
        fromPhone: phone,
        toPhone: "+12053690702",
      }],
    };

    expect(resolveExistingApplicantConversation([prospect, approvedResident] as never, {
      managerUserId: M,
      applicantPhone: phone,
      workNumber: "+12053690702",
    })).toMatchObject({ kind: "matched", conversation: { conversationKey: prospect.conversationKey } });
    expect(resolveExistingApplicantConversation([prospect] as never, {
      managerUserId: M,
      applicantPhone: phone,
      workNumber: "+19995550111",
    }).kind).toBe("missing");
    expect(resolveExistingApplicantConversation([prospect] as never, {
      managerUserId: "other-manager",
      applicantPhone: phone,
      workNumber: "+12053690702",
    }).kind).toBe("missing");
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

    // A cohort read on the owners' behalf (admin oversight), not a viewer's
    // list: the per-house visibility rule is off, the batching is what is pinned.
    const payload = await fetchManagerSmsConversations(db, M, { scopeManagerIdsOverride: [M, M2], visibility: "none" });
    const alice = payload.residents.find((r) => r.residentUserId === ALICE);
    const bob = payload.residents.find((r) => r.residentUserId === BOB);
    expect(alice?.ownerManagerUserId).toBe(M);
    expect(bob?.ownerManagerUserId).toBe(M2);
    // One page fetched for the whole cohort — NOT one scan per manager.
    expect(appScans).toBe(1);
  });
});
