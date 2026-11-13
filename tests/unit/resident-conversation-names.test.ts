// Captain, Nov 12: a resident tells the PropLane agent, a house conversation and their own PropLane Number's agent
// apart by NAME, the agent is pinned first, a phone number is never a title, every door into the agent is the one
// conversation, and a resident can start a conversation about a house they live in.
import { describe, expect, it } from "vitest";
import {
  HOUSE_CONVERSATION_FALLBACK_NAME,
  MY_PROPLANE_AGENT_NAME,
  PROPLANE_AGENT_NAME,
  RESIDENT_ASSISTANT_ENTRY_POINTS,
  isHouseStarterId,
  isResidentNumberTextThread,
  looksLikePhoneNumber,
  orderResidentConversationRows,
  residentAssistantConversationId,
  residentAssistantDisplayName,
  residentAssistantEntryTarget,
  residentConversationKind,
  residentConversationLabel,
  residentHouseStarters,
  residentHouseWorkPhone,
  residentThreadHeaderSubtitle,
  type ResidentConversationKind,
} from "@/lib/communication/resident-conversation-names";
import { buildResidentAssistantPlaceholderThread, propLaneAssistantThreadIdForPortal } from "@/lib/communication-assistant-inbox-list";
import { resolveResidentThreadManager } from "@/lib/resident-communication-manager";
import type { ResidentManagerContact } from "@/hooks/use-resident-manager-contacts";
import type { PersistedInboxThread } from "@/lib/portal-inbox-storage";

const RESIDENT = "4f1d2a3b-1111-4222-8333-444455556666";

function contact(overrides: Partial<ResidentManagerContact> = {}): ResidentManagerContact {
  return {
    managerName: "Cascade Lofts Management",
    phone: "+12065550100",
    phoneKind: "work",
    email: "work@cascade.example",
    emailKind: "work",
    propertyLabel: "4709A 8th Ave, Seattle",
    leaseStart: null,
    leaseEnd: null,
    status: "current",
    ...overrides,
  };
}

function thread(overrides: Record<string, unknown> = {}): PersistedInboxThread {
  return {
    id: "res-thr-1",
    folder: "inbox",
    from: "Cascade Lofts Management",
    email: "work@cascade.example",
    subject: "Keys",
    preview: "Keys are ready",
    time: "Nov 10, 2026",
    unread: false,
    ...overrides,
  } as PersistedInboxThread;
}

function labelFor(t: PersistedInboxThread, contacts: ResidentManagerContact[] = [contact()]) {
  return residentConversationLabel(t, resolveResidentThreadManager(t, contacts), contacts);
}

