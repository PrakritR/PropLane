/**
 * Preset text: validate a template, fill it from data, and refuse a group text that names a person,
 * carries money or leaks a secret.
 *
 * Amounts, dates and names come from the data passed in, never from a model. A variable with no
 * value renders as nothing (and the whole text is refused when a REQUIRED one is missing: see
 * `missingRequiredVariables`), so a half-filled "Door code ." never goes out.
 *
 * Pure: no database, no clock. Shared by the Settings preview, the sweep and the announce route.
 */
import { containsHouseSecret, type HouseInfoV1 } from "@/lib/house-info";
import { toGsm7 } from "@/lib/one-number/segments";
import {
  GROUP_FORBIDDEN_VARIABLES,
  VARIABLE_LABELS,
  type AutomationPreset,
  type AutomationVariable,
} from "./presets";

export type TemplateVars = Partial<Record<AutomationVariable, string>>;

/** The longest template a manager can save: three GSM-7 segments of room, no more. */
export const MAX_TEMPLATE_LENGTH = 320;

const PLACEHOLDER = /\{([a-z_]+)\}/g;

/** Every `{name}` in a template, in order, once each. */
export function templateVariablesUsed(template: string): string[] {
  const seen: string[] = [];
  for (const match of template.matchAll(PLACEHOLDER)) {
    if (!seen.includes(match[1]!)) seen.push(match[1]!);
  }
  return seen;
}

export type TemplateCheck = { ok: true } | { ok: false; error: string };

/**
 * Can this wording be saved for this preset? Unknown variables, a personal or money variable in a
 * group text, an empty body and an over-long body are refused with a sentence the editor shows.
 */
export function validateTemplate(preset: AutomationPreset, template: string): TemplateCheck {
  const text = String(template ?? "").trim();
  if (!text) return { ok: false, error: "Enter the text to send." };
  if (text.length > MAX_TEMPLATE_LENGTH) {
    return { ok: false, error: `Keep it under ${MAX_TEMPLATE_LENGTH} characters.` };
  }
  for (const name of templateVariablesUsed(text)) {
    if (!(name in VARIABLE_LABELS)) return { ok: false, error: `Unknown item {${name}}.` };
    const variable = name as AutomationVariable;
    if (!preset.variables.includes(variable)) {
      return { ok: false, error: `${VARIABLE_LABELS[variable]} is not available here.` };
    }
    if (preset.audience === "group" && GROUP_FORBIDDEN_VARIABLES.has(variable)) {
      return { ok: false, error: `${VARIABLE_LABELS[variable]} cannot go in a house group text.` };
    }
  }
  return { ok: true };
}

/** Variables the template uses that `vars` has no value for. */
export function missingRequiredVariables(template: string, vars: TemplateVars): AutomationVariable[] {
  return templateVariablesUsed(template).filter((name) => {
    const value = vars[name as AutomationVariable];
    return !(typeof value === "string" && value.trim());
  }) as AutomationVariable[];
}

/**
 * Fill the template. A sentence that uses a variable with no value is dropped whole ("Door code
 * {door_code}." disappears when the house has no code) rather than sent half-empty. Callers check
 * `missingRequiredVariables` for the facts the text cannot do without.
 */
export function renderTemplate(template: string, vars: TemplateVars): string {
  const sentences = String(template ?? "").split(/(?<=[.!?])\s+/);
  const kept: string[] = [];
  for (const sentence of sentences) {
    let empty = false;
    const filled = sentence.replace(PLACEHOLDER, (_whole, name: string) => {
      const value = vars[name as AutomationVariable];
      const text = typeof value === "string" ? value.trim() : "";
      if (!text) empty = true;
      return text;
    });
    if (!empty && filled.trim()) kept.push(filled.trim());
  }
  return toGsm7(kept.join(" ").replace(/[ \t]+/g, " ").replace(/\s+([.,!?])/g, "$1").trim());
}

/** A pretend resident for the Settings preview when the workspace has none to borrow. */
export const SAMPLE_VARS: Required<TemplateVars> = {
  first_name: "Maya",
  house: "5259 Brooklyn",
  room: "Room 3",
  move_in_date: "Nov 1",
  move_out_date: "Dec 15",
  amount: "$850.00",
  due_date: "Nov 1",
  pay_link: "https://proplane.ai/l/sample",
  guide_link: "https://proplane.ai/l/sample",
  door_code: "1234",
  wifi_name: "House WiFi",
  wifi_password: "welcome1",
  parking: "street parking",
  service_title: "Kitchen sink",
  service_window: "Tue 10-12",
  announcement: "Water is off Tuesday 9-12.",
  reminder: "Trash and recycling pickup is tomorrow. Please put the bins out tonight.",
  check_in_time: "3 pm",
  check_out_time: "11 am",
  arrival_link: "https://proplane.ai/l/sample",
};

/* ───────────────────────────  what a house group may read  ─────────────────────────── */

const MONEY = /(\$\s?\d)|(\b\d[\d,]*\.\d{2}\b)|\b(usd|dollars?|bucks)\b|\b\d+\s?(dollars?|usd)\b/i;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export type GroupTextContext = {
  /** First names of the people in the group. A text naming any of them is refused. */
  residentFirstNames: readonly string[];
  /** The house's details; a door code, gate code, lockbox, Wi-Fi password or alarm in the text is refused. */
  houseInfo: HouseInfoV1 | null | undefined;
};

export type GroupTextViolation = "money" | "name" | "secret";

/**
 * Why this text must not go to a house group. Money, any resident's first name, and any secret.
 * An empty list means it may. Stricter than the template validator on purpose: this reads the
 * RENDERED text, so an announcement a manager typed and a model-written house fact are held to the
 * same rule as a template.
 */
export function groupTextViolations(text: string, context: GroupTextContext): GroupTextViolation[] {
  const out: GroupTextViolation[] = [];
  if (MONEY.test(text)) out.push("money");
  for (const name of context.residentFirstNames) {
    const first = name.trim();
    if (first.length < 2) continue;
    if (new RegExp(`\\b${escapeRegExp(first)}\\b`, "i").test(text)) {
      out.push("name");
      break;
    }
  }
  if (containsHouseSecret(text, context.houseInfo)) out.push("secret");
  return out;
}

export const GROUP_VIOLATION_MESSAGES: Record<GroupTextViolation, string> = {
  money: "Money stays one on one. Take the amount out, or send it to each resident.",
  name: "A house group text cannot name a resident. Take the name out.",
  secret: "Door codes, gate codes and the Wi-Fi password never go in a group text.",
};
