/**
 * The bounded, classified Google side of a planned-tour change.
 *
 * Confirm, cancel and reschedule all push the manager's linked Google Calendar
 * after the PropLane row has already been written and the guest already told.
 * This module is the ONE way they wait on that push, so the three paths cannot
 * disagree about two things:
 *
 * - **It is awaited, never fire-and-forget.** A serverless runtime can freeze
 *   the instance the moment the response is returned. Cancel learned that the
 *   hard way — a `void delete()` stranded the Google event as busy time that
 *   kept blocking the slot the cancel had just freed. Confirm had the mirror
 *   gap (PRP-397): a `void insert()` could return before Google ever heard of
 *   the tour, so the manager's calendar stayed empty for a tour PropLane had
 *   already emailed the guest about.
 * - **It is reported, never thrown.** The PropLane-side change succeeded, so a
 *   Google failure must not turn it into an error — but it cannot be swallowed
 *   either, because public availability subtracts Google busy time.
 */
import {
  GOOGLE_CALENDAR_WRITE_OPERATION_TIMEOUT_MS,
  isGoogleCalendarNotLinkedError,
} from "@/lib/google-calendar/api.server";

/**
 * Outcome of the manager's linked-Google-Calendar side of the change.
 * `skipped` means there is no working calendar link, which is not a failure.
 */
export type PlannedTourCalendarSync = { ok: boolean; skipped?: boolean; error?: string };

/**
 * Whole-operation ceiling on the Google side of a change.
 *
 * The shared ladder's WRITE budget, unmodified — already sized above the bounded
 * worst case of the calls below it (a token hop plus one API call) and tight
 * enough to leave the rest of the handler real headroom under the smallest
 * default platform function limit. Padding it here would eat that headroom, and
 * the platform kill it invites is the exact outcome this race exists to prevent:
 * the client reporting "could not reach the server" for a change that already
 * committed and a guest who was already emailed.
 *
 * Known gap, deliberately not widened here: the guest notification that runs
 * BEFORE this (Resend email, consent-gated SMS) is unbounded on every path.
 */
const CALENDAR_SYNC_BUDGET_MS = GOOGLE_CALENDAR_WRITE_OPERATION_TIMEOUT_MS;

/**
 * Run the Google side of a change and CLASSIFY the outcome, never throw it.
 *
 * "No working calendar link" is reported as SKIPPED, not as a failure: the
 * delete path throws for that state while the upsert path quietly returns null,
 * and without this the two would disagree — a manager who linked Google once and
 * later disconnected would be warned "your Google Calendar did not update" on
 * every cancel and told nothing on reschedule for the identical state.
 */
export async function runPlannedTourCalendarSync(
  run: () => Promise<unknown>,
): Promise<PlannedTourCalendarSync> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<PlannedTourCalendarSync>((resolve) => {
    timer = setTimeout(
      () => resolve({ ok: false, error: "Google Calendar did not respond in time." }),
      CALENDAR_SYNC_BUDGET_MS,
    );
  });
  try {
    return await Promise.race([
      Promise.resolve()
        .then(run)
        .then(
          () => ({ ok: true }),
          (e: unknown) => {
            if (isGoogleCalendarNotLinkedError(e)) return { ok: true, skipped: true };
            return { ok: false, error: e instanceof Error ? e.message : "Google Calendar update failed." };
          },
        ),
      deadline,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
