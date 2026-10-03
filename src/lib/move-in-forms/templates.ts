/**
 * Move-in form DEFINITIONS: starters, normalizer, readers and small pure helpers.
 *
 * Definitions live on the property in `listingSubmission.moveInFormTemplates` (beside
 * `propertyApplicationTemplates`); settings in `listingSubmission.moveInFormSettings`.
 * Pure and isomorphic on purpose: the builder UI (client) and the server (dispatch,
 * send) read templates through the same functions, so what the manager edited is exactly
 * what a resident is sent.
 */
import type { ManagerCustomApplicationFieldType } from "@/lib/manager-listing-submission";
import {
  DEFAULT_MOVE_IN_FORM_SETTINGS,
  type MoveInFormAudience,
  type MoveInFormDueRule,
  type MoveInFormQuestion,
  type MoveInFormSettings,
  type MoveInFormSource,
  type MoveInFormStarterKey,
  type MoveInFormTemplate,
  type MoveInFormTrigger,
} from "./types";

/** A template id becomes a storage path segment, so it must be a plain id, never a path. */
export const MOVE_IN_FORM_ID_PATTERN = /^[A-Za-z0-9_-]{1,120}$/;

const SOURCES: readonly MoveInFormSource[] = ["built", "upload"];
const TRIGGERS: readonly MoveInFormTrigger[] = ["lease-signed", "application-approved", "manual"];
const DUE_RULES: readonly MoveInFormDueRule[] = ["day-before", "move-in-day", "3-days-before", "7-days-before"];
const QUESTION_TYPES: readonly (ManagerCustomApplicationFieldType | "signature")[] = [
  "text", "long_text", "number", "currency", "yes_no", "select", "multi_select", "checkbox",
  "date", "phone", "email", "photos", "file", "initials", "signature",
];
const STARTER_KEYS: readonly MoveInFormStarterKey[] = [
  "move-in-checklist", "key-receipt", "vehicle-parking", "pet-agreement", "emergency-contacts",
];
const MAX_TEMPLATES = 40;
const MAX_QUESTIONS = 60;
const MAX_OPTIONS = 40;

function randomId(): string {
  const uuid = typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  return uuid.replace(/-/g, "").slice(0, 24);
}

function question(
  key: string,
  label: string,
  type: MoveInFormQuestion["type"],
  extra: Partial<Omit<MoveInFormQuestion, "id" | "key" | "label" | "type">> = {},
): MoveInFormQuestion {
  return { id: `q-${key}`, key, label, type, required: false, options: [], ...extra };
}

type StarterDefinition = {
  name: string;
  trigger: MoveInFormTrigger;
  due: MoveInFormDueRule;
  questions: MoveInFormQuestion[];
};

