import type { CoordinationProposal, CoordinationQuote } from "@/lib/vendor-coordination";
export function coordinationQuote(p: CoordinationProposal): CoordinationQuote | null {
  return p.scope && p.labor_cents !== null && p.materials_cents !== null && p.consultation_fee_cents !== null
    ? { laborCents: p.labor_cents, materialsCents: p.materials_cents, consultationFeeCents: p.consultation_fee_cents, scope: p.scope, exclusions: p.exclusions ?? "" } : null;
}
