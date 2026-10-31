import type { DemoApplicantRow } from "@/data/demo-portal";

/** True when the signed-in resident may view or edit this application row. */
export function residentOwnsApplicationRow(
  row: DemoApplicantRow,
  ctx: { email?: string | null; userId?: string | null },
  _opts?: { recordEmail?: string | null },
): boolean {
  void _opts;
  const linkedUserId = row.residentUserId?.trim();
  return Boolean(linkedUserId && ctx.userId && linkedUserId === ctx.userId);
}
