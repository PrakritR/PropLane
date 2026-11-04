/** The persisted coordination record is owned by the server, never by a client snapshot. */
export type VisitType = "consultation" | "repair";
export type VisitWindow = { startIso: string; endIso: string };
export type CoordinationQuote = {
  laborCents: number;
  materialsCents: number;
  consultationFeeCents: number;
  scope: string;
  exclusions: string;
};

export type CoordinationProposal = {
  id: string;
  work_order_id: string;
  manager_user_id: string;
  vendor_directory_id: string;
  vendor_user_id: string | null;
  visit_type: VisitType;
  version: number;
  quote_revision: number;
  status: "collecting" | "ready" | "approved" | "declined" | "cancelled";
  labor_cents: number | null;
  materials_cents: number | null;
  consultation_fee_cents: number | null;
  scope: string | null;
  exclusions: string | null;
  duration_minutes: number | null;
  vendor_windows: VisitWindow[];
  resident_windows: VisitWindow[];
  selected_start_at: string | null;
  vendor_confirmed_revision: number | null;
  resident_confirmed_revision: number | null;
  revision_reason: string | null;
  manager_takeover: boolean;
  takeover_reason: string | null;
  takeover_at: string | null;
  source_message_ids: string[];
};

export type CoordinationAction =
  | { kind: "enroll"; work_order_id: string; vendor_directory_id: string; visit_type: VisitType; manager_user_id: string; actor_user_id: string; source_message_id?: string }
  | {
      kind: "revise_quote" | "submit_vendor_windows" | "submit_resident_windows" | "select_time" | "confirm_vendor" | "confirm_resident" | "approve_manager" | "decline_manager" | "cancel" | "request_revision" | "take_over";
      proposal_id: string;
      expected_version: number;
      actor_user_id?: string;
      resident_email?: string;
      vendor_directory_id?: string;
      verified_phone_e164?: string;
      quote?: CoordinationQuote;
      duration_minutes?: number;
      windows?: VisitWindow[];
      selected_start_iso?: string;
      source_message_id?: string;
      reason?: string;
    };

function cents(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000_000) {
    throw new Error("Invalid amount in cents");
  }
  return value;
}

/** Consultation fees belong only to consultation visits, never to repair totals. */
export function quoteTotalCents(visitType: VisitType, quote: CoordinationQuote): number {
  const total = visitType === "consultation"
    ? cents(quote.consultationFeeCents)
    : cents(quote.laborCents) + cents(quote.materialsCents);
  return cents(total);
}

function normalizeWindow(window: VisitWindow): [number, number] {
  const start = Date.parse(window.startIso);
  const end = Date.parse(window.endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
    throw new Error("Invalid visit window");
  }
  return [start, end];
}

/** Candidate intervals are UTC instants. Local DST conversion happens at input boundaries. */
export function intersectVisitWindows(
  vendorWindows: VisitWindow[],
  residentWindows: VisitWindow[],
  busyWindows: VisitWindow[],
  durationMinutes: number,
): VisitWindow[] {
  if (!Number.isSafeInteger(durationMinutes) || durationMinutes < 15 || durationMinutes > 480) {
    throw new Error("Invalid visit duration");
  }
  const duration = durationMinutes * 60_000;
  const busy = busyWindows.map(normalizeWindow);
  const candidates: Array<[number, number]> = [];
  for (const vendor of vendorWindows.map(normalizeWindow)) {
    for (const resident of residentWindows.map(normalizeWindow)) {
      const intersection: [number, number] = [Math.max(vendor[0], resident[0]), Math.min(vendor[1], resident[1])];
      if (intersection[1] - intersection[0] < duration) continue;
      let fragments = [intersection];
      for (const blocked of busy) {
        fragments = fragments.flatMap(([start, end]): Array<[number, number]> => {
          if (blocked[1] <= start || blocked[0] >= end) return [[start, end]];
          const result: Array<[number, number]> = [];
          if (blocked[0] - start >= duration) result.push([start, blocked[0]]);
          if (end - blocked[1] >= duration) result.push([blocked[1], end]);
          return result;
        });
      }
      candidates.push(...fragments.filter(([start, end]) => end - start >= duration));
    }
  }
  const unique = new Map(candidates.map(([start, end]) => [`${start}:${end}`, { startIso: new Date(start).toISOString(), endIso: new Date(end).toISOString() }]));
  return [...unique.values()].sort((a, b) => a.startIso.localeCompare(b.startIso));
}