const STARTER_DEFINITIONS: Record<MoveInFormStarterKey, StarterDefinition> = {
  "move-in-checklist": {
    name: "Move-in checklist",
    trigger: "lease-signed",
    due: "day-before",
    questions: [
      question("keys_received", "Keys you received", "multi_select", {
        required: true, section: "Keys and access",
        options: ["Front door key", "Room key", "Mailbox key", "Garage or gate remote", "Building fob"],
      }),
      question("key_count", "Number of keys received", "number", { required: true, section: "Keys and access" }),
      question("access_notes", "Anything not working with keys or access", "long_text", { section: "Keys and access" }),
      question("room_condition", "Room condition on arrival", "select", {
        required: true, section: "Room condition",
        options: ["Clean and ready", "Minor issues", "Needs attention"],
      }),
      question("room_issues", "Describe any damage or missing items", "long_text", {
        section: "Room condition", showIf: { fieldKey: "room_condition", equals: "Minor issues" },
      }),
      question("room_issues_serious", "Describe what needs attention", "long_text", {
        required: true, section: "Room condition", showIf: { fieldKey: "room_condition", equals: "Needs attention" },
      }),
      question("room_photos", "Photos of the room", "photos", { required: true, section: "Room condition" }),
      question("phone", "Best phone number to reach you", "phone", { required: true, section: "Contact" }),
      question("signature", "Sign to confirm the above", "signature", { required: true, section: "Signature" }),
    ],
  },
  "key-receipt": {
    name: "Key receipt",
    trigger: "manual",
    due: "move-in-day",
    questions: [
      question("keys_received", "Keys you received", "multi_select", {
        required: true,
        options: ["Front door key", "Room key", "Mailbox key", "Garage or gate remote", "Building fob"],
      }),
      question("key_count", "Total number of keys and fobs", "number", { required: true }),
      question("received_on", "Date received", "date", { required: true }),
      question("lost_key_policy", "I understand a lost key or fob may be charged to me", "checkbox", { required: true }),
      question("signature", "Signature", "signature", { required: true }),
    ],
  },
  "vehicle-parking": {
    name: "Vehicle and parking",
    trigger: "manual",
    due: "3-days-before",
    questions: [
      question("has_vehicle", "Will you park a vehicle at the property?", "yes_no", { required: true }),
      question("vehicle_make", "Make", "text", { required: true, showIf: { fieldKey: "has_vehicle", equals: "yes" } }),
      question("vehicle_model", "Model", "text", { required: true, showIf: { fieldKey: "has_vehicle", equals: "yes" } }),
      question("vehicle_color", "Color", "text", { showIf: { fieldKey: "has_vehicle", equals: "yes" } }),
      question("vehicle_plate", "License plate", "text", { required: true, showIf: { fieldKey: "has_vehicle", equals: "yes" } }),
      question("vehicle_state", "Plate state", "text", { showIf: { fieldKey: "has_vehicle", equals: "yes" } }),
      question("parking_rules", "I will follow the parking rules for this property", "checkbox", {
        required: true, showIf: { fieldKey: "has_vehicle", equals: "yes" },
      }),
    ],
  },
  "pet-agreement": {
    name: "Pet agreement",
    trigger: "manual",
    due: "3-days-before",
    questions: [
      question("has_pet", "Are you bringing a pet?", "yes_no", { required: true }),
      question("pet_kind", "Type of pet", "select", {
        required: true, options: ["Dog", "Cat", "Bird", "Small animal", "Other"],
        showIf: { fieldKey: "has_pet", equals: "yes" },
      }),
      question("pet_name", "Pet's name", "text", { required: true, showIf: { fieldKey: "has_pet", equals: "yes" } }),
      question("pet_breed", "Breed", "text", { showIf: { fieldKey: "has_pet", equals: "yes" } }),
      question("pet_weight", "Weight in pounds", "number", { showIf: { fieldKey: "has_pet", equals: "yes" } }),
      question("pet_vaccinated", "Vaccinations are up to date", "yes_no", { required: true, showIf: { fieldKey: "has_pet", equals: "yes" } }),
      question("pet_photo", "A photo of your pet", "photos", { showIf: { fieldKey: "has_pet", equals: "yes" } }),
      question("pet_rules", "I will follow the property's pet rules and clean up after my pet", "checkbox", {
        required: true, showIf: { fieldKey: "has_pet", equals: "yes" },
      }),
      question("signature", "Signature", "signature", { required: true }),
    ],
  },
  "emergency-contacts": {
    name: "Emergency contacts",
    trigger: "manual",
    due: "3-days-before",
    questions: [
      question("contact_name", "Emergency contact name", "text", { required: true }),
      question("contact_relationship", "Relationship", "text", { required: true }),
      question("contact_phone", "Phone number", "phone", { required: true }),
      question("contact_email", "Email", "email"),
      question("second_name", "Second contact name", "text"),
      question("second_phone", "Second contact phone", "phone"),
      question("medical_notes", "Anything we should know in an emergency", "long_text"),
    ],
  },
};

function starterTimestamp(): string {
  return new Date().toISOString();
}

/**
 * The five starter templates. The checklist sends itself when the lease is signed; the other four
 * ship as "manual" (only when the manager sends them), so nothing else reaches a resident by surprise.
 */
export const MOVE_IN_FORM_STARTERS: readonly MoveInFormTemplate[] = STARTER_KEYS.map((starterKey) => {
  const definition = STARTER_DEFINITIONS[starterKey];
  return {
    id: `starter-${starterKey}`,
    name: definition.name,
    source: "built" as const,
    questions: definition.questions,
    pdf: null,
    audience: { kind: "every-room" } as MoveInFormAudience,
    trigger: definition.trigger,
    due: definition.due,
    starterKey,
    createdAt: "2026-10-03T00:00:00.000Z",
    updatedAt: "2026-10-03T00:00:00.000Z",
  };
});

/**
 * A fresh template to edit. With `starterKey` it is a deep copy of that starter (new id, so
 * editing it never touches the shared starter); without, an empty form of the given source.
 */
