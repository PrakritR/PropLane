/** First N sentences for the AI info sample-answer preview (matches studio replica). */
export function firstSentences(text: string, maxSentences: number): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const parts = trimmed.split(/(?<=[.!?])\s+/).filter(Boolean);
  return parts.slice(0, maxSentences).join(" ");
}

export const AI_INFO_BUILTIN_ROWS = [
  {
    key: "about" as const,
    title: "About this home",
    sampleQuestion: "What is this home like?",
    group: "home" as const,
  },
  {
    key: "tours" as const,
    title: "Tours & showings",
    sampleQuestion: "Can I come see it this weekend?",
    group: "leasing" as const,
  },
  {
    key: "rules" as const,
    title: "House rules & policies",
    sampleQuestion: "What are the house rules?",
    group: "rules" as const,
  },
  {
    key: "pricing" as const,
    title: "Pricing, deposits & lease terms",
    sampleQuestion: "What is the deposit and how long is the lease?",
    group: "leasing" as const,
  },
  {
    key: "neighborhood" as const,
    title: "Neighborhood & getting around",
    sampleQuestion: "What is the neighborhood like?",
    group: "area" as const,
  },
] as const;

export type AiInfoBuiltinKey = (typeof AI_INFO_BUILTIN_ROWS)[number]["key"];

export type AiInfoTabId = "home" | "leasing" | "rules" | "area" | "custom";

export const AI_INFO_TAB_DEFS: { id: AiInfoTabId; label: string; groups: AiInfoTabId[] }[] = [
  { id: "home", label: "Home", groups: ["home"] },
  { id: "leasing", label: "Leasing", groups: ["leasing"] },
  { id: "rules", label: "Rules", groups: ["rules"] },
  { id: "area", label: "Area", groups: ["area"] },
  { id: "custom", label: "Custom", groups: ["custom"] },
];

/** Category order for the one flat list, and the Category dropdown of a custom entry. */
export const AI_INFO_GROUP_OPTIONS: { id: AiInfoTabId; label: string }[] = [
  { id: "home", label: "Home" },
  { id: "leasing", label: "Leasing" },
  { id: "rules", label: "Rules" },
  { id: "area", label: "Area" },
  { id: "custom", label: "Other" },
];
