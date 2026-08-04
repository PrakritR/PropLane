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
  errors: Array<{ managerUserId: string; error: string }>;
};

function daysBetween(fromIso: string, nowMs: number): number {
  const from = Date.parse(fromIso);
  if (!Number.isFinite(from)) return 0;
  return Math.floor((nowMs - from) / MS_PER_DAY);
}

/**
 * Daily sweep: stamp newly-unpaid active numbers, clear re-entitled ones,
 * warn, then release past the grace. Bounded by `limit` so a bad day cannot
 * mass-release the fleet in one tick.
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
    errors: [],
  };

  const { resolveManagerNumberAccess, sendAllowedByAccess } = await import(
    "@/lib/sms/manager-number-access.server"
  );

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
    .limit(limit);
  for (const raw of activeRows ?? []) {
    const row = mapNumberRow(raw as Record<string, unknown>);
    if (!row?.managerUserId || row.serviceSuspendedAt) continue;
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
  const { data: suspendedRows } = await db
    .from(TABLE)
    .select("*")
    .eq("provision_state", "active")
    .not("service_suspended_at", "is", null)
    .order("service_suspended_at", { ascending: true })
    .limit(limit);
  const warnAfterDays = SMS_NUMBER_SUSPENSION_GRACE_DAYS - SMS_NUMBER_SUSPENSION_WARN_DAYS_BEFORE;

  for (const raw of suspendedRows ?? []) {
    const row = mapNumberRow(raw as Record<string, unknown>);
    if (!row?.managerUserId || !row.serviceSuspendedAt) continue;
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
        continue;
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
        await releaseExpiredSuspendedNumber(db, row.managerUserId);
        result.released += 1;
        continue;
      }

      if (ageDays >= warnAfterDays && !row.suspensionWarnedAt) {
        const warned = await warnSuspendedNumberRelease(db, row.managerUserId, ageDays);
        if (warned) {
          await db
            .from(TABLE)
            .update({
              suspension_warned_at: new Date(nowMs).toISOString(),
              updated_at: new Date(nowMs).toISOString(),
            })
            .eq("manager_user_id", row.managerUserId)
            .is("suspension_warned_at", null)
            .then(() => undefined, () => undefined);
          result.warned += 1;
        }
      }
    } catch (e) {
      result.errors.push({
        managerUserId: row.managerUserId,
        error: e instanceof Error ? e.message : "sweep_failed",
      });
    }
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
 */
export async function releaseExpiredSuspendedNumber(
  db: SupabaseClient,
  managerUserId: string,
): Promise<void> {
  const id = managerUserId.trim();
  if (!id) return;
  const record = await getManagerNumberRecord(db, id);
  if (!record || record.provisionState !== "active") return;
  if (!record.serviceSuspendedAt) return;

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
}