export function newMoveInFormTemplate(source: MoveInFormSource, starterKey?: MoveInFormStarterKey): MoveInFormTemplate {
  const now = starterTimestamp();
  const starter = starterKey ? MOVE_IN_FORM_STARTERS.find((item) => item.starterKey === starterKey) : undefined;
  if (starter) {
    return {
      ...structuredClone(starter),
      id: `mif-${randomId()}`,
      source: "built",
      createdAt: now,
      updatedAt: now,
    };
  }
  return {
    id: `mif-${randomId()}`,
    name: "",
    source,
    questions: source === "upload"
      ? [question("signature", "Signature", "signature", { required: true })]
      : [],
    pdf: null,
    audience: { kind: "every-room" },
    trigger: "lease-signed",
    due: "day-before",
    createdAt: now,
    updatedAt: now,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function normalizeQuestion(raw: unknown, takenKeys: Set<string>): MoveInFormQuestion | null {
  if (!isRecord(raw)) return null;
  const type = raw.type;
  if (typeof type !== "string" || !QUESTION_TYPES.includes(type as MoveInFormQuestion["type"])) return null;
  const label = text(raw.label, 300);
  const key = text(raw.key, 80);
  if (!label || !/^[A-Za-z0-9_-]{1,80}$/.test(key) || takenKeys.has(key)) return null;
  takenKeys.add(key);
  const options = Array.isArray(raw.options)
    ? raw.options.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim().slice(0, 120)).slice(0, MAX_OPTIONS)
    : [];
  const showIf = isRecord(raw.showIf) && typeof raw.showIf.fieldKey === "string" && raw.showIf.fieldKey && typeof raw.showIf.equals === "string"
    ? { fieldKey: raw.showIf.fieldKey.slice(0, 80), equals: raw.showIf.equals.slice(0, 120) }
    : undefined;
  const description = text(raw.description, 600);
  const section = text(raw.section, 120);
  return {
    id: text(raw.id, 80) || `q-${key}`,
    key,
    label,
    type: type as MoveInFormQuestion["type"],
    // A signature is always required: an unsigned move-in form proves nothing.
    required: type === "signature" ? true : raw.required === true,
    options: type === "select" || type === "multi_select" ? options : [],
    ...(section ? { section } : {}),
    ...(description ? { description } : {}),
    ...(showIf ? { showIf } : {}),
  };
}

function normalizeAudience(raw: unknown): MoveInFormAudience {
  if (isRecord(raw) && raw.kind === "whole-house") return { kind: "whole-house" };
  if (isRecord(raw) && raw.kind === "rooms" && Array.isArray(raw.roomIds)) {
    const roomIds = [...new Set(raw.roomIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0).map((id) => id.trim().slice(0, 120)))].slice(0, 200);
    return { kind: "rooms", roomIds };
  }
  return { kind: "every-room" };
}

