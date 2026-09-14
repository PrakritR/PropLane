/**
 * The dispatcher must actually run at its own tick.
 *
 * `src/app/api/cron/dispatch-reminders/route.ts` and `MIN_TIMING_MINUTES` both
 * assume a 5-minute cron. Nothing before this test caught `vercel.json`
 * drifting to a once-a-day schedule while every sub-daily reminder timing in
 * the product stayed configurable — the setting would silently never fire,
 * only ever able to land on the next daily tick.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MIN_TIMING_MINUTES, REMINDER_DISPATCH_CRON, REMINDER_DISPATCH_INTERVAL_MINUTES } from "@/lib/reminders/timings";

const DISPATCH_PATH = "/api/cron/dispatch-reminders";

function readVercelCronSchedule(): string {
  const vercelJsonPath = path.resolve(process.cwd(), "vercel.json");
  const raw = readFileSync(vercelJsonPath, "utf8");
  const parsed = JSON.parse(raw) as { crons?: Array<{ path?: string; schedule?: string }> };
  const entry = (parsed.crons ?? []).find((cron) => cron.path === DISPATCH_PATH);
  if (!entry) throw new Error(`vercel.json has no cron entry for ${DISPATCH_PATH}`);
  return String(entry.schedule ?? "");
}

describe("the reminder dispatcher's cron matches its own tick", () => {
  it("vercel.json schedules dispatch-reminders at REMINDER_DISPATCH_CRON", () => {
    const schedule = readVercelCronSchedule();
    expect(
      schedule,
      "vercel.json's cron for /api/cron/dispatch-reminders no longer matches REMINDER_DISPATCH_CRON " +
        "(src/lib/reminders/timings.ts). A mismatch here means every sub-daily reminder timing in the " +
        "product silently never fires — a queued row just waits for the next tick, which for anything " +
        "shorter than that tick never comes before the event it was announcing.",
    ).toBe(REMINDER_DISPATCH_CRON);
  });

  it("MIN_TIMING_MINUTES can never be shorter than the dispatcher's own tick", () => {
    expect(
      MIN_TIMING_MINUTES,
      "a timing shorter than the dispatch interval can never be honoured — the queued send time would " +
        "always fall between two ticks.",
    ).toBeGreaterThanOrEqual(REMINDER_DISPATCH_INTERVAL_MINUTES);
  });
});
