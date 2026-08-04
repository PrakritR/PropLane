/**
 * 90-day grace for suspended manager work numbers.
 *
 * Downgrade to Free suspends send service immediately but keeps the Twilio
 * number assigned (people hand it out). After
 * {@link SMS_NUMBER_SUSPENSION_GRACE_DAYS} the daily sweep releases it at
 * Twilio and marks the row `released` so PropLane stops paying ~$1.15/mo.
 * A warning email goes out {@link SMS_NUMBER_SUSPENSION_WARN_DAYS_BEFORE}
 * days before release, and release REQUIRES that warning to have been delivered
 * that long ago — an unwarned number keeps its grace extended indefinitely
 * rather than disappearing silently from a manager's listings.
 *
 * Money safety: this module NEVER purchases numbers. Provider release is
 * best-effort via `releaseTwilioNumber` (no-ops without Twilio credentials,
 * so unit tests cannot buy or bill).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { PRODUCTION_APP_ORIGIN, resolveEmailLinkBaseUrl } from "@/lib/app-url";
import {
  getManagerNumberRecord,
  mapNumberRow,
  releaseManagerNumber,
} from "@/lib/sms/manager-number-provisioning.server";
import {
  SMS_NUMBER_SUSPENSION_GRACE_DAYS,
  SMS_NUMBER_SUSPENSION_WARN_DAYS_BEFORE,
} from "@/lib/sms/number-registration-policy";
import { sendManagerNoticeEmail } from "@/lib/sms-inbox-notice.server";

const TABLE = "manager_sms_numbers";

const MS_PER_DAY = 86_400_000;

export type SuspensionSweepResult = {
  considered: number;
  stamped: number;
  cleared: number;
  warned: number;
  released: number;
  /**
   * Rows due for their warning whose warning could NOT be delivered this tick
   * (sandbox address, mailer unconfigured, Resend refusal). Release is gated on
   * a delivered warning, so each of these is a number PropLane keeps paying for
   * past the grace — the count plus a per-row `errors` entry is what makes that
   * extended grace visible in the cron response instead of silent.
   */
  unwarnable: number;
  errors: Array<{ managerUserId: string; error: string }>;
};

function daysBetween(fromIso: string, nowMs: number): number {
  const from = Date.parse(fromIso);
  if (!Number.isFinite(from)) return 0;
  return Math.floor((nowMs - from) / MS_PER_DAY);
}

/**
 * Daily sweep: stamp newly-unpaid active numbers, clear re-entitled ones,
 * warn, then release past the grace.
 *
 * `limit` is the TOTAL row budget for the whole sweep, not a per-query one — a
 * bad day must not be able to mass-release the fleet in one tick, and every row
 * costs at least one sequential entitlement read inside a cron that shares its
 * 60s with the provisioning backfill. The three queues each get a floor so a
 * busy one cannot starve the others, and whatever the earlier queues leave
 * unspent rolls forward to the warn queue.
 */
