import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadSharedLineConfig, workspaceOnSharedLine } from "@/lib/one-number/config.server";
import {
  newLeadCount,
  openServiceCount,
  rentStatusFor,
  toursOnDay,
} from "@/lib/one-number/ops-facts.server";
import {
  buildMorningDigestText,
  digestIsEmpty,
  monthOfDayKey,
  type DigestFacts,
} from "@/lib/one-number/ops-text";
import { sendManagerNotificationSms } from "@/lib/manager-notification-routing.server";
import { pacificCalendarDateYmd } from "@/lib/pacific-time";
import { resolveManagerSmsAccess } from "@/lib/sms/manager-sms-access.server";
import { resolveWorkspaceTeamMembersWithGrants } from "@/lib/team-comms.server";
import type { AgentContext } from "@/lib/tools/context";
import { resolveManagerSmsAgentContext } from "@/lib/tools/manager-sms-context";

/**
 * The 8am (Pacific) morning text. It extends the manager Needs-attention digest: the same
 * recipient routing (`sendManagerNotificationSms`: the person's verified phone, their alert
 * destination and the "attention digest" topic), a different moment and a different body: tours
 * today, open services, rent paid / unpaid for the month, new leads.
 *
 * Who gets it, per workspace: the owner unless they turned it off, and a teammate only if they
 * turned it on (`morningDigestWanted`). Each person's numbers are computed in THEIR scope (the
 * workspace the line serves and, for a teammate, the houses they hold), so one team's digest can
 * never count another team's tours, rent or leads. Live only on the shared line; in `per_workspace`
 * and `shadow` nothing is sent, so today's behaviour is untouched.
 */

export const MORNING_DIGEST_HOUR_PACIFIC = 8;

/** The person's explicit choice wins; unset means on for the owner, off for a teammate. */
export function morningDigestWanted(stored: boolean | null | undefined, isOwner: boolean): boolean {
  return typeof stored === "boolean" ? stored : isOwner;
}

export function pacificHour(now: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "2-digit", hourCycle: "h23" }).formatToParts(now);
  return Number(parts.find((p) => p.type === "hour")?.value ?? "-1");
}

export type MorningDigestSummary = {
  workspaces: number;
  sent: number;
  skipped: number;
  empty: number;
  failed: number;
  skippedReason?: "not_8am" | "not_shared_mode" | "unreadable";
};

export type MorningDigestDeps = {
  now?: () => Date;
  /** Bypass the 8am check (a test, or a one-off manual run). */
  force?: boolean;
};

async function loadFacts(ctx: AgentContext, now: Date, delegated: boolean): Promise<DigestFacts> {
  const today = pacificCalendarDateYmd(now);
  const [tours, openServices, rent, leads] = await Promise.all([
    toursOnDay(ctx, today),
    openServiceCount(ctx),
    rentStatusFor(ctx, monthOfDayKey(today)),
    // Prospect contacts carry no house, so a teammate who holds only some houses is not told a count of them.
    delegated ? Promise.resolve(0) : newLeadCount(ctx, new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()),
  ]);
  return {
    toursToday: tours.confirmed.length,
    openServices,
    rent: rent.paidCount + rent.unpaidCount > 0 ? { paidCount: rent.paidCount, unpaidCount: rent.unpaidCount, unpaidCents: rent.unpaidCents } : null,
    newLeads: leads,
  };
}

export async function runMorningDigests(db: SupabaseClient, deps: MorningDigestDeps = {}): Promise<MorningDigestSummary> {
  const now = (deps.now ?? (() => new Date()))();
  const summary: MorningDigestSummary = { workspaces: 0, sent: 0, skipped: 0, empty: 0, failed: 0 };
  if (!deps.force && pacificHour(now) !== MORNING_DIGEST_HOUR_PACIFIC) return { ...summary, skippedReason: "not_8am" };

  const config = await loadSharedLineConfig(db);
  if (config.mode !== "shared") return { ...summary, skippedReason: "not_shared_mode" };

  const { data: workspaces, error } = await db.from("portal_workspaces").select("id, owner_user_id").limit(5000);
  if (error) return { ...summary, skippedReason: "unreadable" };
  const day = pacificCalendarDateYmd(now);

  for (const ws of (workspaces ?? []) as Array<{ id: string; owner_user_id: string }>) {
    const workspaceId = String(ws.id);
    const ownerId = String(ws.owner_user_id);
    if (!workspaceId || !ownerId || !workspaceOnSharedLine(config, workspaceId)) continue;
    summary.workspaces += 1;

    const members = await resolveWorkspaceTeamMembersWithGrants(db, { ownerManagerUserId: ownerId, workspaceId });
    const { data: settingsRows } = await db
      .from("manager_automation_settings")
      .select("manager_user_id, wanted:row_data->>managerMorningTextDigest")
      .in("manager_user_id", members.map((m) => m.userId));
    const stored = new Map<string, boolean | null>();
    for (const row of (settingsRows ?? []) as Array<{ manager_user_id: string; wanted: string | null }>) {
      stored.set(String(row.manager_user_id), row.wanted === "true" ? true : row.wanted === "false" ? false : null);
    }

    for (const member of members) {
      if (!morningDigestWanted(stored.get(member.userId), member.isOwner)) { summary.skipped += 1; continue; }
      try {
        const access = member.isOwner ? undefined : await resolveManagerSmsAccess(db, { actorUserId: member.userId, workNumberOwnerId: ownerId });
        if (!member.isOwner && !access) { summary.skipped += 1; continue; }
        const identity = await resolveManagerSmsAgentContext(db, {
          managerUserId: ownerId,
          actorUserId: member.userId,
          ...(access ? { access } : {}),
          workspaceId,
        });
        if (!identity.ok) { summary.skipped += 1; continue; }
        const facts = await loadFacts(identity.ctx, now, access?.mode === "delegated");
        if (digestIsEmpty(facts)) { summary.empty += 1; continue; }
        const result = await sendManagerNotificationSms(db, {
          managerUserId: member.userId,
          category: "attention_digest",
          subject: "Good morning",
          text: buildMorningDigestText(facts),
          purpose: "manager_morning_digest",
          dedupeKey: `morning-digest:${workspaceId}:${member.userId}:${day}`,
          workspaceId,
          ...(member.isOwner ? {} : { sendFrom: { ownerUserId: ownerId, workspaceId } }),
        });
        if (result.sent) summary.sent += 1;
        else summary.skipped += 1;
      } catch {
        summary.failed += 1;
      }
    }
  }
  return summary;
}
