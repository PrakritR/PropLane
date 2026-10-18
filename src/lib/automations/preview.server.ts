import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { getHouseInfoValue } from "@/lib/house-info";
import { shortDateLabel } from "./moments";
import { getAutomationPreset, type AutomationPresetId } from "./presets";
import { loadHouseDirectory, loadLeaseSubjects } from "./sources.server";
import { loadAutomationSettings, resolveAutomation } from "./store.server";
import { SAMPLE_VARS, renderTemplate, validateTemplate, type TemplateVars } from "./templates";

export type AutomationPreview =
  | { ok: true; text: string; usedRealData: boolean; segments: number }
  | { ok: false; error: string };

/**
 * What a preset would say right now, filled from one real resident of the workspace (the first with
 * a signed lease) and falling back to sample values for anything the house does not have. The manager
 * sees their own door code in a resident preview; a group preset never reads a person or a secret.
 */
export async function buildAutomationPreview(
  db: SupabaseClient,
  input: { ownerUserId: string; workspaceId: string; preset: AutomationPresetId; template?: string },
): Promise<AutomationPreview> {
  const preset = getAutomationPreset(input.preset);
  if (!preset) return { ok: false, error: "Unknown automation." };
  const saved = await loadAutomationSettings(db, input.workspaceId);
  const template = input.template?.trim() || resolveAutomation(preset, saved.get(preset.id)).template;
  const check = validateTemplate(preset, template);
  if (!check.ok) return check;

  let vars: TemplateVars = { ...SAMPLE_VARS };
  let usedRealData = false;
  try {
    const leases = (await loadLeaseSubjects(db, { onlyOwner: input.ownerUserId })).filter((l) => l.workspaceId === input.workspaceId);
    const lease = leases.find((l) => l.moveIn) ?? leases[0];
    if (lease) {
      const houses = await loadHouseDirectory(db, [lease.propertyId]);
      const house = houses.get(lease.propertyId);
      vars = {
        ...vars,
        first_name: lease.firstName,
        house: lease.propertyLabel,
        ...(lease.roomLabel ? { room: lease.roomLabel } : {}),
        ...(lease.moveIn ? { move_in_date: shortDateLabel(lease.moveIn) } : {}),
        ...(lease.moveOut ? { move_out_date: shortDateLabel(lease.moveOut) } : {}),
      };
      if (house) {
        const facts: Array<[keyof TemplateVars, string]> = [
          ["door_code", getHouseInfoValue(house.houseInfo, "access", "doorCode")],
          ["wifi_name", getHouseInfoValue(house.houseInfo, "wifi", "network")],
          ["wifi_password", getHouseInfoValue(house.houseInfo, "wifi", "password")],
          ["parking", getHouseInfoValue(house.houseInfo, "access", "parking")],
        ];
        for (const [key, value] of facts) if (value) vars[key] = value;
      }
      usedRealData = true;
    }
  } catch {
    /* sample values are a fine preview */
  }
  const text = renderTemplate(template, vars);
  return { ok: true, text, usedRealData, segments: Math.max(1, Math.ceil(text.length / 160)) };
}
