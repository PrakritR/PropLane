/**
 * Check-in / check-out message templates, settings and the pure message builder (design-1112 §7).
 *
 * The captain's template file was not found, so the defaults are derived from the arrival guide
 * (`bookings/arrival-guide.ts`) and the house details; a manager edits them in Settings -> Automations.
 *
 * Rules the builder enforces (each one is a unit test):
 *   - a line whose merge fields are ALL empty is dropped; text is never printed with a hole in it;
 *   - `{room_code}` is the guest's OWN room's structured "Room door code", never a fallback. The check-in message needs it:
 *     an empty one yields `room_code_missing`, never a message;
 *   - the body is checked against every OTHER room's code and the staff-only Internal section before it is returned. A body
 *     that carries one is refused (`foreign_code`): a wrong room mapping is a security incident, not a typo.
 * No IO here; the facts are loaded by `facts.server.ts` at SEND time and never stored in a queue payload.
 */
import { toGsm7 } from "@/lib/one-number/segments";
import { formatStayTime, normalizeStayTime } from "@/lib/bookings/stay-times";
import { normalizeE164, formatUsPhoneDisplay } from "@/lib/phone-e164";
import { DEFAULT_CONTACT_PHONE_BY_SOURCE, DEFAULT_SOURCE_ENABLED, STAY_SOURCES, type StaySource } from "@/lib/stay-messages/settings-defaults";

export { STAY_SOURCES };
export type { StaySource };
export const STAY_SOURCE_LABEL: Record<StaySource, string> = {
  direct: "Direct bookings",
  proplane: "PropLane bookings",
  resident: "Long-term residents",
  airbnb: "Airbnb",
  booking_com: "Booking.com",
};

export const STAY_MESSAGE_FIELDS = [
  "first_name",
  "property",
  "room",
  "address",
  "check_in_day",
  "check_in_time",
  "front_door_code",
  "gate_code",
  "room_code",
  "wifi_network",
  "wifi_password",
  "bathroom_rule",
  "checkout_time",
  "checkout_steps",
  "contact_phone",
] as const;
export type StayMessageField = (typeof STAY_MESSAGE_FIELDS)[number];

export const DEFAULT_CHECK_IN_TEMPLATE = [
  "Hi {first_name}, you check in {check_in_day} at {property}.",
  "Address: {address}",
  "Check-in is at {check_in_time}.",
  "Front door code: {front_door_code}",
  "Gate code: {gate_code}",
  "Your {room} code: {room_code}",
  "Wi-Fi: {wifi_network}",
  "Wi-Fi password: {wifi_password}",
  "{bathroom_rule}",
  "Questions? Text {contact_phone}.",
].join("\n");

export const DEFAULT_CHECK_OUT_TEMPLATE = [
  "Hi {first_name}, checkout from {property} is at {checkout_time} today.",
  "{checkout_steps}",
  "Thank you for staying with us. Questions? Text {contact_phone}.",
].join("\n");

export type StayMessageSettings = {
  /** Per source: send at all. Airbnb and Booking.com default OFF. */
  sources: Record<StaySource, boolean>;
  /** Per source: the number the message names (E.164). */
  contactPhone: Record<StaySource, string>;
  templates: { checkIn: string; checkOut: string };
};

export const DEFAULT_STAY_MESSAGE_SETTINGS: StayMessageSettings = Object.freeze({
  sources: { ...DEFAULT_SOURCE_ENABLED },
  contactPhone: { ...DEFAULT_CONTACT_PHONE_BY_SOURCE },
  templates: { checkIn: DEFAULT_CHECK_IN_TEMPLATE, checkOut: DEFAULT_CHECK_OUT_TEMPLATE },
}) as StayMessageSettings;

