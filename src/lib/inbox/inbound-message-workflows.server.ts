/**
 * One post-persist hook: a resident asked for something in a message, so file
 * it instead of making a human retype it. (PRP-109)
 *
 * Inbound SMS has done this since the Claw work — `runResidentSmsAction` calls
 * `createWorkOrderFromResidentSms` / `createServiceRequestFromResidentSms`. What
 * was missing is that the SAME sentence typed into the portal inbox did
 * nothing, so which channel a resident happened to use decided whether their
 * manager got a work order. This module is the shared seam that closes that
 * gap, and the place any further channel (inbound email) plugs into.
 *
 * Design constraints, all inherited rather than invented:
 *
 * - **It never decides intent itself.** `classifyInboundMessage` is the one
 *   decision, shared with the manager inbox chips and the SMS gate.
 * - **It never writes directly.** The two creators own their own dedupe
 *   (near-identical text from the same resident inside a short window is a
 *   no-op) and their own manager notification. A thread where someone repeats
 *   "the sink is still leaking" must not open a second work order.
 * - **The identity is the CALLER's, never the message's.** `managerUserId` and
 *   `residentEmail` come from the authenticated session and the thread the
 *   route already authorized. Nothing here reads a name, address, or id out of
 *   the message body — resident text is untrusted input.
 * - **It must never break the send.** A message that was accepted is delivered;
 *   filing a work order off the back of it is best-effort. Every failure is
 *   swallowed and reported in the result, so a caller in `after()` cannot turn
 *   a classifier bug into a failed reply or a webhook retry.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { classifyInboundMessage } from "@/lib/inbox/inbound-message-intent";
import { managerIdsOwningResident } from "@/lib/resident-manager-scope";
import { createWorkOrderFromResidentSms } from "@/lib/claw-maintenance-work-order.server";
import { createServiceRequestFromResidentSms } from "@/lib/claw-service-request-sms.server";

export type InboundWorkflowChannel = "portal" | "sms" | "email";

export type InboundWorkflowOutcome =
  | { filed: "work_order"; id: string; title: string; alreadyOpen: boolean }
  | { filed: "service_request"; id: string; title: string; alreadyOpen: boolean }
  | { filed: "none"; reason: "not_a_request" | "missing_context" | "create_failed" };

export type InboundWorkflowInput = {
  /** Owning manager, resolved from the authorized thread — never from the body. */
  managerUserId: string;
  /** The authenticated sender's email, lowercased by the creators. */
  residentEmail: string;
  residentUserId?: string | null;
  residentName?: string | null;
  /** The message the resident actually sent. */
  text: string;
  channel: InboundWorkflowChannel;
};

/**
 * File a work order or add-on service request if the message asks for one.
 *
 * Returns what happened rather than throwing, so a caller can log it without a
 * try/catch of its own. `filed: "none"` is the common, healthy case — most
 * messages are not requests.
 */
export async function fileWorkflowFromInboundMessage(
  input: InboundWorkflowInput,
): Promise<InboundWorkflowOutcome> {
  const managerUserId = String(input.managerUserId ?? "").trim();
  const residentEmail = String(input.residentEmail ?? "").trim();
  const text = String(input.text ?? "").trim();
  if (!managerUserId || !residentEmail || !text) {
    return { filed: "none", reason: "missing_context" };
  }

  const intent = classifyInboundMessage(text);
  if (intent.intent === "none") return { filed: "none", reason: "not_a_request" };

  try {
    if (intent.intent === "maintenance") {
      const result = await createWorkOrderFromResidentSms({
        managerUserId,
        // Channel-neutral despite the name: the creator requires only the
        // manager, the resident's email, and the text. An in-app sender has no
        // phone in scope and does not need one.
        residentPhone: "",
        residentUserId: input.residentUserId ?? null,
        residentEmail,
        text,
        // The heuristic already ran, above, as the shared classifier. Running
        // the creator's copy of it again would be the same call twice.
        skipIntentCheck: true,
      });
      if ("error" in result) return { filed: "none", reason: "create_failed" };
      return {
        filed: "work_order",
        id: String(result.workOrderId ?? ""),
        title: String(result.title ?? ""),
        alreadyOpen: Boolean(result.alreadyOpen),
      };
    }

    const result = await createServiceRequestFromResidentSms({
      managerUserId,
      residentEmail,
      residentUserId: input.residentUserId ?? null,
      residentName: input.residentName ?? null,
      text,
    });
    if ("error" in result) return { filed: "none", reason: "create_failed" };
    return {
      filed: "service_request",
      id: String(result.requestId ?? ""),
      title: String(result.title ?? ""),
      alreadyOpen: Boolean("alreadyOpen" in result && result.alreadyOpen),
    };
  } catch {
    // Best-effort by contract: the message is already delivered, and no
    // classifier or storage failure may fail the send or retry a webhook.
    return { filed: "none", reason: "create_failed" };
  }
}

/**
 * Same as above, but for a channel that cannot tell which way the message is
 * travelling — inbound email.
 *
 * A portal reply token identifies the person who sent the ORIGINAL mail, not
 * the roles of the two parties. When a manager emails a resident, the token
 * owner is the manager and the replier is the resident (file it). When the
 * resident emailed first and the MANAGER replies, the owner is the resident and
 * the replier is the manager — filing there would open a work order against the
 * manager's own words, attributed to them as if they were a tenant.
 *
 * So the direction is verified, not assumed: file only when the claimed manager
 * genuinely manages the claimed resident. On any doubt — a failed read
 * included — nothing is filed. A missed work order is a message a human still
 * reads; a wrong one is a job dispatched at somebody's cost.
 */
export async function fileWorkflowFromInboundEmailReply(
  db: SupabaseClient,
  input: {
    /** Portal reply-token owner: only sometimes the manager. */
    ownerUserId: string;
    /** Whoever sent the email that just arrived. */
    replierEmail: string;
    replierName?: string | null;
    text: string;
  },
): Promise<InboundWorkflowOutcome> {
  const ownerUserId = String(input.ownerUserId ?? "").trim();
  const replierEmail = String(input.replierEmail ?? "").trim().toLowerCase();
  const text = String(input.text ?? "").trim();
  if (!ownerUserId || !replierEmail || !text) {
    return { filed: "none", reason: "missing_context" };
  }

  // Cheap check first: most email replies are not requests at all, and this
  // saves the ownership read on every one of them.
  if (classifyInboundMessage(text).intent === "none") {
    return { filed: "none", reason: "not_a_request" };
  }

  let managerIds: string[] = [];
  try {
    managerIds = await managerIdsOwningResident(db, replierEmail);
  } catch {
    return { filed: "none", reason: "create_failed" };
  }
  if (!managerIds.includes(ownerUserId)) {
    // The replier is not this owner's resident — most often because the owner
    // IS the resident and a manager is replying. Not our direction.
    return { filed: "none", reason: "not_a_request" };
  }

  return fileWorkflowFromInboundMessage({
    managerUserId: ownerUserId,
    residentEmail: replierEmail,
    residentName: input.replierName ?? null,
    text,
    channel: "email",
  });
}
