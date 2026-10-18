import { normalizeE164 } from "@/lib/phone-e164";

/** What a thread header and the Text line picker call the shared PropLane number. */
export const SHARED_LINE_LABEL = "PropLane line";

/**
 * The label of the line a conversation went through: "PropLane line" on the shared number,
 * else the work number it used, else `Line <n>`. The shared number is one number for every
 * team, so it never reads as a phone number a manager owns.
 */
export function textLineLabel(args: { sharedLine?: boolean; phone?: string | null; index: number }): string {
  if (args.sharedLine) return SHARED_LINE_LABEL;
  return args.phone?.trim() || `Line ${args.index + 1}`;
}

/**
 * The workspace of a conversation on the shared PropLane number, else null. The shared number has no
 * `manager_sms_numbers` row, so its projection rows carry it as `work_line_phone` and use the
 * workspace id as the synthetic `work_line_id`; readers that join the line to a number row find
 * nothing and must ask this instead.
 */
export function sharedLineWorkspaceIdOf(
  summary: { workLineId: string | null; workLinePhone: string | null },
  sharedNumber: string | null | undefined,
): string | null {
  const shared = normalizeE164(sharedNumber);
  const line = normalizeE164(summary.workLinePhone);
  return shared && line && shared === line && summary.workLineId ? summary.workLineId : null;
}
