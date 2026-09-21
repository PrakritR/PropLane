/**
 * SMS conversation identity — client-safe, pure.
 *
 * Historically a conversation was derived from the PHONE-NUMBER PAIR on the
 * wire (`sms_from_number` = To, `profiles.phone` = From). On a shared agent
 * line that pair collapses: every manager shares one `To` number, so the pair
 * can no longer say *which manager* nor *in what capacity* a person is writing.
 *
 * Conversation identity is now explicit and tied to the COUNTERPARTY
 * (person + role), not the numbers:
 *
 *   conversationKey = `${ownerManagerUserId}:${role}:${personRef}`
 *
 * where `personRef` is the counterparty's Axis user id when they have an
 * account, otherwise their normalized phone. Role splits the same person into
 * distinct threads when they wear different hats (a leasing prospect who later
 * becomes a resident is two conversations, by design), and — critically for
 * tenant isolation — two different people on one shared line always land in two
 * different keys because their `personRef` differs.
 */

export type SmsCounterpartyRole =
  | "resident"
  | "applicant"
  | "prospect"
  | "vendor"
  | "manager"
  | "admin"
  | "unknown";

export const SMS_COUNTERPARTY_ROLES: SmsCounterpartyRole[] = [
  "resident",
  "applicant",
  "prospect",
  "vendor",
  "manager",
  "admin",
  "unknown",
];

export function isSmsCounterpartyRole(value: unknown): value is SmsCounterpartyRole {
  return typeof value === "string" && (SMS_COUNTERPARTY_ROLES as string[]).includes(value);
}

export function coerceCounterpartyRole(value: unknown): SmsCounterpartyRole {
  return isSmsCounterpartyRole(value) ? value : "unknown";
}

/** Normalize a phone to `+<digits>` for use as a stable identity ref. */
export function conversationPhoneRef(raw: string | null | undefined): string {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return "";
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return trimmed;
  // US 10-digit → +1XXXXXXXXXX; 11-digit leading 1 → +1XXXXXXXXXX; else +digits
  // (an already-E.164 international number round-trips unchanged).
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
}

/**
 * The durable, explicit conversation key. `ownerManagerUserId` is the manager
 * who owns this side of the thread; the counterparty is a person (`user id`
 * preferred) in a `role`. When neither a user id nor a phone is known, the key
 * collapses to `role` alone so the row still threads somewhere deterministic
 * rather than fragmenting per-message.
 */
export function buildConversationKey(args: {
  ownerManagerUserId: string | null | undefined;
  role: SmsCounterpartyRole;
  counterpartyUserId?: string | null;
  counterpartyPhone?: string | null;
}): string {
  const owner = String(args.ownerManagerUserId ?? "").trim();
  const role = coerceCounterpartyRole(args.role);
  const userId = String(args.counterpartyUserId ?? "").trim();
  const personRef = userId || conversationPhoneRef(args.counterpartyPhone);
  return `${owner}:${role}:${personRef}`;
}

/**
 * One prospect identity decision for the leasing runner and its tour tools.
 * Authenticated SMS tests use the isolated session as their conversation ref;
 * actor ownership remains a separate fence in every test RPC.
 */
export function buildProspectConversationKey(args: {
  ownerManagerUserId: string | null | undefined;
  testSessionId?: string | null;
  counterpartyPhone?: string | null;
}): string {
  return buildConversationKey({
    ownerManagerUserId: args.ownerManagerUserId,
    role: "prospect",
    ...(String(args.testSessionId ?? "").trim()
      ? { counterpartyUserId: args.testSessionId }
      : { counterpartyPhone: args.counterpartyPhone }),
  });
}

/**
 * Best-effort role inference for legacy rows and read-time fallback, from the
 * signals already available without the persisted column: whether the
 * counterparty is a linked Axis account, their tenancy status, and the Claw
 * thread topic. Kept deliberately conservative — an unknown stays `unknown`
 * rather than being guessed into `resident` (which would over-merge threads).
 *
 * ORDER IS AN INVARIANT: the counterparty's own account linkage and tenancy are
 * per-person facts and are tested BEFORE the Claw thread topic, which is a
 * single mutable row per (manager, phone) overwritten on every thread touch.
 * Topic-first re-labels a current resident as `prospect` the moment their
 * latest thread is a leasing one, and the read path refuses to fold a prospect
 * thread into a named resident — so their history silently leaves the thread.
 */
export function deriveCounterpartyRole(args: {
  hasResidentUserId?: boolean;
  tenancyStatus?: "resident" | "applicant" | null;
  threadTopic?: string | null;
}): SmsCounterpartyRole {
  const topic = String(args.threadTopic ?? "").trim().toLowerCase();
  if (args.tenancyStatus === "applicant") return "applicant";
  if (args.tenancyStatus === "resident") return "resident";
  if (args.hasResidentUserId) return "resident";
  if (topic === "leasing") return "prospect";
  if (topic && topic !== "general") return "resident";
  return "unknown";
}

/** Human label for a role, for UI badges. */
export function counterpartyRoleLabel(role: SmsCounterpartyRole): string {
  switch (role) {
    case "resident":
      return "Resident";
    case "applicant":
      return "Applicant";
    case "prospect":
      return "Prospect";
    case "vendor":
      return "Vendor";
    case "manager":
      return "Manager";
    case "admin":
      return "Admin";
    default:
      return "Contact";
  }
}
