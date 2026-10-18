import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { getHouseInfoValue } from "@/lib/house-info";
import { mintPhoneBoundLink } from "@/lib/one-number/links.server";
import { loadMoveInDetailsLock } from "@/lib/tools/resident-context";
import { pacificTodayKey } from "@/lib/sheet-sync/dates";
import { fireAutomation, reconcileHeldRuns, type FireOutcome } from "./fire.server";
import {
  houseMoments,
  residentMoments,
  shortDateLabel,
  workOrderIsHouseWide,
  type HouseSubject,
  type LeaseSubject,
  type PacificClock,
} from "./moments";
import { loadSharedLineConfig, workspaceOnSharedLine } from "@/lib/one-number/config.server";
import { loadOptedInWorkspaces, reapStuckRuns } from "./store.server";
import {
  loadHouseDirectory,
  loadLeaseSubjects,
  loadRecentlyScheduledServices,
  loadRentDueToday,
} from "./sources.server";
import type { TemplateVars } from "./templates";

/**
 * The sweeper behind the preset auto-sends. It rides the existing reminder dispatcher tick
 * (`/api/cron/dispatch-reminders`, every five minutes): no new cron. Every moment carries an
 * idempotency key, so a tick that sees the same moment again fires nothing.
 */

function pacificClock(now: Date): PacificClock {
  const todayKey = pacificTodayKey(now);
  const hour = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", hour12: false }).format(now),
  );
  return { todayKey, hour: hour === 24 ? 0 : hour, dayOfMonth: Number(todayKey.slice(8, 10)) };
}

async function guideLink(db: SupabaseClient, subject: LeaseSubject): Promise<string> {
  try {
    if (subject.phoneKey) {
      const link = await mintPhoneBoundLink(db, {
        phoneKey: subject.phoneKey,
        workspaceId: subject.workspaceId,
        purpose: "move_in",
        targetType: "lease",
        targetId: subject.leaseId,
        createdBy: subject.ownerUserId,
      });
      return link.url;
    }
  } catch {
    /* fall through to the plain sign-in path */
  }
  return `${resolveEmailLinkBaseUrl().replace(/\/$/, "")}/resident/move-in`;
}

export type SweepSummary = Record<string, number> & { fired: number };

function tally(summary: SweepSummary, outcome: FireOutcome) {
  summary[outcome.status] = (summary[outcome.status] ?? 0) + 1;
  if (outcome.status === "sent" || outcome.status === "held") summary.fired += 1;
}

export async function sweepAutomations(db: SupabaseClient, now: Date = new Date()): Promise<number> {
  const summary = await runAutomationSweep(db, now);
  return summary.fired;
}

