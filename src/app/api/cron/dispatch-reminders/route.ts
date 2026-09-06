/**
 * Drain the reminder queue.
 *
 * Runs every 5 minutes — the piece that makes short lead times possible. Every
 * other reminder cron in this project is daily, which is why a "30 minutes
 * before" reminder could only ever arrive on the next daily tick, after the
 * event.
 *
 * Safe to run concurrently with itself: `claim_due_reminders` uses
 * `for update skip locked`, so two overlapping invocations take disjoint work.
 */
import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { dispatchDueReminders } from "@/lib/reminders/dispatch.server";
import { sweepTaskReminders } from "@/lib/reminders/subjects/tasks.server";
import { sweepApplicationReminders, sweepApplicationPostTourReminders } from "@/lib/reminders/subjects/applications.server";
import { sweepLeaseReminders } from "@/lib/reminders/subjects/leases.server";
import { sweepOutgoingPaymentReminders } from "@/lib/reminders/subjects/outgoing-payments.server";
import {
  sweepServiceOrderReminders,
  sweepWorkOrderReminders,
} from "@/lib/reminders/subjects/records.server";
import { sweepTourReminders } from "@/lib/reminders/subjects/tours.server";
import { sweepInspectionReminders } from "@/lib/reminders/subjects/inspections.server";
import { sweepBookingReminders } from "@/lib/reminders/subjects/bookings.server";
import { isProductionRuntime } from "@/lib/server-env";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const row = error as { message?: unknown; code?: unknown; details?: unknown; hint?: unknown };
    const parts = [row.message, row.code, row.details, row.hint]
      .map((part) => (typeof part === "string" ? part.trim() : ""))
      .filter(Boolean);
    if (parts.length > 0) return parts.join(" · ");
  }
  return "dispatch failed";
}

function isAuthorized(req: Request): boolean {
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (!cronSecret) {
    // Preview deployments are public and hold real service-role credentials.
    // Secretless access is only a localhost/test convenience.
    return !process.env.VERCEL_ENV && !isProductionRuntime();
  }
  return req.headers.get("authorization") === `Bearer ${cronSecret}`;
}

export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Identifies this run's lease so a run that dies mid-send can be reclaimed.
  const workerId = `dispatch-${randomUUID()}`;
  try {
    const db = createSupabaseServiceRoleClient();
    // Sweep first, then drain: a subject created since the last tick gets its
    // reminders queued and, if one is already due, sent in the same pass. A
    // sweep failure must not stop delivery of what is already queued, so it is
    // reported rather than thrown.
    let swept = 0;
    const sweepErrors: string[] = [];
    // One subject's sweep failing must not silence the others, so each is
    // isolated and reported by name rather than aborting the pass.
    for (const [name, sweep] of [
      ["tour", sweepTourReminders],
      ["task", sweepTaskReminders],
      ["work_order", sweepWorkOrderReminders],
      ["service_order", sweepServiceOrderReminders],
      ["application", sweepApplicationReminders],
      ["application_post_tour", sweepApplicationPostTourReminders],
      ["lease", sweepLeaseReminders],
      ["outgoing_payment", sweepOutgoingPaymentReminders],
      ["booking", sweepBookingReminders],
      ["inspection", sweepInspectionReminders],
    ] as const) {
      try {
        swept += await sweep(db);
      } catch (error) {
        sweepErrors.push(`${name}: ${describeError(error)}`);
      }
    }
    const summary = await dispatchDueReminders(db, workerId);
    return NextResponse.json({ ok: true, swept, ...(sweepErrors.length ? { sweepErrors } : {}), ...summary });
  } catch (error) {
    // A Supabase failure arrives as a plain PostgrestError object, not an
    // Error, so `instanceof Error` alone reports "dispatch failed" and throws
    // away the only diagnostic a cron nobody watches will ever produce.
    return NextResponse.json({ ok: false, error: describeError(error) }, { status: 500 });
  }
}
