export type InboundWorkflowSuggestionKind = "maintenance_work_order" | "addon_service";

export type InboundWorkflowSuggestion = {
  kind: InboundWorkflowSuggestionKind;
  label: string;
};

const MAINTENANCE_PATTERNS = [
  /\bleak(s|ing)?\b/i,
  /\bbroken\b/i,
  /\brepair\b/i,
  /\bfix\b/i,
  /\bnot working\b/i,
  /\bmaintenance\b/i,
  /\bmold\b/i,
  /\bplumb(ing|er)\b/i,
  /\bhvac\b/i,
  /\bheat(er|ing)?\b/i,
  /\bac\b/i,
  /\belectrical\b/i,
  /\boutlet\b/i,
  /\bappliance\b/i,
  /\bclogged\b/i,
  /\btoilet\b/i,
  /\bfaucet\b/i,
  /\bwater damage\b/i,
  /\block(s|ed)?\b/i,
];

const ADDON_SERVICE_PATTERNS = [
  /\bparking\b/i,
  /\bstorage\b/i,
  /\badd[- ]?on\b/i,
  /\bextra key\b/i,
  /\bpet fee\b/i,
  /\bamenity\b/i,
  /\breserved spot\b/i,
  /\bgarage spot\b/i,
];

function matchesAny(text: string, patterns: RegExp[]) {
  return patterns.some((pattern) => pattern.test(text));
}

/** Suggest manager workflows from the latest inbound resident message. */
export function suggestInboundMessageWorkflows(messageText: string): InboundWorkflowSuggestion[] {
  const text = messageText.trim();
  if (!text) return [];

  const suggestions: InboundWorkflowSuggestion[] = [];
  if (matchesAny(text, MAINTENANCE_PATTERNS)) {
    suggestions.push({
      kind: "maintenance_work_order",
      label: "Create maintenance work order",
    });
  }
  if (matchesAny(text, ADDON_SERVICE_PATTERNS)) {
    suggestions.push({
      kind: "addon_service",
      label: "Create add-on service request",
    });
  }
  return suggestions;
}

/** Short title for a work order seeded from a message. */
export function workflowTitleFromMessage(messageText: string, fallback: string): string {
  const line = messageText.trim().split(/\n/)[0]?.trim() ?? "";
  if (!line) return fallback;
  return line.length > 80 ? `${line.slice(0, 77)}…` : line;
}
