import { describe, expect, it } from "vitest";
import {
  PROJECTED_SMS_TURN_PREFIX,
  RESIDENT_SMS_ROW_PREFIX,
  decideResidentSmsLink,
  mergeResidentSmsConversations,
  smsOnlyResidentRow,
  stampCounterparties,
  type ResidentCounterparty,
  type ResidentSmsConversation,
} from "@/lib/communication/resident-conversation";
import {
  applyResidentConversationExtras,
  linkVerifiedPhoneHistory,
  loadResidentSmsConversations,
} from "@/lib/communication/resident-conversations.server";
import { buildClientPortalInboxThreadUpsert } from "@/lib/portal-inbox-thread-upsert";
import { mergeInboxThreadRowData } from "@/lib/communication/shared-thread-merge";
import { isServerReservedInboxThreadId } from "@/lib/portal-inbox-thread-upsert";
import { mirrorAssistantEmailConversation } from "@/lib/manager-assistant-email/mirror-assistant-email-conversation.server";
import { inboxThreadMessages, type PersistedInboxThread } from "@/lib/portal-inbox-storage";
import { createConversationFakeDb, type FakeDb } from "../helpers/conversation-fake-db";

/**
 * C1-R4: a resident's Communication includes the texts between their VERIFIED
 * phone and any manager's work number, in the SAME conversation as that
 * manager's in-app / email turns. Verified-only, ambiguity-safe, one workspace
 * per conversation, and never the PropLane Assistant.
 */

const M1 = "11111111-0000-4000-8000-00000000000a"; // manager one
const M2 = "11111111-0000-4000-8000-00000000000b"; // manager two
const R = "22222222-0000-4000-8000-00000000000b"; // the resident
const ATTACKER = "33333333-0000-4000-8000-00000000000c";
const OTHER = "44444444-0000-4000-8000-00000000000d";
const W1 = "aaaaaaaa-0000-4000-8000-0000000000a1";
const W2 = "aaaaaaaa-0000-4000-8000-0000000000a2";
const W1B = "aaaaaaaa-0000-4000-8000-0000000000a3"; // a second workspace of manager one
const LINE1 = "bbbbbbbb-0000-4000-8000-0000000000b1";
const LINE1B = "bbbbbbbb-0000-4000-8000-0000000000b3";
const LINE2 = "bbbbbbbb-0000-4000-8000-0000000000b2";
const PHONE = "+14233423444";

type Seed = Record<string, Record<string, unknown>[]>;

function seededDb(extra: Seed = {}): FakeDb {
  return createConversationFakeDb({
    profiles: [
      { id: M1, email: "m1@x.co", full_name: "Maya Manager", role: "manager" },
      { id: M2, email: "m2@x.co", full_name: "Marco Landlord", role: "manager" },
      { id: R, email: "resident@x.co", full_name: "Rita Resident", phone: PHONE, phone_verified_at: "2026-10-01T00:00:00Z", role: "resident" },
    ],
    portal_workspaces: [
      { id: W1, owner_user_id: M1, name: "Maya Homes", is_default: true },
      { id: W1B, owner_user_id: M1, name: "Maya Other", is_default: false },
      { id: W2, owner_user_id: M2, name: "Marco Rentals", is_default: true },
    ],
    manager_sms_numbers: [
      { id: LINE1, workspace_id: W1, manager_user_id: M1, phone_number: "+12065550101", provision_state: "active" },
      { id: LINE1B, workspace_id: W1B, manager_user_id: M1, phone_number: "+12065550103", provision_state: "active" },
      { id: LINE2, workspace_id: W2, manager_user_id: M2, phone_number: "+12065550102", provision_state: "active" },
    ],
    manager_property_records: [
      { id: "H1", manager_user_id: M1, workspace_id: W1 },
      { id: "H2", manager_user_id: M2, workspace_id: W2 },
    ],
    manager_application_records: [
      { manager_user_id: M1, resident_email: "resident@x.co", property_id: "H1", row_data: { bucket: "approved" } },
    ],
    account_link_invites: [],
    portal_lease_pipeline_records: [],
    manager_vendor_records: [],
    portal_inbox_thread_records: [],
    sms_projection_conversations: [],
    sms_projection_turns: [],
    ...extra,
  });
}

