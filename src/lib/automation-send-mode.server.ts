import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  DEFAULT_AUTOMATION_SEND_MODE_SETTINGS,
  type AutomationSendModeSettings,
} from "@/lib/automation-send-mode";
import { resolvePropertyOwnerUserId } from "@/lib/property-owner.server";
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
