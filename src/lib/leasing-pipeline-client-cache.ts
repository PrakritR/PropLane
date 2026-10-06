/**
 * Browser cache of the manager's leasing pipeline prefs so sync send-gate
 * helpers (`leaseSendGateBlocker`) can respect lease-first without a fetch.
 * Settings load/save refreshes this; defaults match `DEFAULT_LEASING_PIPELINE`.
 */
import {
  DEFAULT_LEASING_PIPELINE,
  effectiveSharedRoomLeaseKind,
  normalizeLeasingPipelinePreferences,
  type LeasingPipelinePreferences,
} from "@/lib/leasing-pipeline-preferences";

let cached: LeasingPipelinePreferences = { ...DEFAULT_LEASING_PIPELINE };

export function cacheLeasingPipelinePreferences(raw: unknown): LeasingPipelinePreferences {
  cached = normalizeLeasingPipelinePreferences(raw);
  return cached;
}

export function readCachedLeasingPipelinePreferences(): LeasingPipelinePreferences {
  return cached;
}

/**
 * Whether roommates in this shared room sign ONE joint lease: the room's own choice, else the
 * workspace default (Settings -> Automations, "Roommates in a shared room sign").
 */
export function sharedRoomIsOnJointLease(
  room: { sharedRoomLeaseKind?: "property_default" | "individual" | "joint" | null } | null | undefined,
): boolean {
  return effectiveSharedRoomLeaseKind(room?.sharedRoomLeaseKind, cached) === "joint";
}