let turnCounter = 0;
function summary(over: Record<string, unknown>): Record<string, unknown> {
  turnCounter += 1;
  return {
    id: `conv-${turnCounter}`,
    owner_manager_user_id: M1,
    counterparty_role: "prospect",
    work_line_id: LINE1,
    counterparty_user_id: null,
    counterparty_phone: PHONE,
    workspace_id: W1,
    merged_into_id: null,
    ...over,
  };
}
function turn(conversationId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  turnCounter += 1;
  return {
    id: `turn-${turnCounter}`,
    conversation_id: conversationId,
    direction: "inbound",
    body: `text ${turnCounter}`,
    occurred_at: `2026-10-02T10:0${turnCounter % 10}:00Z`,
    from_phone: PHONE,
    to_phone: "+12065550101",
    ...over,
  };
}

function withConversation(over: Record<string, unknown> = {}, turns: Record<string, unknown>[] = [{}]): Seed {
  const row = summary(over);
  return {
    sms_projection_conversations: [row],
    sms_projection_turns: turns.map((t) => turn(String(row.id), t)),
  };
}

describe("decideResidentSmsLink - which text conversations are a resident's", () => {
  const base = { residentId: R, verifiedPhone: PHONE, phoneVerifierIds: [R] };
  const row = { role: "prospect", counterpartyUserId: null as string | null, counterpartyPhone: PHONE };

  it("a verified phone that only this account verified links a prospect / applicant / resident conversation", () => {
    for (const role of ["prospect", "applicant", "resident"]) {
      expect(decideResidentSmsLink({ ...base, row: { ...row, role } })).toBe("verified_phone");
    }
  });

  it("an UNVERIFIED phone never links", () => {
    expect(decideResidentSmsLink({ ...base, verifiedPhone: null, phoneVerifierIds: [], row })).toBeNull();
  });

  it("a number another account ALSO verified is ambiguous: nothing links", () => {
    expect(decideResidentSmsLink({ ...base, phoneVerifierIds: [R, ATTACKER], row })).toBeNull();
    expect(decideResidentSmsLink({ ...base, phoneVerifierIds: [ATTACKER], row })).toBeNull();
  });

  it("a conversation the pipeline resolved to ANOTHER account is never the resident's, even on their number", () => {
    expect(decideResidentSmsLink({ ...base, row: { ...row, counterpartyUserId: OTHER } })).toBeNull();
  });

  it("a conversation resolved to this account is theirs", () => {
    expect(decideResidentSmsLink({ ...base, verifiedPhone: null, phoneVerifierIds: [], row: { ...row, counterpartyUserId: R, counterpartyPhone: null } })).toBe("account");
  });

  it("manager, admin, vendor and unresolved conversations are never a resident's", () => {
    for (const role of ["manager", "admin", "vendor", "unknown", "", undefined]) {
      expect(decideResidentSmsLink({ ...base, row: { ...row, role } })).toBeNull();
    }
  });

  it("a different number does not link", () => {
    expect(decideResidentSmsLink({ ...base, row: { ...row, counterpartyPhone: "+14235550000" } })).toBeNull();
  });

  it("formats of the same number match (only normalizeE164 decides)", () => {
    expect(decideResidentSmsLink({ ...base, row: { ...row, counterpartyPhone: "(423) 342-3444" } })).toBe("verified_phone");
  });
});