describe("what a resident's conversations are called", () => {
  it("names the PropLane agent 'PropLane', whatever the stored author says", () => {
    const agent = buildResidentAssistantPlaceholderThread(RESIDENT);
    expect(agent.from).toBe("PropLane Assistant");
    expect(labelFor(agent)).toMatchObject({ kind: "proplane_agent", title: PROPLANE_AGENT_NAME });
    expect(PROPLANE_AGENT_NAME).toBe("PropLane");
    expect(residentAssistantDisplayName("PropLane Assistant")).toBe("PropLane");
    expect(residentAssistantDisplayName("")).toBe("PropLane");
  });

  it("titles a manager / work-number conversation by the HOUSE, with the manager and number beside it", () => {
    const label = labelFor(thread());
    expect(label.kind).toBe("house");
    expect(label.title).toBe("4709A 8th Ave");
    expect(label.withName).toBe("Cascade Lofts Management");
    expect(label.workPhone).toBe("+12065550100");
    expect(residentThreadHeaderSubtitle(label)).toBe("Cascade Lofts Management · +1 (206) 555-0100");
  });

  it("prefers the thread's own house over the contact's, then the workspace, then the manager, then 'Your home'", () => {
    const stamped = thread({ houses: [{ propertyId: "p1", label: "88 Pine St, Seattle" }] });
    expect(labelFor(stamped).title).toBe("88 Pine St");
    const workspaceOnly = thread({ counterparty: { workspaceId: "w", name: "Dana", workspaceName: "Pine Homes", workPhone: null, avatarUrl: null, initials: "D" } });
    expect(labelFor(workspaceOnly, [contact({ propertyLabel: null })]).title).toBe("Pine Homes");
    expect(labelFor(thread({ from: "Dana Ortiz" }), [contact({ propertyLabel: null, managerName: null, email: "other@x.example" })]).title).toBe("Dana Ortiz");
    // An email address is not a name either.
    expect(
      labelFor(thread({ from: "", email: "x@y.example" }), [contact({ propertyLabel: null, managerName: null, email: "other@x.example" })]).title,
    ).toBe("Your home");
    expect(HOUSE_CONVERSATION_FALLBACK_NAME).toBe("Your home");
  });

  it("never uses a phone number as a title, even when the thread was stored under one", () => {
    expect(looksLikePhoneNumber("+1 (206) 555-0100")).toBe(true);
    expect(looksLikePhoneNumber("206-555-0100")).toBe(true);
    expect(looksLikePhoneNumber("4709A 8th Ave")).toBe(false);
    const numbered = thread({ from: "+12065550100", email: "unmatched@x.example", counterparty: undefined });
    const label = labelFor(numbered, [contact({ propertyLabel: null, managerName: null, email: "other@x.example" })]);
    expect(looksLikePhoneNumber(label.title)).toBe(false);
    // A manager whose name is a number falls through to the next real name.
    const numberManager = thread({ counterparty: { workspaceId: "w", name: "+12065550100", workspaceName: "Pine Homes", workPhone: "+12065550100", avatarUrl: null, initials: "P" } });
    expect(labelFor(numberManager, [contact({ propertyLabel: null })]).title).toBe("Pine Homes");
  });

  it("calls the agent behind the resident's own PropLane Number 'My PropLane agent', never the texter's number", () => {
    const text = thread({
      id: "resident-agent-inbound-sms:abc",
      from: "+12065550123",
      email: "+12065550123@sms.proplane.local",
      subject: "Text message",
    });
    expect(isResidentNumberTextThread(text)).toBe(true);
    expect(residentConversationKind(text)).toBe("my_agent");
    const label = labelFor(text, []);
    expect(label.title).toBe(MY_PROPLANE_AGENT_NAME);
    expect(label.title).toBe("My PropLane agent");
    expect(label.withName).toBe("+1 (206) 555-0123");
  });

  it("keeps a house chat titled as the house chat and tells the three voices apart", () => {
    const houseChat = thread({ id: "house-chat:abcd1234efgh", from: "House · 4709A 8th Ave", threadType: "house" });
    expect(labelFor(houseChat)).toMatchObject({ kind: "house_chat", title: "House · 4709A 8th Ave" });
    const titles = [buildResidentAssistantPlaceholderThread(RESIDENT), thread(), thread({ id: "resident-agent-inbound-sms:x", email: "+1@sms.proplane.local", from: "+1" })].map(
      (t) => labelFor(t).title,
    );
    expect(new Set(titles).size).toBe(3);
  });

  it("only offers a WORK number to copy, never a manager's profile phone", () => {
    const t = thread();
    expect(residentHouseWorkPhone(t, [contact()])).toBe("+12065550100");
    expect(residentHouseWorkPhone(t, [contact({ phoneKind: "profile", phone: "+14255550199" })])).toBeUndefined();
    expect(
      residentHouseWorkPhone(thread({ counterparty: { workspaceId: "w", name: "D", workspaceName: "W", workPhone: "+12065550101", avatarUrl: null, initials: "D" } }), []),
    ).toBe("+12065550101");
  });
});

