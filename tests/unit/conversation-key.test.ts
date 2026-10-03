import { describe, expect, it } from "vitest";
import {
  PERSONAL_WORKSPACE_ID,
  accountKey,
  conversationKeyKind,
  deriveConversationKey,
  emailKey,
  phoneKey,
  threadMatchesRecipient,
  workspaceKey,
  type AccountCandidate,
} from "@/lib/communication/conversation-key";

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";

function account(over: Partial<AccountCandidate> & { id: string }): AccountCandidate {
  return { email: null, phone: null, phoneVerified: false, linked: true, ...over };
}

describe("deriveConversationKey - account, verified phone, email", () => {
  it("an account linked to the workspace beats phone and email", () => {
    const result = deriveConversationKey({
      email: "Resident@Example.com",
      phone: "(510) 555-1234",
      accounts: [account({ id: A, email: "resident@example.com", phone: "+15105551234", phoneVerified: true })],
    });
    expect(result.key).toBe(accountKey(A));
    expect(result.kind).toBe("account");
    // The same person may already be stored under the weaker keys: look those up too.
    expect(result.keys).toEqual([accountKey(A), phoneKey("+15105551234"), emailKey("resident@example.com")]);
    expect(result.flagged).toBeNull();
  });

  it("an account NOT linked to this workspace is not the person: phone, then email", () => {
    const withPhone = deriveConversationKey({
      email: "r@example.com",
      phone: "5105551234",
      accounts: [account({ id: A, email: "r@example.com", linked: false })],
    });
    expect(withPhone.key).toBe(phoneKey("+15105551234"));
    expect(withPhone.keys).toEqual([phoneKey("+15105551234")]);

    const emailOnly = deriveConversationKey({
      email: "r@example.com",
      accounts: [account({ id: A, email: "r@example.com", linked: false })],
    });
    expect(emailOnly.key).toBe(emailKey("r@example.com"));
  });

  it("an UNVERIFIED phone never links a person to an account", () => {
    const result = deriveConversationKey({
      phone: "+15105551234",
      accounts: [account({ id: A, email: "r@example.com", phone: "+15105551234", phoneVerified: false })],
    });
    expect(result.key).toBe(phoneKey("+15105551234"));
    expect(result.kind).toBe("phone");
    expect(result.keys).not.toContain(accountKey(A));
    expect(result.flagged).toBeNull();
  });

  it("an unverified phone on an email-named account is not folded into that account's thread", () => {
    const result = deriveConversationKey({
      email: "r@example.com",
      phone: "+15105551234",
      accounts: [account({ id: A, email: "r@example.com", phone: "+15105551234", phoneVerified: false })],
    });
    expect(result.key).toBe(accountKey(A));
    // A phone-keyed conversation belongs to whoever holds the number, not to this account.
    expect(result.keys).toEqual([accountKey(A), emailKey("r@example.com")]);
    expect(result.keys).not.toContain(phoneKey("+15105551234"));
  });

  it("a phone verified by exactly one linked account joins that account", () => {
    const result = deriveConversationKey({
      phone: "510-555-1234",
      accounts: [account({ id: A, email: "r@example.com", phone: "(510) 555-1234", phoneVerified: true })],
    });
    expect(result.key).toBe(accountKey(A));
    expect(result.keys).toEqual([accountKey(A), phoneKey("+15105551234"), emailKey("r@example.com")]);
  });

  it("two accounts that verified the same phone: nothing merges, the conversation is flagged", () => {
    const result = deriveConversationKey({
      phone: "+15105551234",
      accounts: [
        account({ id: A, phone: "+15105551234", phoneVerified: true }),
        account({ id: B, phone: "5105551234", phoneVerified: true }),
      ],
    });
    expect(result.key).toBe(phoneKey("+15105551234"));
    expect(result.keys).toEqual([phoneKey("+15105551234")]);
    expect(result.flagged).toEqual({
      reason: "ambiguous_phone",
      accountIds: [A, B],
      phone: "+15105551234",
    });
  });

  it("a phone and an email on one record are not fused into one identity without an account", () => {
    const result = deriveConversationKey({ email: "p@example.com", phone: "+12065550100", accounts: [] });
    expect(result.key).toBe(phoneKey("+12065550100"));
    expect(result.keys).toEqual([phoneKey("+12065550100")]);
  });

  it("email is the last resort and is lower-cased", () => {
    const result = deriveConversationKey({ email: "  Person@Example.COM ", accounts: [] });
    expect(result).toMatchObject({ key: "mail:person@example.com", kind: "email" });
  });

  it("a half-typed phone is not a phone: it falls through to the email", () => {
    const result = deriveConversationKey({ email: "p@example.com", phone: "+1206555", accounts: [] });
    expect(result.key).toBe(emailKey("p@example.com"));
  });

  it("an explicit account id wins when the id and the email name different accounts, and it is flagged", () => {
    const result = deriveConversationKey({
      accountId: A,
      email: "other@example.com",
      accounts: [account({ id: A, email: "a@example.com" }), account({ id: B, email: "other@example.com" })],
    });
    expect(result.key).toBe(accountKey(A));
    expect(result.flagged?.reason).toBe("identity_conflict");
    expect(result.flagged?.accountIds.sort()).toEqual([A, B]);
  });

  it("another account's verified phone does not hijack an email-named account", () => {
    const result = deriveConversationKey({
      email: "a@example.com",
      phone: "+15105551234",
      accounts: [
        account({ id: A, email: "a@example.com" }),
        account({ id: B, phone: "+15105551234", phoneVerified: true }),
      ],
    });
    expect(result.key).toBe(accountKey(A));
    expect(result.keys).not.toContain(phoneKey("+15105551234"));
    expect(result.flagged?.reason).toBe("identity_conflict");
  });

  it("no identity at all means no key (the writer keeps the legacy thread)", () => {
    expect(deriveConversationKey({ accounts: [] })).toEqual({ key: null, kind: null, keys: [], flagged: null });
    expect(deriveConversationKey({ email: "not-an-email", phone: "12", accounts: [] }).key).toBeNull();
  });

  it("key helpers round-trip their kind", () => {
    expect(conversationKeyKind(accountKey(A))).toBe("account");
    expect(conversationKeyKind(phoneKey("+15105551234"))).toBe("phone");
    expect(conversationKeyKind(emailKey("a@b.co"))).toBe("email");
    expect(conversationKeyKind(workspaceKey("w1"))).toBe("workspace");
    expect(conversationKeyKind("garbage")).toBeNull();
    expect(PERSONAL_WORKSPACE_ID).toBe("00000000-0000-0000-0000-000000000000");
  });
});

describe("threadMatchesRecipient - the server reply check", () => {
  it("a keyed thread matches only a recipient who resolves to that key", () => {
    expect(
      threadMatchesRecipient({ threadKey: accountKey(A), recipientKeys: [accountKey(A), emailKey("a@x.co")], recipientEmail: "a@x.co" }),
    ).toBe(true);
    expect(
      threadMatchesRecipient({ threadKey: accountKey(A), recipientKeys: [accountKey(B)], recipientEmail: "b@x.co" }),
    ).toBe(false);
  });

  it("an unkeyed legacy thread is judged by the email it was stored under, never waved through", () => {
    expect(threadMatchesRecipient({ threadEmail: "A@X.co", recipientKeys: [], recipientEmail: "a@x.co" })).toBe(true);
    expect(threadMatchesRecipient({ threadEmail: "a@x.co", recipientKeys: [], recipientEmail: "b@x.co" })).toBe(false);
    expect(threadMatchesRecipient({ threadEmail: "", recipientKeys: [], recipientEmail: "b@x.co" })).toBe(false);
  });
});
