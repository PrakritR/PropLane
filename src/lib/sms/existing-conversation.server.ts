import "server-only";

import type { fetchManagerSmsConversations } from "@/lib/manager-sms-messages.server";
import { conversationPhoneRef, type SmsCounterpartyRole } from "@/lib/sms-conversation-identity";

export type ExistingSmsConversation = {
  conversationKey: string;
  counterpartyRole: SmsCounterpartyRole;
};

export type ExistingSmsConversationResolution =
  | { kind: "matched"; conversation: ExistingSmsConversation }
  | { kind: "missing" }
  | { kind: "ambiguous" }
  | { kind: "sender_unavailable" };

/**
 * Reuse a durable work-number thread only when its owner, current recipient
 * phone, sender work number, and permitted role are exact and unambiguous.
 * Directory-only/contact rows are excluded: at least one real message must
 * prove this owner-to-recipient number pair.
 */
export function resolveExistingSmsConversation(
  rows: Awaited<ReturnType<typeof fetchManagerSmsConversations>>["residents"],
  args: {
    managerUserId: string;
    recipientPhone: string;
    workNumber: string | null;
    allowedRoles: readonly SmsCounterpartyRole[];
  },
): ExistingSmsConversationResolution {
  const owner = args.managerUserId.trim();
  const phone = conversationPhoneRef(args.recipientPhone);
  const workNumber = conversationPhoneRef(args.workNumber);
  if (!owner || !phone) return { kind: "missing" };
  if (!workNumber) return { kind: "sender_unavailable" };
  const allowedRoles = new Set(args.allowedRoles);
  const candidates = rows.filter((row) =>
    String(row.ownerManagerUserId ?? "").trim() === owner &&
    conversationPhoneRef(row.phone) === phone &&
    Boolean(row.conversationKey) &&
    Boolean(row.counterpartyRole && allowedRoles.has(row.counterpartyRole)) &&
    row.messages.some((message) =>
      message.direction === "inbound"
        ? conversationPhoneRef(message.fromPhone) === phone && conversationPhoneRef(message.toPhone) === workNumber
        : conversationPhoneRef(message.toPhone) === phone && conversationPhoneRef(message.fromPhone) === workNumber,
    ),
  );
  const matches = [...new Map(candidates.map((row) => [row.conversationKey!, row])).values()];
  if (matches.length === 0) return { kind: "missing" };
  if (matches.length > 1) return { kind: "ambiguous" };
  const match = matches[0]!;
  return {
    kind: "matched",
    conversation: {
      conversationKey: match.conversationKey!,
      counterpartyRole: match.counterpartyRole!,
    },
  };
}

