/**
 * Pure maintenance-detection helpers (safe for client + server).
 *
 * "Is this message a maintenance request?" is NOT decided here any more
 * (PRP-109). It is `classifyInboundMessage`, shared with the manager inbox
 * chips, so the auto-created work order a text produces and the chip a manager
 * sees can never disagree about the same words. What stays here is the
 * downstream inference — category, title, priority — which only runs once
 * something has already been judged a request.
 */

import { classifyInboundMessage } from "@/lib/inbox/inbound-message-intent";
import type { ResidentMaintenanceCategoryLabel } from "@/lib/work-order-taxonomy";

/**
 * True when the resident message looks like a maintenance / repair request.
 *
 * Delegates to the shared classifier. The rules it replaced fired on a repair
 * word plus a noun with no notion of tense or resolution, so "the toilet leak
 * is fixed, thanks" opened a work order for something already done, and
 * "can you fix a time to look at the lease?" opened one for nothing at all.
 * This gate is load-bearing on the live SMS path (`createWorkOrderFromResidentSms`),
 * so those were real work orders, not just chips.
 */
export function looksLikeMaintenanceRequest(text: string): boolean {
  return classifyInboundMessage(text).intent === "maintenance";
}

export function inferMaintenanceCategoryLabel(text: string): ResidentMaintenanceCategoryLabel {
  const t = text.toLowerCase();
  if (/\b(toilet|sink|faucet|shower|bathtub|tub|pipe|drain|plumb|leak|clog|hot water|garbage disposal)\b/.test(t)) {
    return "Plumbing";
  }
  if (/\b(outlet|electric|wiring|breaker|power|light fixture)\b/.test(t)) return "Electrical";
  if (/\b(hvac|furnace|heater|ac\b|air conditioner|no heat|no ac|thermostat)\b/.test(t)) return "HVAC";
  if (/\b(fridge|refrigerator|dishwasher|washer|dryer|stove|oven|microwave|appliance)\b/.test(t)) {
    return "Appliance";
  }
  if (/\b(lock|key|door|deadbolt|access)\b/.test(t)) return "Access / Locks";
  return "General";
}

export function inferMaintenanceTitle(text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  const lower = t.toLowerCase();
  if (/\btoilet\b/.test(lower)) return "Toilet issue";
  if (/\bsink\b/.test(lower)) return "Sink issue";
  if (/\bleak|leaking\b/.test(lower)) return "Leak reported";
  if (/\bno (hot )?water\b/.test(lower)) return "Water issue";
  if (/\bno heat\b/.test(lower)) return "No heat";
  if (/\bno ac\b|\bair conditioner\b/.test(lower)) return "AC issue";
  if (/\block\b/.test(lower)) return "Lock / access issue";
  const first = t.split(/[.!?\n]/)[0]?.trim() || "Maintenance request";
  return first.length > 72 ? `${first.slice(0, 69)}…` : first;
}

export function inferMaintenancePriority(text: string): string {
  const t = text.toLowerCase();
  if (/\b(emergency|flooding|flooded|gas|sparking|no heat|no water|can't get in|cant get in)\b/.test(t)) {
    return "Emergency";
  }
  if (/\b(urgent|asap|immediately|right away)\b/.test(t)) return "High";
  return "Medium";
}
