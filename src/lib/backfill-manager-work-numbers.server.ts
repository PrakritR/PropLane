import type { SupabaseClient } from "@supabase/supabase-js";
import { isPlaceholderManagerWorkNumber } from "@/lib/claw-leasing-links";
import { ensureManagerSmsNumber } from "@/lib/twilio-provisioning";
import { isPureCoManagerWorkspace } from "@/lib/sms/manager-workspace-role.server";

export function managerNeedsWorkNumber(smsFromNumber: string | null | undefined): boolean {
  const current = String(smsFromNumber ?? "").trim();
  if (!current) return true;
  return isPlaceholderManagerWorkNumber(current);
}

async function listManagerUserIds(db: SupabaseClient, managerUserId?: string): Promise<string[]> {
  if (managerUserId) return [managerUserId];

  const ids = new Set<string>();

  const { data: roleRows } = await db.from("profile_roles").select("user_id").eq("role", "manager").limit(5000);
  for (const row of roleRows ?? []) {
    const id = String(row.user_id ?? "").trim();
    if (id) ids.add(id);
  }

  const { data: profileRows } = await db
    .from("profiles")
    .select("id, role")
    .in("role", ["manager", "pro", "admin"])
    .limit(5000);
  for (const row of profileRows ?? []) {
    const id = String(row.id ?? "").trim();
    if (id) ids.add(id);
  }

  return [...ids];
}

export async function listManagersNeedingWorkNumbers(
  db: SupabaseClient,
  managerUserId?: string,
): Promise<Array<{ userId: string; smsFromNumber: string | null }>> {
  const managerIds = await listManagerUserIds(db, managerUserId);
  if (managerIds.length === 0) return [];

  const { data: profiles, error } = await db
    .from("profiles")
    .select("id, sms_from_number")
    .in("id", managerIds);
  if (error) throw error;

  const byId = new Map((profiles ?? []).map((p) => [String(p.id), String(p.sms_from_number ?? "").trim() || null]));
  const out: Array<{ userId: string; smsFromNumber: string | null }> = [];
  for (const userId of managerIds) {
    const smsFromNumber = byId.get(userId) ?? null;
    if (!managerNeedsWorkNumber(smsFromNumber)) continue;
    // One number per workspace: a co-manager with no houses of their own
    // shares the owner's line and is never a backfill candidate.
    if (await isPureCoManagerWorkspace(db, userId)) continue;
    out.push({ userId, smsFromNumber });
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type BackfillManagerWorkNumbersResult = {
  dryRun: boolean;
  considered: number;
  provisioned: number;
  failed: number;
  errors: Array<{ userId: string; error: string }>;
  numbers: Array<{ userId: string; number: string }>;
};

/**
 * Idempotent admin repair: buy/assign a Twilio work number for every manager
 * missing `profiles.sms_from_number` or still stamped with the legacy Claw line.
 */
export async function backfillManagerWorkNumbers(
  db: SupabaseClient,
  opts?: { dryRun?: boolean; managerUserId?: string; delayMs?: number; limit?: number },
): Promise<BackfillManagerWorkNumbersResult> {
  const dryRun = opts?.dryRun === true;
  const delayMs = opts?.delayMs ?? 750;
  const limit = opts?.limit && opts.limit > 0 ? opts.limit : undefined;

  let candidates = await listManagersNeedingWorkNumbers(db, opts?.managerUserId);
  if (limit) candidates = candidates.slice(0, limit);

  const result: BackfillManagerWorkNumbersResult = {
    dryRun,
    considered: candidates.length,
    provisioned: 0,
    failed: 0,
    errors: [],
    numbers: [],
  };

  if (dryRun || candidates.length === 0) return result;

  for (let i = 0; i < candidates.length; i++) {
    const { userId } = candidates[i]!;
    const provisioned = await ensureManagerSmsNumber(db, userId);
    if (provisioned.ok) {
      result.provisioned++;
      result.numbers.push({ userId, number: provisioned.number });
    } else {
      result.failed++;
      result.errors.push({ userId, error: provisioned.error });
    }
    if (i < candidates.length - 1 && delayMs > 0) {
      await sleep(delayMs);
    }
  }

  return result;
}
