/**
 * Which reminder rule fields the dispatcher hardcodes for a subject, and why.
 *
 * A rule normally means what it says: the Settings UI shows what will happen.
 * `tour_interest` is the one exception — `normalizeReminderSettings` in
 * `rules.ts` force-overwrites its saved timing/audience/channels on every
 * read so the stored settings can never drift from what
 * `subjects/tour-interest.server.ts` actually sends (a single SMS, 24 hours
 * after the assistant's tour response, to the prospect who has no PropLane
 * inbox). Before this module existed, the Settings row let a manager "save" a
 * different timing or channel that was silently discarded on the next load —
 * a control that could never do what it showed.
 *
 * This is pure (no `server-only`, no server imports) so both the Settings UI
 * and `rules.ts` can import it without pulling server code into the browser.
 */
import type { ReminderSubjectKind } from "@/lib/reminders/rules";

export type FixedRuleField = "timings" | "audience" | "channels";

export type FixedRuleDeclaration = {
  fields: FixedRuleField[];
  /** Shown to the manager under the row, explaining why the control is disabled. */
  reason: string;
};

export const FIXED_RULE_FIELDS: Partial<Record<ReminderSubjectKind, FixedRuleDeclaration>> = {
  tour_interest: {
    fields: ["timings", "audience", "channels"],
    reason:
      "This follow-up is sent once, 24 hours later, as a text to the prospect who messaged you — they reached you by phone and have no PropLane inbox. You can edit the message; the timing and channel are fixed.",
  },
};

export function fixedRuleFields(kind: ReminderSubjectKind): FixedRuleDeclaration | null {
  return FIXED_RULE_FIELDS[kind] ?? null;
}

export function isRuleFieldFixed(kind: ReminderSubjectKind, field: FixedRuleField): boolean {
  return fixedRuleFields(kind)?.fields.includes(field) ?? false;
}
