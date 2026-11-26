import { describe, expect, it } from "vitest";
import {
  foldViewerSelfIntoAssistant,
  isViewerSelfThread,
  stampViewerSelf,
  viewerSelfConversationKeys,
} from "@/lib/communication/self-conversation";
import { withoutServerOwnedConversationKeys } from "@/lib/portal-inbox-thread-upsert";
import {
  buildActiveCommunicationThreads,
  countUnreadActiveCommunication,
  countUnreadActiveConversations,
  emailThreadJoinKeys,
  emailThreadPersonKey,
  smsConversationPersonKey,
} from "@/lib/communication-active-rows";
import { buildManagerAssistantPlaceholderThread, managerAgentNoticeThreadId } from "@/lib/communication-assistant-inbox-list";
import { emailForPhoneInWorkspace, type PhoneEmailEvidence } from "@/lib/sms/phone-email-join";
import { mergeUnifiedInboxItems, unifiedInboxKey } from "@/lib/unified-inbox-merge";
import type { PersistedInboxThread } from "@/lib/portal-inbox-storage";
import type { ManagerSmsResidentConversation } from "@/lib/manager-sms-messages";

const VIEWER = "11111111-1111-4111-8111-111111111111";
const WS = "22222222-2222-4222-8222-222222222222";

function thread(partial: Partial<PersistedInboxThread> & Pick<PersistedInboxThread, "id" | "from">): PersistedInboxThread {
  return {
    folder: "inbox",
    email: "",
    subject: "Subject",
    preview: "Preview",
    body: "Body",
    time: "2026-11-18T10:00:00.000Z",
    unread: false,
    ...partial,
  };
}

const identity = { userId: VIEWER, confirmedEmail: "Me@Example.com", verifiedPhone: "(650) 555-0100" };

describe("self key derivation", () => {
  it("derives acct, mail and tel from the session identity", () => {
    expect([...viewerSelfConversationKeys(identity)].sort()).toEqual(
      [`acct:${VIEWER}`, "mail:me@example.com", "tel:+16505550100"].sort(),
    );
  });

  it("leaves out an unconfirmed email and an unverified phone", () => {
    expect([...viewerSelfConversationKeys({ userId: VIEWER })]).toEqual([`acct:${VIEWER}`]);
  });

  it("stamps acct / mail / tel rows and nothing else", () => {
    const rows = stampViewerSelf(
      [
        thread({ id: "a", from: "Me", conversationKey: `acct:${VIEWER}`, workspaceId: WS }),
        thread({ id: "b", from: "Me", conversationKey: "mail:me@example.com", workspaceId: WS }),
        thread({ id: "c", from: "Me", conversationKey: "tel:+16505550100", workspaceId: WS }),
        thread({ id: "d", from: "Other", conversationKey: "mail:other@example.com", workspaceId: WS }),
        thread({ id: "e", from: "Flagged", conversationKey: "tel:+16505550100", identityFlag: { reason: "ambiguous_phone", accountIds: [] } }),
      ],
      identity,
    );
    expect(rows.map((row) => row.isViewerSelf === true)).toEqual([true, true, true, false, false]);
  });

  it("ignores a client-supplied flag, both ways", () => {
    const rows = stampViewerSelf(
      [thread({ id: "x", from: "Other", conversationKey: "mail:other@example.com", isViewerSelf: true })],
      identity,
    );
    expect(rows[0]!.isViewerSelf).toBeUndefined();
    expect(withoutServerOwnedConversationKeys({ id: "x", isViewerSelf: true })).toEqual({ id: "x" });
    expect(isViewerSelfThread({ id: "x", email: "", conversationKey: "mail:other@example.com" }, viewerSelfConversationKeys(identity))).toBe(false);
  });
});

