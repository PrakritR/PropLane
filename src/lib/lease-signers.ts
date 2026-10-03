/**
 * "Who has signed" for a lease record: the resident (and every roommate on a joint lease),
 * then you. One row each — Sent Sep 24 / Signed Sep 29 with a Remind icon while the
 * resident has not signed; Waiting with a Sign button once only you are left.
 *
 * Pure over the lease rows, so the card, the tests and the Send/Remind actions agree on
 * who is still owed a signature.
 */
import { leaseAwaitingManagerCountersign, type LeasePipelineRow } from "@/lib/lease-pipeline-storage";

export type LeaseSignerRow = {
  id: string;
  role: "Resident" | "Roommate" | "You";
  name: string;
  state: "signed" | "sent" | "waiting";
  /** ISO moment of the signature (signed) or of sending (sent). */
  at: string | null;
  /** The one action this row offers. */
  action: "remind" | "sign" | null;
  /** Remind targets this roommate's own lease row on a joint lease. */
  leaseId: string;
};

function sentAt(row: LeasePipelineRow): string | null {
  return row.sentToResidentAt ?? (row.bucket === "manager" ? null : row.updatedAtIso) ?? null;
}

function residentRow(row: LeasePipelineRow, role: LeaseSignerRow["role"]): LeaseSignerRow {
  const signedAt = row.residentSignature?.signedAtIso ?? row.residentSignedAt ?? null;
  if (row.residentSignature || signedAt) {
    return { id: `${row.id}:resident`, role, name: row.residentName, state: "signed", at: signedAt, action: null, leaseId: row.id };
  }
  return { id: `${row.id}:resident`, role, name: row.residentName, state: "sent", at: sentAt(row), action: "remind", leaseId: row.id };
}

/**
 * `siblings` are the other leases of a joint shared-room lease (each roommate keeps their own
 * row so each signs in their own account); empty for an ordinary lease.
 */
export function leaseSignerRows(
  row: LeasePipelineRow,
  opts: { managerName?: string; siblings?: LeasePipelineRow[] } = {},
): LeaseSignerRow[] {
  // A draft has nothing to sign yet; a voided lease is not waiting on anyone.
  if (row.bucket === "manager" || row.status === "Voided") return [];
  const residents = [row, ...(opts.siblings ?? [])];
  const out: LeaseSignerRow[] = residents.map((r, i) => residentRow(r, i === 0 ? "Resident" : "Roommate"));
  const everyoneSigned = out.every((r) => r.state === "signed");
  const manager = row.managerSignature;
  if (manager) {
    out.push({ id: `${row.id}:manager`, role: "You", name: manager.name || opts.managerName || "Manager", state: "signed", at: manager.signedAtIso, action: null, leaseId: row.id });
  } else {
    out.push({
      id: `${row.id}:manager`,
      role: "You",
      name: opts.managerName || "Manager",
      state: "waiting",
      at: null,
      action: everyoneSigned && leaseAwaitingManagerCountersign(row) ? "sign" : null,
      leaseId: row.id,
    });
  }
  return out;
}

export function leaseSignersSummary(rows: LeaseSignerRow[]): { signed: number; total: number } {
  return { signed: rows.filter((r) => r.state === "signed").length, total: rows.length };
}
