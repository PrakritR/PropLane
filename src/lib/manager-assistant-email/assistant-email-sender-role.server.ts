import "server-only";

/**
 * Who wrote to a manager's work email, and therefore which assistant answers.
 *
 * The work address used to accept mail from the manager (or an accepted
 * co-manager) and NOTHING else: every other sender fell out of
 * `resolveManagerEmailInboundIdentity` as `null` and the message was dropped
 * without a reply, without reaching Communication, and — because the inbound id
 * is claimed BEFORE that gate — without any chance of a redelivery bringing it
 * back. A prospect or a resident emailing the address simply vanished.
 *
 * Three senders, three different assistants, because the right answer depends
 * entirely on who is asking:
 *
 * - `manager`   — the owner or a delegated co-manager. Full portfolio assistant.
 * - `resident`  — a CURRENT resident of this manager, answered with their own
 *                 lease, charges and services in scope.
 * - `prospect`  — anyone else: a leasing enquiry about the public catalog.
 *
 * The order is the security property and must not be rearranged. Manager is
 * checked first because a manager who also rents somewhere must not be demoted
 * to a resident view of their own mailbox; resident is checked before prospect
 * because a resident asking about their lease must not be answered from the
 * public catalog. Every branch derives identity from the SENDER ADDRESS and the
 * mailbox owner, never from anything written in the message body — inbound mail
 * is untrusted text that may contain prompt-injection attempts.
 *
 * A `From` header is spoofable. That is why `prospect` is the fallback and not
 * an error: it is the LEAST privileged of the three, so a forged sender can only
 * ever reach the public leasing catalog. The two privileged roles still require
 * a matching profile row that the manager owns.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  resolveManagerEmailInboundIdentity,
  type ManagerEmailInboundIdentity,
} from "@/lib/manager-assistant-email/manager-email-access.server";
import { resolveResidentInboxAgentContext } from "@/lib/tools/resident-inbox-context";
import type { ResidentAgentContext } from "@/lib/tools/resident-context";

export type AssistantEmailSenderRole = "manager" | "resident" | "prospect";

export type AssistantEmailSender =
  | { role: "manager"; identity: ManagerEmailInboundIdentity }
  | { role: "resident"; ctx: ResidentAgentContext }
  | { role: "prospect" };

export async function classifyAssistantEmailSender(
  db: SupabaseClient,
  args: { managerUserId: string; fromEmail: string },
): Promise<AssistantEmailSender> {
  const managerUserId = args.managerUserId.trim();
  const fromEmail = args.fromEmail.trim().toLowerCase();
  if (!managerUserId || !fromEmail.includes("@")) return { role: "prospect" };

  const identity = await resolveManagerEmailInboundIdentity(db, {
    workNumberOwnerId: managerUserId,
    fromEmail,
  });
  if (identity) return { role: "manager", identity };

  /*
   * Tenant-bound by construction: this resolves a resident ONLY against the
   * manager who owns the mailbox that was written to, so an address that
   * belongs to some other manager's resident does not get resident scope here.
   * Any failure reason — not a resident, not linked to this manager, or a
   * lookup error — falls through to the public leasing assistant rather than
   * guessing, so a read error can never widen access.
   */
  const resident = await resolveResidentInboxAgentContext(db, {
    residentEmail: fromEmail,
    ownerManagerUserId: managerUserId,
  });
  if (resident.ok) return { role: "resident", ctx: resident.ctx };

  return { role: "prospect" };
}
