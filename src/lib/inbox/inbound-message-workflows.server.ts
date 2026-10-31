/**
 * One post-persist hook: a resident asked for something in a message, so file
 * it instead of making a human retype it. (PRP-109)
 *
 * Inbound SMS has done this since the Claw work — `runResidentSmsAction` calls
 * `createWorkOrderFromResidentSms` / `createServiceRequestFromResidentSms`. What
 * was missing is that the SAME sentence typed into the portal inbox did
 * nothing, so which channel a resident happened to use decided whether their
 * manager got a work order. This module is the shared seam that closes that
 * gap. Inbound EMAIL does not plug into it: an email reply address proves neither the current
 * Auth subject nor a subject-bound residency, so nothing is filed from a mailbox.
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
import { classifyInboundMessage } from "@/lib/inbox/inbound-message-intent";
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