describe("loadResidentSmsConversations - the read path", () => {
  it("texts from the verified number to a manager's work number appear, naming the manager", async () => {
    const db = seededDb(withConversation({}, [
      { direction: "inbound", body: "Is the room still open?", occurred_at: "2026-10-02T10:00:00Z" },
      { direction: "outbound", body: "Yes, come by Friday.", occurred_at: "2026-10-02T10:05:00Z", from_phone: "+12065550101", to_phone: PHONE },
    ]));
    const { conversations, phone } = await loadResidentSmsConversations(db, R);
    expect(phone).toEqual({ hasPhone: true, verified: true, ambiguous: false });
    expect(conversations).toHaveLength(1);
    const [c] = conversations;
    expect(c!.key).toBe(`ws:${W1}`);
    expect(c!.counterparty).toMatchObject({
      workspaceId: W1,
      name: "Maya Manager",
      workspaceName: "Maya Homes",
      workPhone: "+12065550101",
      avatarUrl: null,
      initials: "MM",
    });
    expect(c!.turns.map((t) => t.body)).toEqual(["Is the room still open?", "Yes, come by Friday."]);
    expect(c!.linkedBy).toEqual(["verified_phone"]);
  });

  it("an unverified phone shows nothing and says why", async () => {
    const db = seededDb(withConversation());
    db.tables.profiles!.find((p) => p.id === R)!.phone_verified_at = null;
    const { conversations, phone } = await loadResidentSmsConversations(db, R);
    expect(conversations).toEqual([]);
    expect(phone).toEqual({ hasPhone: true, verified: false, ambiguous: false });
  });

  it("a number another account also verified is ambiguous: the resident sees none of it, and is told", async () => {
    const db = seededDb(withConversation());
    db.tables.profiles!.push({ id: ATTACKER, email: "evil@x.co", phone: PHONE, phone_verified_at: "2026-10-02T00:00:00Z", role: "resident" });
    const { conversations, phone } = await loadResidentSmsConversations(db, R);
    expect(conversations).toEqual([]);
    expect(phone.ambiguous).toBe(true);
    // ...and the other account sees none of it either.
    const other = await loadResidentSmsConversations(db, ATTACKER);
    expect(other.conversations).toEqual([]);
  });

  it("another account that never verified the number sees nothing of this resident's conversations", async () => {
    const db = seededDb(withConversation());
    db.tables.profiles!.push({ id: ATTACKER, email: "evil@x.co", phone: PHONE, phone_verified_at: null, role: "resident" });
    const { conversations } = await loadResidentSmsConversations(db, ATTACKER);
    expect(conversations).toEqual([]);
  });

  it("only THEIR conversations: another number, another account's, and manager/vendor rows are excluded", async () => {
    const own = summary({});
    const theirs = summary({ counterparty_phone: "+14235550000", counterparty_user_id: OTHER });
    const resolvedElsewhere = summary({ counterparty_user_id: OTHER }); // same phone, pipeline resolved to someone else
    const managerRow = summary({ counterparty_role: "manager" });
    const vendorRow = summary({ counterparty_role: "vendor" });
    const db = seededDb({
      sms_projection_conversations: [own, theirs, resolvedElsewhere, managerRow, vendorRow],
      sms_projection_turns: [own, theirs, resolvedElsewhere, managerRow, vendorRow].map((row) => turn(String(row.id), { body: `body of ${row.id}` })),
    });
    const { conversations } = await loadResidentSmsConversations(db, R);
    expect(conversations).toHaveLength(1);
    expect(conversations[0]!.turns.map((t) => t.body)).toEqual([`body of ${own.id}`]);
  });

  it("can text several managers: one conversation per workspace, never merged across workspaces", async () => {
    const a = summary({});
    const b = summary({ owner_manager_user_id: M2, work_line_id: LINE2, workspace_id: W2 });
    const c = summary({ work_line_id: LINE1B, workspace_id: W1B }); // same manager, a second workspace
    const db = seededDb({
      sms_projection_conversations: [a, b, c],
      sms_projection_turns: [a, b, c].map((row, i) => turn(String(row.id), { occurred_at: `2026-10-02T10:0${i}:00Z` })),
    });
    const { conversations } = await loadResidentSmsConversations(db, R);
    expect(conversations.map((x) => x.workspaceId).sort()).toEqual([W1, W1B, W2].sort());
    expect(conversations.find((x) => x.workspaceId === W2)!.counterparty.name).toBe("Marco Landlord");
  });

  it("two roles on one workspace's line (a prospect text, then a resident one) are ONE conversation", async () => {
    const prospect = summary({ counterparty_role: "prospect" });
    const resident = summary({ counterparty_role: "resident", counterparty_user_id: R });
    const db = seededDb({
      sms_projection_conversations: [prospect, resident],
      sms_projection_turns: [
        turn(String(prospect.id), { body: "first", occurred_at: "2026-10-01T09:00:00Z" }),
        turn(String(resident.id), { body: "second", occurred_at: "2026-10-02T09:00:00Z" }),
      ],
    });
    const { conversations } = await loadResidentSmsConversations(db, R);
    expect(conversations).toHaveLength(1);
    expect(conversations[0]!.turns.map((t) => t.body)).toEqual(["first", "second"]);
    expect(conversations[0]!.linkedBy.sort()).toEqual(["account", "verified_phone"]);
  });

  it("the workspace is the work LINE's, not the summary's stamp (a mis-stamped row cannot cross workspaces)", async () => {
    const db = seededDb(withConversation({ workspace_id: W2 })); // stamped W2, line belongs to W1
    const { conversations } = await loadResidentSmsConversations(db, R);
    expect(conversations.map((x) => x.workspaceId)).toEqual([W1]);
  });

  it("a conversation whose line cannot be placed in a workspace is dropped, not guessed", async () => {
    const db = seededDb(withConversation({ work_line_id: "bbbbbbbb-0000-4000-8000-0000000000ff" }));
    expect((await loadResidentSmsConversations(db, R)).conversations).toEqual([]);
  });

  it("a merged-away duplicate summary is not read", async () => {
    const db = seededDb(withConversation({ merged_into_id: "somewhere" }));
    expect((await loadResidentSmsConversations(db, R)).conversations).toEqual([]);
  });
});

