import type { DemoApplicantRow } from "@/data/demo-portal";
import { upsertApplicationRowToServerAwait } from "@/lib/manager-applications-storage";

/** Confirm negotiated rent on an already-approved placement before downstream work. */
export async function persistApprovalNegotiatedRent(row: DemoApplicantRow, rent: number): Promise<DemoApplicantRow | null> {
  if (!row.application || !Number.isFinite(rent) || rent <= 0) return null;
  const next = { ...row, application: { ...row.application, managerRentOverride: String(rent) } };
  const saved = await upsertApplicationRowToServerAwait(next, { timeoutMs: 20_000 });
  return saved.ok && saved.row?.id === row.id ? saved.row : null;
}
