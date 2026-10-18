/**
 * Dispatch rule shapes and the one validator (vendor-dispatch-1018, portal side).
 * "If any of houses X has a lockout, send locksmith Y, then backups D and E."
 * Pure: the routes validate through here and the editor mirrors its limits, so a
 * value the form allows is a value the server accepts. Data:
 * 20261018120000_vendor_dispatch_rules.sql.
 */
import {
  DEFAULT_OFFER_TIMEOUT_MINUTES,
  issueDefinition,
  tradeDefinition,
  type DispatchUrgency,
} from "@/lib/vendor-dispatch/trades";
import type { VendorPayModel } from "@/lib/vendor-dispatch/vendor-roles";

export const DISPATCH_URGENCIES: readonly DispatchUrgency[] = ["emergency", "urgent", "routine"];
export const DISPATCH_URGENCY_LABEL: Record<DispatchUrgency, string> = {
  emergency: "Emergency",
  urgent: "Urgent",
  routine: "Routine",
};
export type DispatchHours = "any" | "business" | "after_hours";
export const DISPATCH_HOURS: readonly { id: DispatchHours; label: string }[] = [
  { id: "any", label: "Any time" },
  { id: "business", label: "Business hours" },
  { id: "after_hours", label: "After hours" },
];
export type DispatchMode = "sequential" | "broadcast";
export type DispatchPropertyScope = "all" | "selected";

export const MAX_CHAIN_LENGTH = 20;
export const MAX_RULE_PROPERTIES = 100;
const PAY_MODELS: readonly VendorPayModel[] = ["flat", "hourly", "per_room", "quote"];
const MAX_CENTS = 10_000_000;

/** What the editor sends and the server stores. */
export type DispatchRuleInput = {
  name: string;
  trade: string;
  /** Null = any job of the trade. */
  issue: string | null;
  propertyScope: DispatchPropertyScope;
  propertyIds: string[];
  urgencies: DispatchUrgency[];
  hours: DispatchHours;
  mode: DispatchMode;
  broadcastSize: number;
  /** Null = the default for the job's urgency. */
  timeoutMinutes: number | null;
  payCents: number | null;
  payModel: VendorPayModel;
  nteCents: number | null;
  /** Roster vendor ids, primary first. */
  vendorIds: string[];
  active: boolean;
};

export type DispatchRuleVendor = { vendorDirectoryId: string; position: number; name: string };

/** A stored rule as the portal reads it. */
export type DispatchRule = Omit<DispatchRuleInput, "vendorIds"> & {
  id: string;
  workspaceId: string;
  vendors: DispatchRuleVendor[];
  createdAt: string;
  updatedAt: string;
};

export type DispatchRuleParse = { ok: true; value: DispatchRuleInput } | { ok: false; error: string };

function intOrNull(value: unknown): number | null | "bad" {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return "bad";
  return Math.round(value);
}

/**
 * Validate a rule body. Unknown keys are dropped; a bad value is refused with a
 * message the editor can show. `partial` (PATCH) fills missing keys from `base`.
 */
