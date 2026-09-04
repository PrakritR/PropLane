/**
 * Log a best-effort side effect that failed, instead of discarding it.
 *
 * Best-effort is right for DELIVERY and wrong for KNOWING. Losing a
 * notification is acceptable; losing the fact that a notification was lost is
 * not — a manager could receive no notice that an application had been
 * submitted, with no trace anywhere, while the applicant saw a success screen
 * and reasonably concluded they were ignored (PRP-209).
 *
 * `.catch(() => undefined)` reads as deliberate, so nobody revisits it. This is
 * the same non-blocking behaviour with the failure written down.
 *
 *   void notifyManagerApplicationSubmitted(db, row).catch(bestEffortFailed("application submitted notice", { id: row.id }));
 */
export function bestEffortFailed(
  what: string,
  context?: Record<string, string | number | null | undefined>,
): (error: unknown) => void {
  return (error: unknown) => {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    const where = context
      ? ` ${Object.entries(context)
          .filter(([, value]) => value !== undefined && value !== null && value !== "")
          .map(([key, value]) => `${key}=${value}`)
          .join(" ")}`
      : "";
    console.error(`[best-effort] ${what} failed${where} — ${detail}`);
  };
}
