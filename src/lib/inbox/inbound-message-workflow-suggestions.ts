/**
 * Manager-inbox chips ("Create maintenance work order" / "Create add-on service
 * request") offered on an inbound resident message.
 *
 * This module owns only the PRESENTATION. Whether a message is asking for
 * something at all is `classifyInboundMessage` in `inbound-message-intent.ts`,
 * which the server pass also uses — one decision, so a chip a manager sees and
 * a proposal the server files can never disagree about the same message.
 */
import {
  INTENT_MIN_CONFIDENCE,
  classifyInboundMessage,
  workflowTitleFromMessage,
} from "@/lib/inbox/inbound-message-intent";

export type InboundWorkflowSuggestionKind = "maintenance_work_order" | "addon_service";

export type InboundWorkflowSuggestion = {
  kind: InboundWorkflowSuggestionKind;
  label: string;
};

export { workflowTitleFromMessage };

/** Suggest manager workflows from the latest inbound resident message. */
export function suggestInboundMessageWorkflows(messageText: string): InboundWorkflowSuggestion[] {
  const result = classifyInboundMessage(messageText);
  if (result.confidence < INTENT_MIN_CONFIDENCE) return [];

  if (result.intent === "maintenance") {
    return [
      {
        kind: "maintenance_work_order",
        label:
          result.urgency === "emergency"
            ? "Create urgent maintenance work order"
            : "Create maintenance work order",
      },
    ];
  }
  if (result.intent === "add_on_service") {
    return [{ kind: "addon_service", label: "Create add-on service request" }];
  }
  return [];
}