function normalizePdf(raw: unknown): MoveInFormTemplate["pdf"] {
  if (!isRecord(raw)) return null;
  const storagePath = text(raw.storagePath, 400);
  const fileName = text(raw.fileName, 200);
  const sha256 = text(raw.sha256, 64).toLowerCase();
  const pageCount = Number(raw.pageCount);
  if (!storagePath || /\.\.|[\\?#%]/.test(storagePath) || !/^[0-9a-f]{64}$/.test(sha256)) return null;
  return { storagePath, fileName: fileName || "form.pdf", pageCount: Number.isFinite(pageCount) && pageCount > 0 ? Math.floor(pageCount) : 1, sha256 };
}

function normalizeTemplate(raw: unknown): MoveInFormTemplate | null {
  if (!isRecord(raw)) return null;
  const id = text(raw.id, 120);
  if (!MOVE_IN_FORM_ID_PATTERN.test(id)) return null;
  const source: MoveInFormSource = SOURCES.includes(raw.source as MoveInFormSource) ? (raw.source as MoveInFormSource) : "built";
  const taken = new Set<string>();
  const questions = (Array.isArray(raw.questions) ? raw.questions : [])
    .slice(0, MAX_QUESTIONS)
    .map((item) => normalizeQuestion(item, taken))
    .filter((item): item is MoveInFormQuestion => item !== null);
  const pdf = source === "upload" ? normalizePdf(raw.pdf) : null;
  const now = starterTimestamp();
  // Retired on/off switch: a form that was stored turned off never sent itself, so it keeps not sending
  // itself ("manual"). Nothing that was sending stops, and nothing that was off starts.
  const storedTrigger = TRIGGERS.includes(raw.trigger as MoveInFormTrigger) ? (raw.trigger as MoveInFormTrigger) : "lease-signed";
  const trigger: MoveInFormTrigger = raw.enabled === false ? "manual" : storedTrigger;
  const starterKey = STARTER_KEYS.includes(raw.starterKey as MoveInFormStarterKey) ? (raw.starterKey as MoveInFormStarterKey) : undefined;
  return {
    id,
    name: text(raw.name, 120),
    source,
    questions,
    pdf,
    audience: normalizeAudience(raw.audience),
    trigger,
    due: DUE_RULES.includes(raw.due as MoveInFormDueRule) ? (raw.due as MoveInFormDueRule) : "day-before",
    ...(starterKey ? { starterKey } : {}),
    createdAt: text(raw.createdAt, 40) || now,
    updatedAt: text(raw.updatedAt, 40) || now,
  };
}

/** Defensive: anything that is not a well-formed template is dropped, never repaired into one. */
export function normalizeMoveInFormTemplates(raw: unknown): MoveInFormTemplate[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: MoveInFormTemplate[] = [];
  for (const item of raw.slice(0, MAX_TEMPLATES)) {
    const template = normalizeTemplate(item);
    if (!template || seen.has(template.id)) continue;
    seen.add(template.id);
    out.push(template);
  }
  return out;
}

function submissionRecord(listingSubmission: unknown): Record<string, unknown> | null {
  return isRecord(listingSubmission) ? listingSubmission : null;
}

/**
 * The property's forms. When the key was never written (a property nobody has touched here)
 * the five starters come back, so every property shows five rows. Once the manager
 * saves anything the stored list is the truth, even if it is empty.
 */
export function readMoveInFormTemplates(listingSubmission: unknown): MoveInFormTemplate[] {
  const submission = submissionRecord(listingSubmission);
  if (!submission || !("moveInFormTemplates" in submission) || submission.moveInFormTemplates === undefined) {
    return structuredClone([...MOVE_IN_FORM_STARTERS]);
  }
  return normalizeMoveInFormTemplates(submission.moveInFormTemplates);
}

export function readMoveInFormSettings(listingSubmission: unknown): MoveInFormSettings {
  const raw = submissionRecord(listingSubmission)?.moveInFormSettings;
  if (!isRecord(raw)) return { ...DEFAULT_MOVE_IN_FORM_SETTINGS };
  const remind = raw.remind === "before-and-due" || raw.remind === "due-only" || raw.remind === "never"
    ? raw.remind : DEFAULT_MOVE_IN_FORM_SETTINGS.remind;
  const notifyOnSubmit = raw.notifyOnSubmit === "assistant" || raw.notifyOnSubmit === "assistant-and-email" || raw.notifyOnSubmit === "none"
    ? raw.notifyOnSubmit : DEFAULT_MOVE_IN_FORM_SETTINGS.notifyOnSubmit;
  return { remind, notifyOnSubmit };
}

const DAYS_BEFORE: Record<MoveInFormDueRule, number> = {
  "day-before": 1,
  "move-in-day": 0,
  "3-days-before": 3,
  "7-days-before": 7,
};

/** Pacific is the product's wall clock; a form is due at the end of its due DAY there. */
function endOfPacificDay(year: number, month: number, day: number): string {
  // Standard time (UTC-8) first: tried the other way round, a winter date also "fits" at UTC-7.
  for (const offsetHours of [8, 7]) {
    const candidate = new Date(Date.UTC(year, month - 1, day, 23 + offsetHours, 59, 59));
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false })
      .formatToParts(candidate);
    const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
    if (get("year") === year && get("month") === month && get("day") === day) return candidate.toISOString();
  }
  return new Date(Date.UTC(year, month - 1, day, 23, 59, 59)).toISOString();
}

/** Due moment for a rule relative to the move-in date (`YYYY-MM-DD`); null when there is no usable date. */
export function moveInFormDueAt(rule: MoveInFormDueRule, moveInDateISO: string | null | undefined): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec((moveInDateISO ?? "").trim());
  if (!match) return null;
  const base = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (Number.isNaN(base)) return null;
  const due = new Date(base - (DAYS_BEFORE[rule] ?? 1) * 86_400_000);
  if (Number.isNaN(due.getTime())) return null;
  return endOfPacificDay(due.getUTCFullYear(), due.getUTCMonth() + 1, due.getUTCDate());
}

/** Whether a residency in `roomId` is in the template's audience. Whole-house forms go to every lease. */
export function templateAppliesToRoom(template: Pick<MoveInFormTemplate, "audience">, roomId: string | null | undefined): boolean {
  const audience = template.audience;
  if (audience.kind === "every-room" || audience.kind === "whole-house") return true;
  const id = (roomId ?? "").trim();
  return Boolean(id) && audience.roomIds.includes(id);
}