function counterpartyFor(workspaceId: string): ResidentCounterparty {
  return { workspaceId, name: "Maya Manager", workspaceName: "Maya Homes", workPhone: "+12065550101", avatarUrl: null, initials: "MM" };
}

function conversation(over: Partial<ResidentSmsConversation> = {}): ResidentSmsConversation {
  return {
    workspaceId: W1,
    key: `ws:${W1}`,
    counterparty: counterpartyFor(W1),
    linkedBy: ["verified_phone"],
    turns: [
      { id: "t1", direction: "inbound", body: "hello by text", at: "2026-10-02T17:00:00Z", fromPhone: PHONE, toPhone: "+12065550101" },
      { id: "t2", direction: "outbound", body: "hi, it is Maya", at: "2026-10-02T17:30:00Z", fromPhone: "+12065550101", toPhone: PHONE },
    ],
    lastEventAt: "2026-10-02T17:30:00Z",
    ...over,
  };
}

function storedRow(over: Partial<PersistedInboxThread> = {}): PersistedInboxThread {
  return {
    id: "thread-1",
    folder: "inbox",
    from: "Maya Manager",
    email: "m1@x.co",
    subject: "Welcome",
    preview: "Welcome home",
    body: "Welcome home",
    time: "Oct 2, 2026, 9:00 AM",
    rootAt: "Oct 2, 2026, 9:00 AM",
    unread: true,
    conversationKey: `ws:${W1}`,
    workspaceId: W1,
    messages: [{ id: "m-a", from: "Rita Resident", body: "Thanks!", at: "Oct 2, 2026, 11:00 AM", outbound: true, channel: "proplane" }],
    readSources: [{ id: "thread-1", observation: "obs", unread: true }],
    readSourcesComplete: true,
    ...over,
  };
}

