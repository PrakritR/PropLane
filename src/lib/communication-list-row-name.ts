import { isAssistantAuthoredLabel } from "@/lib/sms-auto-reply";
import type { InboxScopedContact } from "@/data/inbox-scoped-directory";
import { inboxCounterpartyName } from "@/lib/manager-inbox-contacts";
import { formatSmsPhoneLabel } from "@/lib/phone-e164";
import { isPhoneLikeLabel } from "@/lib/manager-sms-messages";
import { smsNoticePhone } from "@/lib/sms-inbox-identity";
import type { PersistedInboxThread } from "@/lib/portal-inbox-storage";

/** Stored thread types that ARE a conversation with the PropLane Assistant. */
const ASSISTANT_CONVERSATION_TYPES = new Set(["agent_notice", "resident_agent", "vendor_agent"]);

/**
 * True only for a row that IS the Assistant chat, decided by what the row is
 * (its stored type or reserved id prefix) and never by the name on a turn.
 */
export function isAssistantConversationRow(thread: Pick<PersistedInboxThread, "id"> & { threadType?: string | null }): boolean {
  const type = String(thread.threadType ?? "");
  if (ASSISTANT_CONVERSATION_TYPES.has(type)) return true;
  const id = typeof thread.id === "string" ? thread.id : "";
  return id.startsWith("agent_notice_") || id.startsWith("resident-agent-");
}

/**
 * The list title of an inbox row. "PropLane Assistant" belongs to the Assistant
 * conversations alone. A person's or text conversation is titled by their
 * record name, else a readable phone, never by whoever wrote the last turn
 * (an auto-reply authored "You · Assistant" used to title the whole row).
 */
export function communicationListRowName(
  thread: PersistedInboxThread,
  contacts: readonly InboxScopedContact[] | null | undefined,
  opts: { useFrom: boolean },
): string {
  const assistantRow = isAssistantConversationRow(thread);
  const fromRaw = opts.useFrom ? thread.from : null;
  const from = !assistantRow && isAssistantAuthoredLabel(fromRaw) ? "" : fromRaw;
  const named = inboxCounterpartyName(thread.email, from, contacts);
  if (assistantRow) return named;
  const phone = smsNoticePhone(thread.smsNoticePhone || thread.from);
  if (!named || isAssistantAuthoredLabel(named)) return formatSmsPhoneLabel(phone) ?? "";
  // A raw "+14259849697" sender label reads as the number it is.
  return isPhoneLikeLabel(named) ? formatSmsPhoneLabel(named) ?? named : named;
}

/** A stored SMS notice row (`upsertManagerInboxNotice`): a text conversation's compatibility copy. */
export function isSmsNoticeInboxRow(thread: PersistedInboxThread): boolean {
  if (isAssistantConversationRow(thread)) return false;
  const type = String((thread as { threadType?: string | null }).threadType ?? "");
  return (
    type === "claw_leasing_sms" ||
    type === "claw_resident_sms" ||
    type === "sms_relay" ||
    Boolean(thread.smsNoticePhone?.trim()) ||
    (typeof thread.id === "string" && thread.id.startsWith("sms_notice_"))
  );
}
