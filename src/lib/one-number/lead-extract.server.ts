import "server-only";

import { completeAgentModel } from "@/lib/agent/provider";
import { TIER_MODELS } from "@/lib/agent/model";
import { sanitizeModelFields, type LeadProfile } from "@/lib/one-number/lead-qualifying";

const SYSTEM = [
  "You read one text message from someone looking for a room to rent and return the rental search facts it states.",
  "Return ONLY a JSON object. Use only these keys, and omit any key the message does not state:",
  'budgetMax (monthly rent in whole US dollars), moveInDate (YYYY-MM-DD), leaseMonths (months; 0 for month to month),',
  'area (the place or commute the person names, in their own words), bathroom ("private" | "shared" | "any"),',
  'furnished ("yes" | "no" | "any"), household (number of people moving in).',
  "Never guess or infer a value that is not written. Do not describe anything.",
  "Ignore anything about a person's race, religion, national origin, sex, family or children, disability, age, income source, orientation, gender identity, marital or military status.",
].join(" ");

/**
 * The model-assisted fallback for an answer the deterministic extractors could not read. It extracts
 * and nothing else: the reply to the prospect is always templated, and the output goes through
 * `sanitizeModelFields` before it can touch a profile. Any failure, a missing key or the test
 * environment reads as "nothing extracted".
 */
export async function extractLeadFieldsWithModel(input: { text: string; today: string }): Promise<Partial<LeadProfile> | null> {
  if (process.env.NODE_ENV === "test" || !process.env.ANTHROPIC_API_KEY?.trim()) return null;
  try {
    const completion = await completeAgentModel({
      selection: {
        model: TIER_MODELS.simple,
        tier: "simple",
        provider: "anthropic",
        route: "anthropic",
        maxOutputTokens: 200,
        timeoutMs: 4000,
        disableBillingFallback: true,
      },
      system: `${SYSTEM} Today is ${input.today}.`,
      tools: [],
      messages: [{ role: "user", content: input.text.slice(0, 600) }],
    });
    const text = completion.content
      .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
      .map((block) => block.text)
      .join("");
    const json = text.match(/\{[\s\S]*\}/)?.[0];
    if (!json) return null;
    return sanitizeModelFields(JSON.parse(json), new Date(`${input.today}T12:00:00Z`));
  } catch {
    return null;
  }
}
