import { describe, expect, it } from "vitest";
import { resolveOutboxConversationKey, validatedOutboxConversationKey } from "@/lib/sms/owner-sms-dispatcher.server";

const base = {
  manager_user_id: "manager-1",
  recipient_phone: "+12065550142",
  recipient_user_id: null,
  counterparty_role: "prospect" as const,
};

describe("validatedOutboxConversationKey", () => {
  it("preserves a server-resolved prospect phone thread through outbound logging", () => {
    expect(validatedOutboxConversationKey({ ...base, conversation_key: "manager-1:prospect:+12065550142" }))
      .toBe("manager-1:prospect:+12065550142");
  });

  it("permits an existing applicant user-id thread but rejects a wrong owner, role, or recipient", () => {
    expect(validatedOutboxConversationKey({ ...base, recipient_user_id: "applicant-user", counterparty_role: "applicant", conversation_key: "manager-1:applicant:applicant-user" }))
      .toBe("manager-1:applicant:applicant-user");
    expect(validatedOutboxConversationKey({ ...base, conversation_key: "other:prospect:+12065550142" })).toBeNull();
    expect(validatedOutboxConversationKey({ ...base, conversation_key: "manager-1:resident:+12065550142" })).toBeNull();
    expect(validatedOutboxConversationKey({ ...base, conversation_key: "manager-1:prospect:+12065550999" })).toBeNull();
  });

  it("rejects a matching but non-canonical persisted role", () => {
    expect(validatedOutboxConversationKey({
      ...base,
      counterparty_role: "made_up_role" as never,
      conversation_key: "manager-1:made_up_role:+12065550142",
    })).toBeNull();
  });

  it("distinguishes an absent legacy key from an explicit invalid key", () => {
    expect(resolveOutboxConversationKey({ ...base, conversation_key: null })).toEqual({ kind: "absent", conversationKey: null });
    expect(resolveOutboxConversationKey({ ...base, conversation_key: "other:prospect:+12065550142" }))
      .toEqual({ kind: "invalid", conversationKey: null });
  });
});