const TEMPLATE_MAX = 2000;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Settings as stored (`workspace_automation_settings.row_data.stayMessages`), cleaned. Anything unreadable = the default. */
export function normalizeStayMessageSettings(raw: unknown): StayMessageSettings {
  const value = asRecord(raw);
  const sources = asRecord(value.sources);
  const phones = asRecord(value.contactPhone);
  const templates = asRecord(value.templates);
  const defaults = DEFAULT_STAY_MESSAGE_SETTINGS;
  const out: StayMessageSettings = { sources: { ...defaults.sources }, contactPhone: { ...defaults.contactPhone }, templates: { ...defaults.templates } };
  for (const source of STAY_SOURCES) {
    if (typeof sources[source] === "boolean") out.sources[source] = sources[source] as boolean;
    const phone = normalizeE164(phones[source]);
    if (phone) out.contactPhone[source] = phone;
  }
  for (const [key, fallback] of [["checkIn", defaults.templates.checkIn], ["checkOut", defaults.templates.checkOut]] as const) {
    const text = typeof templates[key] === "string" ? (templates[key] as string).replace(/\r\n/g, "\n").trim() : "";
    out.templates[key] = text ? text.slice(0, TEMPLATE_MAX) : fallback;
  }
  return out;
}

/** Which source setting governs a stay. */
export function staySourceOf(input: { stayDetailsSource?: unknown; channelProvider?: unknown; isLease?: boolean }): StaySource {
  if (input.isLease) return "resident";
  const provider = typeof input.channelProvider === "string" ? input.channelProvider.trim().toLowerCase() : "";
  if (provider === "airbnb") return "airbnb";
  if (provider === "booking_com" || provider === "booking.com") return "booking_com";
  const source = typeof input.stayDetailsSource === "string" ? input.stayDetailsSource.trim().toLowerCase() : "";
  if (source === "airbnb") return "airbnb";
  if (source === "booking.com" || source === "booking_com") return "booking_com";
  if (source === "portal" || source === "sms" || source === "application" || source === "proplane") return "proplane";
  return "direct";
}

export type StayMessageFacts = {
  kind: "check_in" | "check_out" | "check_in_correction";
  firstName: string;
  propertyLabel: string;
  /** The guest's room as the manager named it ("Room 4"). Empty for a whole-house stay. */
  roomLabel: string;
  /** False when the house lists rooms and this stay's room id matches none of them. */
  roomResolved: boolean;
  /** The house lists structured rooms at all (a whole-house stay has no room code to require). */
  houseHasRooms: boolean;
  addressLine: string;
  checkInDay: string;
  checkInTime: string | null;
  checkOutTime: string | null;
  frontDoorCode: string;
  gateCode: string;
  /** The guest's OWN room's structured door code, or "". */
  roomDoorCode: string;
  wifiNetwork: string;
  wifiPassword: string;
  bathroomRule: string;
  checkoutSteps: readonly string[];
  contactPhoneE164: string;
  /** Codes that must NEVER appear in this body: every other room's, and the staff-only Internal section. */
  forbiddenCodes: readonly string[];
};

export type BuiltStayMessage =
  | { ok: true; subject: string; body: string; smsBody: string }
  | { ok: false; reason: "room_code_missing" | "foreign_code" | "empty_template" };

function fieldValues(facts: StayMessageFacts): Record<StayMessageField, string> {
  return {
    first_name: facts.firstName,
    property: facts.propertyLabel,
    room: facts.roomLabel,
    address: facts.addressLine,
    check_in_day: facts.checkInDay,
    check_in_time: facts.checkInTime ? formatStayTime(normalizeStayTime(facts.checkInTime) ?? facts.checkInTime) : "",
    front_door_code: facts.frontDoorCode,
    gate_code: facts.gateCode,
    room_code: facts.roomDoorCode,
    wifi_network: facts.wifiNetwork,
    wifi_password: facts.wifiPassword,
    bathroom_rule: facts.bathroomRule,
    checkout_time: facts.checkOutTime ? formatStayTime(normalizeStayTime(facts.checkOutTime) ?? facts.checkOutTime) : "",
    checkout_steps: facts.checkoutSteps.join("\n"),
    contact_phone: formatUsPhoneDisplay(facts.contactPhoneE164) || facts.contactPhoneE164,
  };
}

