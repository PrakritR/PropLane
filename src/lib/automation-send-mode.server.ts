import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  DEFAULT_AUTOMATION_SEND_MODE_SETTINGS,
  type AutomationSendModeSettings,
} from "@/lib/automation-send-mode";
import { resolvePropertyOwnerUserId } from "@/lib/property-owner.server";
import { isQuietHour, losAngelesHour } from "@/lib/reminders/rules";
import { loadReminderSettings, loadReminderSettingsForProperty } from "@/lib/reminders/settings.server";

/**
 * The ONE place the bus asks "auto-send or draft-for-review?" for an event.
 *
 * Resolved for the WORKSPACE the event belongs to: the setting lives on the
 * workspace owner's `manager_automation_settings` row (every workspace of a
 * Business owner shares that row, like every other automation setting), and
 * the owner is the account that owns the event's property — never whoever
 * happened to act. A co-manager approving an application on the owner's
 * house is governed by the owner's setting.
 *
 * A property lookup failure (a foreign or since-deleted property id, a
 * transient read error) falls back to the WORKSPACE'S OWN send mode, never
 * silently to the built-in auto/auto default — a manager who customized it
 * is never silently overridden. Only a failure reading the workspace itself
 * falls all the way through to the built-in default.
 */
export async function resolveAutomationSendModeForEvent(
  db: SupabaseClient,
  input: { managerUserId: string; propertyId?: string | null },
): Promise<AutomationSendModeSettings> {
  const fallback = input.managerUserId.trim();
  if (!fallback) return DEFAULT_AUTOMATION_SEND_MODE_SETTINGS;
  const owner = (await resolvePropertyOwnerUserId(db, input.propertyId)) ?? fallback;
  const propertyId = input.propertyId?.trim() ? input.propertyId.trim() : null;
  try {
    // The house's own reminder override wins when it has one (its
    // `automationSendMode` rides in the `reminderRules` blob); otherwise the
    // workspace value. A missing property resolves to the workspace rule.
    const settings = await loadReminderSettingsForProperty(db, owner, propertyId);
    return settings.automationSendMode;
  } catch {
    try {
      const workspace = await loadReminderSettings(db, owner);
      return workspace.automationSendMode;
    } catch {
      return DEFAULT_AUTOMATION_SEND_MODE_SETTINGS;
    }
  }
}

export type PartyFacingHold = { hold: boolean; reason: "approval" | "quiet_hours" | null };

/**
 * Must a party-facing automated answer be HELD for the manager rather than sent now?
 *
 * Two reasons, both on the workspace's own `manager_automation_settings` row: the approval switch
 * ("resident & vendor messages need my approval first"), and quiet hours — an answer written at 3am
 * waits for the manager instead of reaching the sender in the middle of the night.
 *
 * The read is STRICT: a failure THROWS instead of resolving to "send it". Unlike
 * {@link resolveAutomationSendModeForEvent} — which must keep the shared action-event bus delivering
 * for dozens of already-shipped automations — a caller of this function is one that has to fail
 * closed, and it cannot do that if every failure comes back as `auto`. (Note that
 * `loadReminderSettingsForProperty` is a stub returning defaults without reading anything, so the
 * workspace row has to be read here directly for the value to be the manager's at all.)
 */
export async function partyFacingAnswerHold(
  db: SupabaseClient,
  managerUserId: string,
  now: Date = new Date(),
): Promise<PartyFacingHold> {
  const owner = managerUserId.trim();
  if (!owner) throw new Error("automation send mode: no workspace owner to read");
  const settings = await loadReminderSettings(db, owner);
  if (settings.automationSendMode.partyFacing === "draft") return { hold: true, reason: "approval" };
  if (isQuietHour(settings.quietHours, losAngelesHour(now))) return { hold: true, reason: "quiet_hours" };
  return { hold: false, reason: null };
}