export async function sweepSuspendedManagerNumbers(
  db: SupabaseClient,
  opts?: { limit?: number; nowMs?: number },
): Promise<SuspensionSweepResult> {
  const limit = Math.max(1, Math.min(opts?.limit ?? 50, 200));
  const nowMs = opts?.nowMs ?? Date.now();
  const result: SuspensionSweepResult = {
    considered: 0,
    stamped: 0,
    cleared: 0,
    warned: 0,
    released: 0,
    unwarnable: 0,
    errors: [],
  };

  const { resolveManagerNumberAccess, sendAllowedByAccess } = await import(
    "@/lib/sms/manager-number-access.server"
  );

  const warnAfterDays = SMS_NUMBER_SUSPENSION_GRACE_DAYS - SMS_NUMBER_SUSPENSION_WARN_DAYS_BEFORE;
  let budget = limit;
  const queueFloor = Math.max(1, Math.floor(limit / 3));

  // 1. Active numbers still unpaid and not yet stamped — start the grace clock.
  //
  // Scoped to UNSTAMPED rows (pass 2 owns every stamped one, clears included)
  // and ordered deterministically: an unfiltered, unordered window let
  // already-stamped rows eat the whole budget, so a manager who downgraded
  // outside that arbitrary window never had their clock started at all.
  const { data: activeRows } = await db
    .from(TABLE)
    .select("*")
    .eq("provision_state", "active")
    .not("phone_number", "is", null)
    .is("service_suspended_at", null)
    .order("manager_user_id", { ascending: true })
    .limit(Math.min(queueFloor, budget));
  for (const raw of activeRows ?? []) {
    if (budget <= 0) break;
    const row = mapNumberRow(raw as Record<string, unknown>);
    if (!row?.managerUserId || row.serviceSuspendedAt) continue;
    budget -= 1;
    result.considered += 1;
    try {
      const access = await resolveManagerNumberAccess(db, row.managerUserId);
      if (!sendAllowedByAccess(access)) {
        const { data: updated } = await db
          .from(TABLE)
          .update({
            service_suspended_at: new Date(nowMs).toISOString(),
            updated_at: new Date(nowMs).toISOString(),
          })
          .eq("manager_user_id", row.managerUserId)
          .eq("provision_state", "active")
          .is("service_suspended_at", null)
          .select("manager_user_id");
        if ((updated ?? []).length > 0) result.stamped += 1;
      }
    } catch (e) {
      result.errors.push({
        managerUserId: row.managerUserId,
        error: e instanceof Error ? e.message : "access_check_failed",
      });
    }
  }

  // 2. Already-stamped rows: warn, then release past grace.
  //
  // Split into two queues drawn and processed separately, because release
  // candidates and warn candidates are disjoint populations that must not
  // compete:
  //
  //   (a) rows carrying a delivered warning — the ONLY release candidates, so a
  //       number nobody could be warned about can never crowd out a release
  //       that is genuinely due;
  //   (b) rows that are DUE for a warning and still unwarned, ordered by
  //       `updated_at` so it is a round robin. Every attempt touches the row, so
  //       a permanently-undeliverable warning rotates to the BACK after each try
  //       instead of pinning the head of the window. The due-date predicate is
  //       what keeps that rotation fair: without it a row nowhere near the
  //       warning date would occupy the window ahead of a manager at day 85 who
  //       is actually owed their notice.
  const processSuspendedRow = async (raw: unknown): Promise<void> => {
    const row = mapNumberRow(raw as Record<string, unknown>);
    if (!row?.managerUserId || !row.serviceSuspendedAt) return;
    const ageDays = daysBetween(row.serviceSuspendedAt, nowMs);

    try {
      // Re-check entitlement before any destructive action — a same-day re-up
      // must not lose the number to a race with the stamp pass above.
      const access = await resolveManagerNumberAccess(db, row.managerUserId);
      if (sendAllowedByAccess(access)) {
        const { data: updated } = await db
          .from(TABLE)
          .update({
            service_suspended_at: null,
            suspension_warned_at: null,
            updated_at: new Date(nowMs).toISOString(),
          })
          .eq("manager_user_id", row.managerUserId)
          .not("service_suspended_at", "is", null)
          .select("manager_user_id")
          .then((res) => res, () => ({ data: [] as Array<{ manager_user_id: string }> }));
        if ((updated ?? []).length > 0) result.cleared += 1;
        return;
      }

      // Release is gated on a warning that ACTUALLY went out, and on the full
      // notice period having run since it did. `warnSuspendedNumberRelease`
      // returns false whenever the mailer is unconfigured or Resend refuses, so
      // a number whose owner was never reached keeps its grace extended and the
      // sweep keeps trying to warn — releasing a number printed on listings with
      // no notice is the worst outcome this feature can produce.
      const warnedAgeDays = row.suspensionWarnedAt
        ? daysBetween(row.suspensionWarnedAt, nowMs)
        : null;
      if (
        ageDays >= SMS_NUMBER_SUSPENSION_GRACE_DAYS &&
        warnedAgeDays !== null &&
        warnedAgeDays >= SMS_NUMBER_SUSPENSION_WARN_DAYS_BEFORE
      ) {
        // Counted from what the row ACTUALLY reads back as, never from having
        // called the helper: its guards and best-effort writes can leave it a
        // silent no-op, and reporting a release PropLane is still billed for is
        // exactly the money leak this sweep exists to catch.
        const released = await releaseExpiredSuspendedNumber(db, row.managerUserId);
        if (released) result.released += 1;
        else {
          result.errors.push({
            managerUserId: row.managerUserId,
            error: "release_not_confirmed",
          });
        }
        return;
      }

      if (ageDays >= warnAfterDays && !row.suspensionWarnedAt) {
        const warned = await warnSuspendedNumberRelease(db, row.managerUserId, ageDays);
        if (warned) {
          const { data: stamped } = await db
            .from(TABLE)
            .update({
              suspension_warned_at: new Date(nowMs).toISOString(),
              updated_at: new Date(nowMs).toISOString(),
            })
            .eq("manager_user_id", row.managerUserId)
            .is("suspension_warned_at", null)
            .select("manager_user_id")
            .then((res) => res, () => ({ data: [] as Array<{ manager_user_id: string }> }));
          // A sent email whose stamp did not land is NOT a warning: release
          // reads the stamp, and counting it would hide a manager being
          // re-emailed the same notice every single day.
          if ((stamped ?? []).length > 0) result.warned += 1;
          else {
            result.errors.push({
              managerUserId: row.managerUserId,
              error: "warn_sent_but_stamp_failed",
            });
          }
        } else {
          await db
            .from(TABLE)
            .update({ updated_at: new Date(nowMs).toISOString() })
            .eq("manager_user_id", row.managerUserId)
            .is("suspension_warned_at", null)
            .then(() => undefined, () => undefined);
          result.unwarnable += 1;
          result.errors.push({
            managerUserId: row.managerUserId,
            error: `warn_undeliverable_suspended_${ageDays}d`,
          });
        }
      }
    } catch (e) {
      result.errors.push({
        managerUserId: row.managerUserId,
        error: e instanceof Error ? e.message : "sweep_failed",
      });
    }
  };

  const releaseCandidates: unknown[] =
    budget > 0
      ? ((
          await db
            .from(TABLE)
            .select("*")
            .eq("provision_state", "active")
            .not("service_suspended_at", "is", null)
            .not("suspension_warned_at", "is", null)
            .order("suspension_warned_at", { ascending: true })
            .limit(Math.min(queueFloor, budget))
        ).data ?? [])
      : [];
  for (const raw of releaseCandidates) {
    if (budget <= 0) break;
    budget -= 1;
    await processSuspendedRow(raw);
  }

  const warnDueBeforeIso = new Date(nowMs - warnAfterDays * MS_PER_DAY).toISOString();
  const warnCandidates: unknown[] =
    budget > 0
      ? ((
          await db
            .from(TABLE)
            .select("*")
            .eq("provision_state", "active")
            .not("service_suspended_at", "is", null)
            .is("suspension_warned_at", null)
            .lte("service_suspended_at", warnDueBeforeIso)
            .order("updated_at", { ascending: true })
            .limit(budget)
        ).data ?? [])
      : [];
  for (const raw of warnCandidates) {
    if (budget <= 0) break;
    budget -= 1;
    await processSuspendedRow(raw);
  }

  return result;
}