describe("folding texts into the resident's conversation", () => {
  it("texts land in the SAME row, in time order, keeping the row's identity and root", () => {
    const [row] = mergeResidentSmsConversations([storedRow()], [conversation()], "Rita Resident");
    expect(row!.id).toBe("thread-1");
    expect(row!.readSources).toEqual([{ id: "thread-1", observation: "obs", unread: true }]);
    const bodies = inboxThreadMessages(row!).map((m) => m.body);
    // The root (9:00) first; the texts (10:00 / 10:30 Pacific) before the 11:00 in-app turn.
    expect(bodies).toEqual(["Welcome home", "hello by text", "hi, it is Maya", "Thanks!"]);
    const texts = inboxThreadMessages(row!).filter((m) => m.channel === "sms");
    expect(texts.map((m) => m.id)).toEqual([`${PROJECTED_SMS_TURN_PREFIX}t1`, `${PROJECTED_SMS_TURN_PREFIX}t2`]);
    // From the resident's side the resident's own text is outgoing, the manager's incoming.
    expect(texts.map((m) => m.outbound)).toEqual([true, false]);
    expect(row!.body).toBe("Welcome home");
  });

  it("the texts are never persisted: a save carrying them appends nothing", () => {
    const [row] = mergeResidentSmsConversations([storedRow()], [conversation()], "Rita Resident");
    const merged = mergeInboxThreadRowData({
      stored: { messages: [{ id: "m-a", body: "Thanks!" }], rootMessageId: "thread-1-root", folder: "inbox" },
      requested: row as unknown as Record<string, unknown>,
      rule: { kind: "participant", authorUserId: R, authorName: "Rita", conversationHouseId: "" },
    });
    expect(merged.ok).toBe(true);
    if (merged.ok) {
      expect((merged.rowData.messages as { id: string }[]).map((m) => m.id)).toEqual(["m-a"]);
    }
  });

  it("a texts-first conversation re-roots on the first text and the old root stays in the timeline under a merged: id", () => {
    const early = conversation({
      turns: [{ id: "t0", direction: "inbound", body: "early text", at: "2026-10-01T08:00:00Z", fromPhone: PHONE, toPhone: "+12065550101" }],
    });
    const [row] = mergeResidentSmsConversations([storedRow()], [early], "Rita Resident");
    expect(row!.body).toBe("early text");
    expect(row!.rootChannel).toBe("sms");
    expect(row!.messages!.some((m) => m.id === "merged:thread-1-root" && m.body === "Welcome home")).toBe(true);
  });

  it("a conversation with only texts becomes its own derived row, with the manager's identity and no email", () => {
    const rows = mergeResidentSmsConversations([], [conversation()], "Rita Resident");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: `${RESIDENT_SMS_ROW_PREFIX}${W1}`,
      smsOnly: true,
      email: "",
      conversationKey: `ws:${W1}`,
      workspaceId: W1,
      counterparty: { name: "Maya Manager", workPhone: "+12065550101" },
    });
    expect(rows[0]!.preview).toBe("hi, it is Maya");
    expect(isServerReservedInboxThreadId(rows[0]!.id)).toBe(true);
    expect(smsOnlyResidentRow(conversation({ turns: [] }), "Rita")).toBeNull();
  });

  it("another workspace's texts never fold into this workspace's row", () => {
    const rows = mergeResidentSmsConversations(
      [storedRow()],
      [conversation({ workspaceId: W2, key: `ws:${W2}`, counterparty: counterpartyFor(W2) })],
      "Rita Resident",
    );
    expect(rows).toHaveLength(2);
    expect(inboxThreadMessages(rows.find((r) => r.id === "thread-1")!).some((m) => m.channel === "sms")).toBe(false);
  });

  it("the PropLane Assistant thread is never given a counterparty or any texts, even if it claims a workspace key", () => {
    const assistant = storedRow({
      id: "resident-agent-abc",
      from: "PropLane Assistant",
      conversationKey: `ws:${W1}`,
      counterparty: counterpartyFor(W1),
    });
    const stamped = stampCounterparties([assistant], new Map([[W1, counterpartyFor(W1)]]));
    expect(stamped[0]!.counterparty).toBeUndefined();
    const merged = mergeResidentSmsConversations(stamped, [conversation()], "Rita Resident");
    expect(inboxThreadMessages(merged.find((r) => r.id === "resident-agent-abc")!).some((m) => m.channel === "sms")).toBe(false);
    expect(merged.find((r) => r.id === `${RESIDENT_SMS_ROW_PREFIX}${W1}`)).toBeDefined();
  });

  it("a counterparty or smsOnly claim stored by a client is replaced by the server's, never trusted", () => {
    const forged = storedRow({ counterparty: { ...counterpartyFor(W1), name: "Totally the Landlord" }, smsOnly: true });
    const [honest] = stampCounterparties([forged], new Map([[W1, counterpartyFor(W1)]]));
    expect(honest!.counterparty!.name).toBe("Maya Manager");
    expect(honest!.smsOnly).toBeUndefined();
    const [none] = stampCounterparties([forged], new Map());
    expect(none!.counterparty).toBeUndefined();
  });
});

