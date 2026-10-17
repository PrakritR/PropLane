import { after } from "next/server";

/**
 * Runs best-effort work once the response has gone out (Next's `after()`), so a write never waits
 * on the notices it raises. Outside a request scope (a script, a unit test) `after` is unavailable
 * and the work simply runs now, still unawaited by the caller. Failures are swallowed by design:
 * the row is already saved and a notice that cannot go out must never undo or fail it.
 */
export function afterResponse(task: () => Promise<unknown>, label: string): void {
  const run = () =>
    task().catch((error) => console.warn(`[${label}] after-response task failed`, error instanceof Error ? error.message : String(error)));
  try {
    after(run);
  } catch {
    void run();
  }
}