export async function runAutomationSweep(db: SupabaseClient, now: Date = new Date()): Promise<SweepSummary> {
  const summary: SweepSummary = { fired: 0 };
  const clock = pacificClock(now);
  await reapStuckRuns(db, now);
  await reconcileHeldRuns(db);

  // A workspace that has never touched Automations and is not on the shared line keeps today's
  // behaviour: nothing new fires for it. The first pick in Settings (or the shared line) opts in.
  const [config, optedIn] = await Promise.all([loadSharedLineConfig(db), loadOptedInWorkspaces(db)]);
  const active = (workspaceId: string) => optedIn.has(workspaceId) || workspaceOnSharedLine(config, workspaceId);

  const leases = (await loadLeaseSubjects(db)).filter((l) => active(l.workspaceId));
  const houses = await loadHouseDirectory(db, leases.map((l) => l.propertyId));
  const rentDue = await loadRentDueToday(db, clock.todayKey).catch(() => new Set<string>());

  // 1:1 presets: one lease at a time.
  for (const lease of leases) {
    for (const moment of residentMoments(lease, clock.todayKey)) {
      if (!lease.phoneKey) {
        summary.no_phone = (summary.no_phone ?? 0) + 1;
        continue;
      }
      const house = houses.get(lease.propertyId);
      const vars: TemplateVars = {
        first_name: lease.firstName,
        house: lease.propertyLabel,
        ...(lease.roomLabel ? { room: lease.roomLabel } : {}),
        move_in_date: lease.moveIn ? shortDateLabel(lease.moveIn) : "",
      };
      if (moment.preset === "welcome") {
        vars.guide_link = await guideLink(db, lease);
      } else if (moment.preset === "move_in_3d" && house) {
        // The door code and the Wi-Fi password go only to a verified resident whose move-in details
        // are open (the same lock the resident assistant honours); locked reads send the guide only.
        const lock = await loadMoveInDetailsLock(db, { email: lease.residentEmail, userId: lease.residentUserId });
        vars.guide_link = await guideLink(db, lease);
        if (!lock.moveInDetailsLocked) {
          vars.door_code = getHouseInfoValue(house.houseInfo, "access", "doorCode");
          vars.wifi_name = getHouseInfoValue(house.houseInfo, "wifi", "network");
          vars.wifi_password = getHouseInfoValue(house.houseInfo, "wifi", "password");
          vars.parking = getHouseInfoValue(house.houseInfo, "access", "parking");
        }
      }
      const outcome = await fireAutomation(db, {
        workspaceId: lease.workspaceId,
        ownerUserId: lease.ownerUserId,
        preset: moment.preset,
        idempotencyKey: moment.key,
        vars,
        target: { kind: "resident", phoneKey: lease.phoneKey, residentUserId: lease.residentUserId, residentEmail: lease.residentEmail },
      }).catch((): FireOutcome => ({ status: "failed", reason: "threw" }));
      tally(summary, outcome);
    }
  }

  // House group presets: one house at a time.
  const rosterByHouse = new Map<string, LeaseSubject[]>();
  for (const lease of leases) {
    const list = rosterByHouse.get(lease.propertyId) ?? [];
    list.push(lease);
    rosterByHouse.set(lease.propertyId, list);
  }
  for (const [propertyId, house] of houses) {
    const roster = rosterByHouse.get(propertyId) ?? [];
    const moments = houseMoments({ house, roster, rentDueToday: rentDue.has(propertyId), clock });
    for (const moment of moments) {
      const vars: TemplateVars = { house: house.propertyLabel, ...(moment.reminder ? { reminder: moment.reminder } : {}) };
      const outcome = await fireAutomation(db, {
        workspaceId: house.workspaceId,
        ownerUserId: house.ownerUserId,
        preset: moment.preset,
        idempotencyKey: moment.key,
        vars,
        target: { kind: "group", house, roster, fallbackToResidents: false },
      }).catch((): FireOutcome => ({ status: "failed", reason: "threw" }));
      tally(summary, outcome);
    }
  }

  // Service visits booked in the last day that touch the whole house.
  const services = (await loadRecentlyScheduledServices(db, now).catch(() => [])).filter(() => optedIn.size > 0 || config.mode === "shared");
  const serviceHouses = await loadHouseDirectory(db, services.map((s) => s.propertyId)).catch(() => new Map<string, HouseSubject>());
  for (const service of services) {
    if (!workOrderIsHouseWide({ unit: service.unit })) continue;
    const house = serviceHouses.get(service.propertyId);
    if (!house || house.ownerUserId !== service.ownerUserId || !active(house.workspaceId)) continue;
    const roster = rosterByHouse.get(service.propertyId) ?? (await loadLeaseSubjects(db, { onlyOwner: house.ownerUserId, houses: serviceHouses })).filter((l) => l.propertyId === service.propertyId);
    const outcome = await fireAutomation(db, {
      workspaceId: house.workspaceId,
      ownerUserId: house.ownerUserId,
      preset: "maintenance_booked",
      idempotencyKey: `maintenance:${service.entityId}:${service.scheduledAtIso ?? service.window}`,
      vars: { house: house.propertyLabel, service_title: service.title, service_window: service.window },
      target: { kind: "group", house, roster, fallbackToResidents: true },
    }).catch((): FireOutcome => ({ status: "failed", reason: "threw" }));
    tally(summary, outcome);
  }
  return summary;
}