describe("applyResidentConversationExtras - the list the route returns", () => {
  it("a resident's in-app row, the manager's identity and their texts arrive as one conversation", async () => {
    const db = seededDb(withConversation({}, [{ body: "texting from my phone", occurred_at: "2026-10-02T10:00:00Z" }]));
    const { rows, phone } = await applyResidentConversationExtras(
      db,
      { id: R, name: "Rita Resident", mayReadResidentTexts: true },
      [storedRow()],
    );
    expect(phone.verified).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.counterparty).toMatchObject({ name: "Maya Manager", workspaceName: "Maya Homes" });
    expect(inboxThreadMessages(rows[0]!).some((m) => m.body === "texting from my phone" && m.channel === "sms")).toBe(true);
  });

  it("a forged ws:<uuid> key stores nothing about a workspace the resident is not linked to", async () => {
    // W2 is Marco's workspace; the resident has no application, lease or text there.
    const forged = storedRow({ id: "thread-forged", conversationKey: `ws:${W2}`, workspaceId: W2 });
    const db = seededDb();
    const { rows } = await applyResidentConversationExtras(db, { id: R, name: "Rita", mayReadResidentTexts: false }, [forged]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.counterparty).toBeUndefined();
    expect(JSON.stringify(rows[0])).not.toContain("Marco");
    expect(JSON.stringify(rows[0])).not.toContain("+12065550102");
  });

  it("a linked workspace is still named while an unlinked one in the same list is not", async () => {
    const real = storedRow({ id: "thread-real" });
    const forged = storedRow({ id: "thread-forged", conversationKey: `ws:${W2}`, workspaceId: W2 });
    const { rows } = await applyResidentConversationExtras(seededDb(), { id: R, mayReadResidentTexts: false }, [real, forged]);
    expect(rows.find((r) => r.id === "thread-real")!.counterparty).toMatchObject({ name: "Maya Manager" });
    expect(rows.find((r) => r.id === "thread-forged")!.counterparty).toBeUndefined();
  });

  it("a workspace key with no link at all (no application or lease) is never named", async () => {
    const db = seededDb({ manager_application_records: [] });
    const { rows } = await applyResidentConversationExtras(db, { id: R, mayReadResidentTexts: false }, [storedRow()]);
    expect(rows[0]!.counterparty).toBeUndefined();
  });

  it("a caller without the resident role gets no texts (identity stamping only)", async () => {
    const db = seededDb(withConversation());
    const { rows } = await applyResidentConversationExtras(db, { id: R, name: "Rita", mayReadResidentTexts: false }, [storedRow()]);
    expect(rows).toHaveLength(1);
    expect(inboxThreadMessages(rows[0]!).some((m) => m.channel === "sms")).toBe(false);
  });

  it("an unverified phone: rows list, no texts, and the phone state says verify", async () => {
    const db = seededDb(withConversation());
    db.tables.profiles!.find((p) => p.id === R)!.phone_verified_at = null;
    const { rows, phone } = await applyResidentConversationExtras(db, { id: R, mayReadResidentTexts: true }, [storedRow()]);
    expect(phone).toEqual({ hasPhone: true, verified: false, ambiguous: false });
    expect(inboxThreadMessages(rows[0]!).some((m) => m.channel === "sms")).toBe(false);
  });
});

