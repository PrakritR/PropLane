import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { assertCoManagerModuleAccess, type CoManagerAccessResult } from "@/lib/auth/co-manager-access";
import type { CoManagerPermissionId, CoManagerPermissionLevel } from "@/lib/co-manager-permissions";
import { REMINDER_SUBJECT_CO_MANAGER_MODULE } from "@/lib/co-manager-notification-recipients.server";
import { REMINDER_SUBJECT_KINDS, type ReminderSubjectKind } from "@/lib/reminders/rules";

/**
 * Co-manager module gate for the account-level manager settings surfaces
 * (tour settings, task automation, payment automation, reminder rules,
 * manual payment setup).
 *
 * IMPORTANT SCOPE NOTE: every table these routes read/write is keyed ONE ROW
 * PER MANAGER, primary-keyed on `manager_user_id` (see e.g.
 * `manager_automation_settings`, `supabase/migrations/20260628120001_payment_automation_settings.sql`),
 * and every load/save call in those libs is `.eq("manager_user_id", callerUserId)`
 * with `callerUserId` always the CALLING user's own id — none of the six
 * routes this file backs accept a parameter naming a different manager to
 * act on behalf of. So today a caller (owner or co-manager) can only ever
 * reach their OWN row through these routes; there is no existing code path
 * where a co-manager's request lands on another manager's settings row.
 *
 * This file still wires the standard `assertCoManagerModuleAccess` gate at
 * the point these routes need it, for three reasons: (1) it is the same
 * shape every other co-manager-aware route in the codebase uses, so if the
 * scoping above is ever widened (a workspace/owner parameter added), the
 * enforcement point already exists and does not need to be re-discovered;
 * (2) `assertCoManagerModuleAccess` short-circuits to `{ ok: true }` for the
 * caller's own row (`ownerManagerUserId` unset or equal to the caller), so
 * this is a genuine no-op for every request these routes can receive today
 * — it can never lock a manager or co-manager out of their own settings;
 * and (3) it fails closed exactly like the reference route
 * (`manager-application-settings`) on an unexpected lookup error.
 */

type ServiceClient = SupabaseClient;

async function assertModule(
  db: ServiceClient,
  userId: string,
  // Not named `module`: Next forbids assigning that identifier
  // (@next/next/no-assign-module-variable), same as
  // co-manager-notification-recipients.server.ts.
  permissionModule: CoManagerPermissionId,
  level: CoManagerPermissionLevel,
): Promise<CoManagerAccessResult> {
  return assertCoManagerModuleAccess(db, userId, null, permissionModule, { level });
}

/** `manager-tour-settings` and `tour-reminders` — tour scheduling is gated on the calendar module. */
export async function assertTourSettingsCoManagerAccess(
  db: ServiceClient,
  userId: string,
  level: CoManagerPermissionLevel = "read",
): Promise<CoManagerAccessResult> {
  return assertModule(db, userId, "calendar", level);
}

/** `task-automation-settings` — lifecycle task rules share the calendar module (`REMINDER_SUBJECT_CO_MANAGER_MODULE.task`). */
export async function assertTaskAutomationCoManagerAccess(
  db: ServiceClient,
  userId: string,
  level: CoManagerPermissionLevel = "read",
): Promise<CoManagerAccessResult> {
  return assertModule(db, userId, REMINDER_SUBJECT_CO_MANAGER_MODULE.task, level);
}

/** `manager-manual-payment-settings` — payment setup is gated on the payments module. */
export async function assertManualPaymentSettingsCoManagerAccess(
  db: ServiceClient,
  userId: string,
  level: CoManagerPermissionLevel = "read",
): Promise<CoManagerAccessResult> {
  return assertModule(db, userId, "payments", level);
}

/** The module one reminder subject kind is gated on — reuses the canonical mapping, never a second one. */
export function reminderKindCoManagerModule(kind: ReminderSubjectKind): CoManagerPermissionId {
  return REMINDER_SUBJECT_CO_MANAGER_MODULE[kind];
}

/** `reminder-settings` (single-kind PATCH: `{ kind, rule }`) — authorize exactly the named kind's module. */
export async function assertReminderKindCoManagerAccess(
  db: ServiceClient,
  userId: string,
  kind: ReminderSubjectKind,
  level: CoManagerPermissionLevel = "read",
): Promise<CoManagerAccessResult> {
  return assertModule(db, userId, reminderKindCoManagerModule(kind), level);
}

/**
 * `reminder-settings` (bulk PATCH merging several rules, or a full GET that
 * always returns every kind) — authorize every module touched by `kinds`,
 * deduped, rejecting the whole request on the first kind whose module the
 * caller cannot reach. Pass every `REMINDER_SUBJECT_KINDS` for a full GET or
 * a `quietHours` change (both touch every subject at once).
 */
export async function assertReminderKindsCoManagerAccess(
  db: ServiceClient,
  userId: string,
  kinds: readonly ReminderSubjectKind[],
  level: CoManagerPermissionLevel = "read",
): Promise<CoManagerAccessResult> {
  const modules = [...new Set(kinds.map(reminderKindCoManagerModule))];
  for (const permissionModule of modules) {
    const result = await assertModule(db, userId, permissionModule, level);
    if (!result.ok) return result;
  }
  return { ok: true };
}

/** Every reminder subject kind — the set a full GET or a `quietHours` change touches. */
export const ALL_REMINDER_SUBJECT_KINDS: readonly ReminderSubjectKind[] = REMINDER_SUBJECT_KINDS;

/**
 * `automation-settings` mixes payment-reminder config (late fees, overdue
 * schedule), tour-reminder config, vendor dispatch, and manager notification
 * routing in ONE flat, un-keyed settings blob (`ManagerAutomationSettings` in
 * `@/lib/payment-automation-settings`, plus `vendorDispatch`) — unlike
 * `reminder-settings`, there is no per-field "kind" tag to authorize against,
 * and building one would mean inventing a second, field-by-field mapping the
 * brief for this change asked not to invent. Per the fallback this change was
 * given for exactly this shape, the route below authorizes the whole surface
 * against ONE module rather than guessing the loosest one: `payments`, since
 * the majority of the blob (pre-due/post-due/overdue/late-fee/same-day
 * reminder scheduling) is payment-reminder configuration, and `payments` is
 * a genuinely restrictive module — never the loosest available choice
 * (`calendar` or `inbox` would have been looser). See the route's own
 * comment and the worker report for this call.
 */
export async function assertAutomationSettingsCoManagerAccess(
  db: ServiceClient,
  userId: string,
  level: CoManagerPermissionLevel = "read",
): Promise<CoManagerAccessResult> {
  return assertModule(db, userId, "payments", level);
}