export function parseDispatchRuleInput(raw: unknown, base?: DispatchRuleInput): DispatchRuleParse {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "Rule required." };
  const body = raw as Record<string, unknown>;
  const pick = <K extends keyof DispatchRuleInput>(key: K): unknown => (key in body ? body[key] : base?.[key]);

  const name = typeof pick("name") === "string" ? (pick("name") as string).replace(/\s+/g, " ").trim() : "";
  if (name.length < 1 || name.length > 80) return { ok: false, error: "Name the rule (80 characters or fewer)." };

  const trade = pick("trade");
  if (typeof trade !== "string" || !tradeDefinition(trade)) return { ok: false, error: "Pick a job type." };

  const issueRaw = pick("issue");
  let issue: string | null = null;
  if (issueRaw !== null && issueRaw !== undefined && issueRaw !== "") {
    if (typeof issueRaw !== "string" || !issueDefinition(trade, issueRaw)) return { ok: false, error: "Pick an issue of that job type." };
    issue = issueRaw;
  }

  const scope = pick("propertyScope");
  if (scope !== "all" && scope !== "selected") return { ok: false, error: "Pick which houses." };
  let propertyIds: string[] = [];
  if (scope === "selected") {
    const rawIds = pick("propertyIds");
    propertyIds = Array.isArray(rawIds)
      ? [...new Set(rawIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0 && id.length <= 200).map((id) => id.trim()))]
      : [];
    if (propertyIds.length === 0) return { ok: false, error: "Pick at least one house." };
    if (propertyIds.length > MAX_RULE_PROPERTIES) return { ok: false, error: "Too many houses." };
  }

  const urgenciesRaw = pick("urgencies");
  const urgencies = Array.isArray(urgenciesRaw)
    ? DISPATCH_URGENCIES.filter((urgency) => urgenciesRaw.includes(urgency))
    : [];
  if (urgencies.length === 0) return { ok: false, error: "Pick at least one urgency." };

  const hours = pick("hours");
  if (hours !== "any" && hours !== "business" && hours !== "after_hours") return { ok: false, error: "Pick the hours." };

  const mode = pick("mode");
  if (mode !== "sequential" && mode !== "broadcast") return { ok: false, error: "Pick how to offer the job." };

  const sizeRaw = pick("broadcastSize");
  const size = typeof sizeRaw === "number" && Number.isFinite(sizeRaw) ? Math.round(sizeRaw) : 3;
  if (size < 2 || size > 10) return { ok: false, error: "Offer to between 2 and 10 vendors at once." };

  const timeout = intOrNull(pick("timeoutMinutes"));
  if (timeout === "bad" || (timeout !== null && (timeout < 2 || timeout > 1440))) {
    return { ok: false, error: "Wait time must be between 2 minutes and 24 hours." };
  }

  const pay = intOrNull(pick("payCents"));
  if (pay === "bad" || (pay !== null && (pay < 0 || pay > MAX_CENTS))) return { ok: false, error: "Pay amount is not valid." };
  const nte = intOrNull(pick("nteCents"));
  if (nte === "bad" || (nte !== null && (nte < 0 || nte > MAX_CENTS))) return { ok: false, error: "Pay cap is not valid." };

  const payModel = pick("payModel");
  if (typeof payModel !== "string" || !PAY_MODELS.includes(payModel as VendorPayModel)) return { ok: false, error: "Pick how they are paid." };

  const vendorsRaw = pick("vendorIds");
  const vendorIds = Array.isArray(vendorsRaw)
    ? [...new Set(vendorsRaw.filter((id): id is string => typeof id === "string" && id.trim().length > 0 && id.length <= 200).map((id) => id.trim()))]
    : [];
  if (vendorIds.length === 0) return { ok: false, error: "Add at least one vendor." };
  if (vendorIds.length > MAX_CHAIN_LENGTH) return { ok: false, error: `A chain holds up to ${MAX_CHAIN_LENGTH} vendors.` };

  const activeRaw = pick("active");
  const active = activeRaw === false ? false : true;

  return {
    ok: true,
    value: {
      name,
      trade,
      issue,
      propertyScope: scope,
      propertyIds,
      urgencies,
      hours,
      mode,
      broadcastSize: size,
      timeoutMinutes: timeout,
      payCents: pay,
      payModel: payModel as VendorPayModel,
      nteCents: nte,
      vendorIds,
      active,
    },
  };
}

/** The wait the engine uses: the rule's own, else the default for the job's urgency (the tightest of the rule's). */
export function ruleEffectiveTimeoutMinutes(rule: Pick<DispatchRuleInput, "timeoutMinutes" | "urgencies">): number {
  if (rule.timeoutMinutes != null) return rule.timeoutMinutes;
  const mostUrgent = DISPATCH_URGENCIES.find((urgency) => rule.urgencies.includes(urgency)) ?? "routine";
  return DEFAULT_OFFER_TIMEOUT_MINUTES[mostUrgent];
}

/** The default wait for a set of urgencies, used as the stepper's starting value. */
export function defaultTimeoutForUrgencies(urgencies: readonly DispatchUrgency[]): number {
  return ruleEffectiveTimeoutMinutes({ timeoutMinutes: null, urgencies: [...urgencies] });
}

/** Text for the pay figure on a rule row: "$120", "$45/hr", "$30/room", "Quote". */
export function formatRulePay(payCents: number | null | undefined, payModel: string): string {
  if (payModel === "quote" || payCents == null) return "Quote";
  const dollars = payCents / 100;
  const amount = `$${Number.isInteger(dollars) ? dollars : dollars.toFixed(2)}`;
  if (payModel === "hourly") return `${amount}/hr`;
  if (payModel === "per_room") return `${amount}/room`;
  return amount;
}

export function ruleHoursLabel(hours: DispatchHours): string {
  return DISPATCH_HOURS.find((entry) => entry.id === hours)?.label ?? "";
}
