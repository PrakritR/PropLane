/**
 * Display-only money formatting for the Application/Lease list rows' glyph
 * facts (P001, P004, P007, P009) — never a source of truth, purely `cents ->
 * "$50"` for a row fact. The real amount is always read from
 * `manager-application-settings.ts` / `leasing-pipeline-preferences.ts`.
 */
export function formatFeeCentsForFact(cents: number): string {
  const whole = cents % 100 === 0;
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  }).format(cents / 100);
}