const FIELD_TOKEN = /\{([a-z_]+)\}/g;

const OPTIONAL_FIELDS: readonly StayMessageField[] = ["first_name", "check_in_day"];

/**
 * Merge one template. A line that names a field with no value is dropped whole (never a hole in the sentence); the greeting
 * name and the day word are the two fields a line survives without. An unknown `{x}` stays visible so a typo is seen.
 */
export function renderStayTemplate(template: string, facts: StayMessageFacts): string {
  const values = fieldValues(facts);
  const known = (name: string): name is StayMessageField => (STAY_MESSAGE_FIELDS as readonly string[]).includes(name);
  const out: string[] = [];
  for (const rawLine of template.replace(/\r\n/g, "\n").split("\n")) {
    const names = [...rawLine.matchAll(FIELD_TOKEN)].map((match) => match[1]!).filter(known);
    if (names.some((name) => !OPTIONAL_FIELDS.includes(name) && !values[name].trim())) continue;
    const line = rawLine
      .replace(FIELD_TOKEN, (token, name: string) => (known(name) ? values[name].trim() : token))
      .replace(/[ \t]+([,.!?])/g, "$1")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function squash(value: string): string {
  return value.toLowerCase().replace(/[\s\-_.]+/g, "");
}

/** Does `body` carry `code` as a whole token (case and spacing blind, short codes only as a standalone token)? */
export function bodyCarriesCode(body: string, code: string): boolean {
  const needle = code.trim();
  if (!needle) return false;
  if (squash(needle).length >= 4) return squash(body).includes(squash(needle));
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9])${escaped}([^A-Za-z0-9]|$)`, "i").test(body);
}

/**
 * Build the message for one stay. Never returns a body for a check-in with no room code, and never a body that carries a
 * code that is not this guest's (another room's, or the staff-only section).
 */
export function buildStayMessage(input: {
  template: string;
  facts: StayMessageFacts;
  /** "Update: ..." header for a correction message. */
  correctionHeader?: string;
}): BuiltStayMessage {
  const { facts } = input;
  if (!input.template.trim()) return { ok: false, reason: "empty_template" };
  // A room-rental check-in always carries the guest's own room code: empty (or a room that matches none) is a hold, never a fallback.
  if (facts.kind !== "check_out" && facts.houseHasRooms && (!facts.roomResolved || !facts.roomDoorCode.trim())) {
    return { ok: false, reason: "room_code_missing" };
  }
  const rendered = renderStayTemplate(input.template, facts);
  const body = [input.correctionHeader?.trim(), rendered].filter(Boolean).join("\n");
  const own = new Set([facts.roomDoorCode, facts.frontDoorCode, facts.gateCode].map((code) => code.trim()).filter(Boolean));
  for (const forbidden of facts.forbiddenCodes) {
    const code = forbidden.trim();
    if (!code || own.has(code)) continue;
    if (bodyCarriesCode(body, code)) return { ok: false, reason: "foreign_code" };
  }
  const subject =
    facts.kind === "check_out"
      ? `Checkout today${facts.propertyLabel ? ` from ${facts.propertyLabel}` : ""}`
      : facts.kind === "check_in_correction"
        ? `Update to your stay${facts.propertyLabel ? ` at ${facts.propertyLabel}` : ""}`
        : `Your check-in details${facts.propertyLabel ? ` for ${facts.propertyLabel}` : ""}`;
  // The SMS keeps codes verbatim; descriptive text goes through GSM-7 so a curly quote does not double the cost.
  const sms = body
    .split("\n")
    .map((line) => (/code|password/i.test(line) ? line : toGsm7(line)))
    .join("\n");
  return { ok: true, subject, body, smsBody: sms };
}