describe("self fold into the Assistant", () => {
  const assistantId = managerAgentNoticeThreadId(VIEWER);
  const assistant = (extra: Partial<PersistedInboxThread> = {}) => ({
    ...buildManagerAssistantPlaceholderThread(VIEWER),
    body: "Welcome",
    time: "2026-11-18T09:00:00.000Z",
    ...extra,
  });
  const self = thread({
    id: "msg_self_1",
    from: "Prakrit Ramachandran",
    conversationKey: `acct:${VIEWER}`,
    workspaceId: WS,
    body: "Your stay was confirmed",
    time: "2026-11-18T10:00:00.000Z",
    unread: true,
    isViewerSelf: true,
  });

  it("folds the self row into one Assistant row, interleaved by time", () => {
    const rows = foldViewerSelfIntoAssistant([assistant(), self], assistantId);
    expect(rows.map((row) => row.id)).toEqual([assistantId]);
    const folded = rows[0]!;
    expect(folded.unread).toBe(true);
    expect(folded.sourceThreadIds).toContain("msg_self_1");
    expect([folded.body, ...(folded.messages ?? []).map((m) => m.body)]).toEqual(["Welcome", "Your stay was confirmed"]);
  });

  it("carries the join and binding keys onto the folded row so the viewer's own text projection joins it", () => {
    const selfTel = thread({
      id: "msg_self_tel", from: "Me", conversationKey: "tel:+16505550100", workspaceId: WS, body: "Reminder", smsConversationKey: "sms-key-1", isViewerSelf: true,
    });
    const folded = foldViewerSelfIntoAssistant([assistant(), selfTel, { ...self, smsBindingKeys: ["sms-key-1"] }], assistantId)[0]!;
    expect(folded.smsConversationKey).toBe("sms-key-1");
    expect(folded.smsBindingKeys).toEqual(["sms-key-1"]);
    expect(emailThreadJoinKeys(folded)).toEqual([`ck:${WS}:tel:+16505550100`]);
    expect(emailThreadPersonKey(folded)).toBe(emailThreadPersonKey({ id: "x", smsConversationKey: "sms-key-1", email: "" }));
    // Two different bindings: no single key, both retained, no email fallback.
    const two = foldViewerSelfIntoAssistant([assistant(), selfTel, { ...self, smsConversationKey: "sms-key-2" }], assistantId)[0]!;
    expect(two.smsConversationKey).toBeUndefined();
    expect(two.smsBindingKeys).toEqual(["sms-key-1", "sms-key-2"]);
    // The Assistant row's own conversation key is never overwritten.
    const keyedAssistant = foldViewerSelfIntoAssistant([assistant({ conversationKey: `acct:${VIEWER}` }), selfTel], assistantId)[0]!;
    expect(keyedAssistant.conversationKey).toBe(`acct:${VIEWER}`);
  });

  it("keeps the self row its own row when there is no Assistant row yet (loading) or the flag is absent (self read failed)", () => {
    expect(foldViewerSelfIntoAssistant([self], assistantId).map((row) => row.id)).toEqual(["msg_self_1"]);
    const unflagged = { ...self, isViewerSelf: undefined };
    expect(foldViewerSelfIntoAssistant([assistant(), unflagged], assistantId).map((row) => row.id).sort()).toEqual(
      [assistantId, "msg_self_1"].sort(),
    );
  });

  it("does not fold an archived self row, nor another person's row", () => {
    const archived = { ...self, folder: "trash" as const };
    const other = thread({ id: "msg_other", from: "Someone", conversationKey: "mail:someone@example.com" });
    const rows = foldViewerSelfIntoAssistant([assistant(), archived, other], assistantId);
    expect(rows.map((row) => row.id).sort()).toEqual([assistantId, "msg_other", "msg_self_1"].sort());
  });

  it("the list and the badge agree: one unread conversation, not two", () => {
    const opts = { portal: "manager" as const, viewerId: VIEWER, smsUiEnabled: false };
    const stored = [self];
    const list = buildActiveCommunicationThreads(stored, opts);
    const unreadRows = list.filter((row) => row.folder === "inbox" && row.unread);
    expect(unreadRows.map((row) => row.id)).toEqual([assistantId]);
    expect(countUnreadActiveCommunication(stored, opts)).toBe(unreadRows.length);
    expect(countUnreadActiveConversations(stored, opts)).toBe(unreadRows.length);
    // Without the stamp (self read failed) the row stays its own and counts on its own.
    const unflagged = [{ ...self, isViewerSelf: undefined }];
    expect(countUnreadActiveCommunication(unflagged, opts)).toBe(1);
  });
});

describe("one row per person: phone joins email within one workspace", () => {
  const OWNER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const OWNER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const evidence: PhoneEmailEvidence[] = [
    { ownerUserId: OWNER_A, phone: "+16505129140", email: "mihika@example.com", atMs: 1 },
    { ownerUserId: OWNER_A, phone: "(650) 512-9140", email: "Mihika@Example.com ", atMs: 2 },
  ];

  it("takes the email the same workspace ties to the phone, however it was written", () => {
    expect(emailForPhoneInWorkspace(evidence, OWNER_A, "+1 650 512 9140")).toBe("mihika@example.com");
  });

  it("never joins across workspaces", () => {
    expect(emailForPhoneInWorkspace(evidence, OWNER_B, "+16505129140")).toBeNull();
    expect(emailForPhoneInWorkspace(evidence, OWNER_A, "+16505550000")).toBeNull();
  });

  it("joins nothing when one workspace ties the phone to two different people", () => {
    const shared: PhoneEmailEvidence[] = [
      ...evidence,
      { ownerUserId: OWNER_A, phone: "+16505129140", email: "housemate@example.com", atMs: 3 },
    ];
    expect(emailForPhoneInWorkspace(shared, OWNER_A, "+16505129140")).toBeNull();
    // Newest-first evidence is refused the same way: the guard is the pair, not the order.
    expect(emailForPhoneInWorkspace([...shared].reverse(), OWNER_A, "+16505129140")).toBeNull();
  });

  function smsRow(residentEmail: string | null): ManagerSmsResidentConversation {
    return { residentUserId: null, residentEmail, name: "+1 (650) 512-9140", phone: "+16505129140", propertyLabel: null, conversationKey: "k1" } as ManagerSmsResidentConversation;
  }

  it("the joined text row and the email row become one list row; an unjoined one stays two", () => {
    const email = thread({ id: "mail-1", from: "Mihika Sridhar", email: "mihika@example.com" });
    const emailItem = {
      key: unifiedInboxKey("email", email.id), channel: "email" as const, threadId: email.id, name: "Mihika Sridhar",
      preview: "", time: "", sortMs: 2, unread: false, personKey: emailThreadPersonKey(email),
    };
    const smsItem = (residentEmail: string | null) => {
      const resident = smsRow(residentEmail);
      return {
        key: unifiedInboxKey("sms", "k1"), channel: "sms" as const, threadId: "k1", name: resident.name,
        preview: "", time: "", sortMs: 1, unread: false, personKey: smsConversationPersonKey(resident, new Set<string>()),
      };
    };
    const joined = emailForPhoneInWorkspace(evidence, OWNER_A, "+16505129140");
    expect(mergeUnifiedInboxItems([emailItem, smsItem(joined)])).toHaveLength(1);
    const otherWorkspace = emailForPhoneInWorkspace(evidence, OWNER_B, "+16505129140");
    expect(mergeUnifiedInboxItems([emailItem, smsItem(otherWorkspace)])).toHaveLength(2);
  });
});
