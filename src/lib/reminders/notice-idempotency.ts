/**
 * The idempotency key of the PropLane Assistant notice a manager-side reminder becomes. One event gives ONE notice.
 *
 * A lease's follow-ups ("X has a lease at <house> 1 day ago") are queued from more than one anchor (the resident's
 * signature and the manager's own countersign) for the same lease, the same lead time and the same person; keyed on the
 * queue row they read as the same sentence twice. They are keyed on what the notice SAYS instead: the kind, the lease,
 * how long after, and who is told. Every other reminder keeps its own row id (a moved tour date is a new, wanted notice).
 */
export function reminderNoticeIdempotencyKey(
  row: { id: string; kind: string; subjectId: string; leadMinutes: number },
  recipientUserId: string,
): string {
  const followUp = (row.kind === "lease" || row.kind === "lease_manager") && row.leadMinutes < 0;
  if (!followUp) return row.id;
  return `reminder:${row.kind}:${row.subjectId.trim()}:${row.leadMinutes}:${recipientUserId.trim()}`;
}