describe("linkVerifiedPhoneHistory - verifying links the history already there", () => {
  it("re-keys the past text conversation through the resolver: the account key where the resident is linked to the workspace", async () => {
    const db = seededDb(withConversation({}, [{}]));
    const result = await linkVerifiedPhoneHistory(db, R);
    expect(result).toEqual({ stamped: 1, skipped: null });
    const row = db.tables.sms_projection_conversations![0]!;
    expect(row.conversation_key).toBe(`acct:${R}`);
    expect(row.workspace_id).toBe(W1);
  });

  it("where the resident is not (yet) linked to the workspace the conversation keeps a phone key, still theirs", async () => {
    const db = seededDb(withConversation({ owner_manager_user_id: M2, work_line_id: LINE2, workspace_id: W2 }, [{}]));
    await linkVerifiedPhoneHistory(db, R);
    const row = db.tables.sms_projection_conversations![0]!;
    expect(row.conversation_key).toBe(`tel:${PHONE}`);
    expect(row.workspace_id).toBe(W2);
  });

  it("never links an unverified phone", async () => {
    const db = seededDb(withConversation({}, [{}]));
    db.tables.profiles!.find((p) => p.id === R)!.phone_verified_at = null;
    expect(await linkVerifiedPhoneHistory(db, R)).toEqual({ stamped: 0, skipped: "unverified" });
    expect(db.rpcCalls.filter((c) => c.fn === "stamp_sms_projection_conversation")).toEqual([]);
  });

  it("an ambiguous number is left alone", async () => {
    const db = seededDb(withConversation({}, [{}]));
    db.tables.profiles!.push({ id: ATTACKER, email: "evil@x.co", phone: PHONE, phone_verified_at: "2026-10-02T00:00:00Z" });
    expect(await linkVerifiedPhoneHistory(db, R)).toEqual({ stamped: 0, skipped: "ambiguous" });
    expect(db.rpcCalls.filter((c) => c.fn === "stamp_sms_projection_conversation")).toEqual([]);
  });

  it("never re-keys a manager's or another account's conversation", async () => {
    const mine = summary({});
    const managerRow = summary({ counterparty_role: "manager" });
    const elsewhere = summary({ counterparty_user_id: OTHER });
    const db = seededDb({ sms_projection_conversations: [mine, managerRow, elsewhere], sms_projection_turns: [] });
    await linkVerifiedPhoneHistory(db, R);
    const stamped = db.rpcCalls.filter((c) => c.fn === "stamp_sms_projection_conversation").map((c) => c.args.p_conversation_id);
    expect(stamped).toEqual([mine.id]);
  });
});