async function warnSuspendedNumberRelease(
  db: SupabaseClient,
  managerUserId: string,
  ageDays: number,
): Promise<boolean> {
  const { data: profile } = await db
    .from("profiles")
    .select("email")
    .eq("id", managerUserId)
    .maybeSingle();
  const email = String(profile?.email ?? "").trim().toLowerCase();
  if (!email.includes("@")) return false;
  // Never under-promise: release needs the full notice period AFTER this email
  // lands, so a warning sent late (mailer outage, address only fixed now) still
  // buys the whole window rather than announcing "0 days".
  const daysLeft = Math.max(
    SMS_NUMBER_SUSPENSION_WARN_DAYS_BEFORE,
    SMS_NUMBER_SUSPENSION_GRACE_DAYS - ageDays,
  );
  const portalLink = `${(resolveEmailLinkBaseUrl() || PRODUCTION_APP_ORIGIN).replace(/\/$/, "")}/portal/profile`;
  const { sent } = await sendManagerNoticeEmail({
    toEmail: email,
    subject: `Your PropLane number will be released in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`,
    text: [
      `Your PropLane work number has been suspended for ${ageDays} day${ageDays === 1 ? "" : "s"} because this account is no longer on a paid Pro or Business plan.`,
      "",
      `In about ${daysLeft} day${daysLeft === 1 ? "" : "s"} PropLane will release the number and stop forwarding texts to it. People who have the number saved will no longer reach you.`,
      "",
      "Upgrade to Pro or Business before then to keep the same number:",
      portalLink,
    ].join("\n"),
  });
  return sent;
}

/**
 * Release a past-grace suspended number: Twilio (best-effort, money-saving),
 * clear the profile cache, mark the lifecycle row released. Never purchases.
 *
 * "Never release a number its owner was not warned about" lives HERE, on the
 * destructive operation, not only in the sweep that normally calls it — a
 * future caller taking a different path must inherit the same refusal.
 *
 * Returns whether the lifecycle row really reads `released` afterwards. That
 * answer comes from a FRESH read, never from a write's status code, because
 * every write on this path is best-effort: a caller that reports "released"
 * while the row is still active would be claiming PropLane stopped paying for a
 * number it is still billed for.
 */
export async function releaseExpiredSuspendedNumber(
  db: SupabaseClient,
  managerUserId: string,
): Promise<boolean> {
  const id = managerUserId.trim();
  if (!id) return false;
  const record = await getManagerNumberRecord(db, id);
  if (!record || record.provisionState !== "active") return false;
  if (!record.serviceSuspendedAt) return false;
  if (!record.suspensionWarnedAt) return false;

  const sid = record.phoneNumberSid;
  if (sid) {
    // Best-effort provider release so we stop paying. No-ops without Twilio
    // credentials — unit tests never reach a live purchase/release.
    const { releaseTwilioNumber } = await import("@/lib/twilio-provisioning");
    await releaseTwilioNumber(sid).catch(() => undefined);
  }

  const phone = String(record.phoneNumber ?? "").trim();
  if (phone) {
    await db
      .from("profiles")
      .update({ sms_from_number: null, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("sms_from_number", phone)
      .then(() => undefined, () => undefined);
  }

  await releaseManagerNumber(db, id);

  const after = await getManagerNumberRecord(db, id).catch(() => null);
  return after?.provisionState === "released";
}