describe("list order: the PropLane agent is pinned first", () => {
  type Row = { threadId: string; sortMs: number; kind: ResidentConversationKind };
  const rows: Row[] = [
    { threadId: "house-a", sortMs: 300, kind: "house" },
    { threadId: "chat", sortMs: 100, kind: "house_chat" },
    { threadId: "my-number", sortMs: 500, kind: "my_agent" },
    { threadId: "agent", sortMs: 1, kind: "proplane_agent" },
    { threadId: "house-b", sortMs: 400, kind: "house" },
  ];

  it("puts the agent first even when it is the oldest, then every other conversation, house chats included, by recency", () => {
    const ordered = orderResidentConversationRows(rows, (row) => row.kind);
    expect(ordered.map((row) => row.threadId)).toEqual(["agent", "my-number", "house-b", "house-a", "chat"]);
  });

  it("is stable and does not reorder within a group that is already newest-first", () => {
    const input = [
      { threadId: "a", sortMs: 9, kind: "house" as const },
      { threadId: "b", sortMs: 9, kind: "house" as const },
    ];
    expect(orderResidentConversationRows(input, (row) => row.kind).map((row) => row.threadId)).toEqual(["a", "b"]);
  });
});

describe("one PropLane agent, every door", () => {
  it("every entry point resolves to the same conversation id and the one resident endpoint", () => {
    const targets = RESIDENT_ASSISTANT_ENTRY_POINTS.map((entry) => residentAssistantEntryTarget(entry, RESIDENT));
    expect(new Set(targets.map((target) => target.conversationId))).toEqual(new Set([`resident-agent-${RESIDENT}`]));
    expect(new Set(targets.map((target) => target.endpoint))).toEqual(new Set(["/api/agent/resident-chat"]));
    expect(RESIDENT_ASSISTANT_ENTRY_POINTS).toEqual(
      expect.arrayContaining(["top_bar", "dashboard_card", "phone_ask_tab", "composer_ask", "communication_list"]),
    );
  });

  it("the pinned list row's id is that same id", () => {
    expect(propLaneAssistantThreadIdForPortal("resident", RESIDENT)).toBe(residentAssistantConversationId(RESIDENT));
    expect(buildResidentAssistantPlaceholderThread(RESIDENT).id).toBe(residentAssistantConversationId(RESIDENT));
  });
});

describe("start a conversation about a house", () => {
  it("offers each current house with no conversation, titled by the house, addressed to its manager", () => {
    const starters = residentHouseStarters([contact()], []);
    expect(starters).toEqual([
      {
        id: "house-start:work@cascade.example",
        houseLabel: "4709A 8th Ave",
        managerName: "Cascade Lofts Management",
        email: "work@cascade.example",
        workPhone: "+12065550100",
      },
    ]);
    expect(isHouseStarterId(starters[0]!.id)).toBe(true);
    expect(isHouseStarterId("res-thr-1")).toBe(false);
  });

  it("offers nothing for a house that already has a conversation, an ended tenancy, or no work-line phone to show", () => {
    expect(residentHouseStarters([contact()], [thread()])).toEqual([]);
    // Matched by the house when the stored address differs from the contact's.
    expect(residentHouseStarters([contact()], [], ["4709A 8th Ave"])).toEqual([]);
    expect(residentHouseStarters([contact({ status: "ended" })], [])).toEqual([]);
    // An archived conversation does not cover the house: the resident can start a fresh one.
    expect(residentHouseStarters([contact()], [thread({ folder: "trash" })])).toHaveLength(1);
    // A profile phone is never offered as the house's number.
    expect(residentHouseStarters([contact({ phoneKind: "profile" })], [])[0]!.workPhone).toBeUndefined();
  });

  it("never titles a starter with a number and skips a house whose label is only a number", () => {
    expect(residentHouseStarters([contact({ propertyLabel: "+1 206 555 0100" })], [])).toEqual([]);
  });

  it("offers two houses from two managers as two starters", () => {
    const starters = residentHouseStarters(
      [contact(), contact({ email: "work@pioneer.example", propertyLabel: "The Pioneer", managerName: "Pioneer Properties" })],
      [],
    );
    expect(starters.map((entry) => entry.houseLabel)).toEqual(["4709A 8th Ave", "The Pioneer"]);
  });
});