describe("Gmail from the resident's account email lands in the same conversation", () => {
  const mail = {
    managerUserId: M1,
    managerEmail: "m1@x.co",
    senderEmail: "resident@x.co",
    senderName: "Rita Resident",
    subject: "Window won't close",
    inboundText: "The kitchen window is stuck.",
    replyText: "I have logged that for the team.",
    inboundEmailId: "em-1",
    workspaceId: W1,
    workLine: "maya@mail.proplane.test",
  };
  const residentRows = (db: FakeDb) => db.tables.portal_inbox_thread_records!.filter((row) => row.owner_user_id === R);

  it("a resident's email is in THEIR Communication under the workspace key, beside the manager's copy; the assistant's answer is not", async () => {
    const db = seededDb();
    await mirrorAssistantEmailConversation(db, { ...mail, replySent: true, residentUserId: R });
    const rows = residentRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.conversation_key).toBe(`ws:${W1}`);
    expect(rows[0]!.workspace_id).toBe(W1);
    const data = rows[0]!.row_data as { body?: string; messages?: { body: string }[]; rootOutbound?: boolean };
    const everyBody = [data.body, ...(data.messages ?? []).map((m) => m.body)];
    expect(everyBody).toContain("The kitchen window is stuck.");
    expect(everyBody.join(" ")).not.toContain("logged that for the team");
    // The manager's own row for this resident is keyed to the resident's ACCOUNT (one key).
    const managerRow = db.tables.portal_inbox_thread_records!.find((row) => row.owner_user_id === M1)!;
    expect(managerRow.conversation_key).toBe(`acct:${R}`);
  });

  it("a second email appends to the same row, and a redelivery is a no-op", async () => {
    const db = seededDb();
    await mirrorAssistantEmailConversation(db, { ...mail, residentUserId: R });
    await mirrorAssistantEmailConversation(db, { ...mail, residentUserId: R });
    await mirrorAssistantEmailConversation(db, { ...mail, inboundEmailId: "em-2", inboundText: "Also the door.", residentUserId: R });
    expect(residentRows(db)).toHaveLength(1);
  });

  it("a prospect or any sender not classified as this manager's resident gets no resident-side row", async () => {
    const db = seededDb();
    await mirrorAssistantEmailConversation(db, { ...mail, senderEmail: "stranger@x.co", senderName: "Stranger" });
    expect(residentRows(db)).toHaveLength(0);
  });

  it("the emailed turn and the texts then read as ONE conversation", async () => {
    const db = seededDb(withConversation({}, [{ body: "also texting you", occurred_at: "2026-10-02T10:00:00Z" }]));
    await mirrorAssistantEmailConversation(db, { ...mail, residentUserId: R });
    const stored = residentRows(db).map((row) => ({
      ...(row.row_data as Record<string, unknown>),
      id: row.id,
    })) as unknown as PersistedInboxThread[];
    const { rows } = await applyResidentConversationExtras(db, { id: R, name: "Rita Resident", mayReadResidentTexts: true }, stored);
    expect(rows).toHaveLength(1);
    const channels = inboxThreadMessages(rows[0]!).map((m) => m.channel);
    expect(channels).toContain("email");
    expect(channels).toContain("sms");
    expect(rows[0]!.counterparty!.name).toBe("Maya Manager");
  });
});

describe("a resident's client upsert never stores server-owned conversation identity", () => {
  const user = { id: R, email: "resident@x.co" };
  const claimed = {
    id: "msg_inbox_client_1",
    scope: "axis_portal_inbox_resident_v1",
    folder: "inbox",
    subject: "Hello",
    conversationKey: `ws:${W2}`,
    workspaceId: W2,
    counterparty: { workspaceId: W2, name: "Totally the Landlord" },
    smsOnly: true,
    identityFlag: { reason: "ambiguous_phone", accountIds: [] },
  };

  it("drops the key, workspace and counterparty claims on a resident-scope write", () => {
    const record = buildClientPortalInboxThreadUpsert(claimed, user, {
      scope: "axis_portal_inbox_resident_v1",
      isAdmin: false,
      stripConversationIdentity: true,
    });
    const data = record.row_data as Record<string, unknown>;
    for (const key of ["conversationKey", "workspaceId", "counterparty", "smsOnly", "identityFlag"]) {
      expect(data).not.toHaveProperty(key);
    }
    expect(data.subject).toBe("Hello");
    expect(record.owner_user_id).toBe(R);
  });

  it("leaves other scopes (a manager's own keyed rows) untouched", () => {
    const record = buildClientPortalInboxThreadUpsert(claimed, user, {
      scope: "axis_portal_inbox_manager_v1",
      isAdmin: false,
      stripConversationIdentity: false,
    });
    expect((record.row_data as Record<string, unknown>).conversationKey).toBe(`ws:${W2}`);
  });
});
