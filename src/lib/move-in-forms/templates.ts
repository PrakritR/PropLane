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
  type MoveInFormKind,
  type MoveInFormMoveOutDays,
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
const TRIGGERS: readonly MoveInFormTrigger[] = [
  "application-submitted", "application-approved", "lease-signed", "before-move-out", "manual",
];
const DUE_RULES: readonly MoveInFormDueRule[] = [
  "day-before", "move-in-day", "3-days-before", "7-days-before",
  "3-days-after-sent", "7-days-after-sent",
  "move-out-day", "3-days-before-move-out", "7-days-before-move-out",
];
const KINDS: readonly MoveInFormKind[] = ["intake", "move-in", "move-out", "other"];
export const MOVE_OUT_DAYS_OPTIONS: readonly MoveInFormMoveOutDays[] = [7, 14, 30];
const MAX_LINKS = 60;
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

/* ----------------------------------------------------------- default kind forms */

export type MoveInFormDefaultKind = Exclude<MoveInFormKind, "other">;
export const MOVE_IN_FORM_DEFAULT_KINDS: readonly MoveInFormDefaultKind[] = ["intake", "move-in", "move-out"];

/** Stable ids: every property holds exactly these three, whatever else it adds. */
export const MOVE_IN_FORM_DEFAULT_IDS: Record<MoveInFormDefaultKind, string> = {
  intake: "default-intake",
  "move-in": "default-move-in",
  "move-out": "default-move-out",
};

export function moveInFormDefaultKindOfId(id: string): MoveInFormDefaultKind | null {
  return MOVE_IN_FORM_DEFAULT_KINDS.find((kind) => MOVE_IN_FORM_DEFAULT_IDS[kind] === id) ?? null;
}

export function isDefaultMoveInForm(template: Pick<MoveInFormTemplate, "id">): boolean {
  return moveInFormDefaultKindOfId(template.id) !== null;
}

type DefaultFormDefinition = {
  name: string;
  trigger: MoveInFormTrigger;
  due: MoveInFormDueRule;
  moveOutDaysBefore: MoveInFormMoveOutDays;
  questions: MoveInFormQuestion[];
};

const yes = (fieldKey: string) => ({ fieldKey, equals: "yes" });

const DEFAULT_FORM_DEFINITIONS: Record<MoveInFormDefaultKind, DefaultFormDefinition> = {
  intake: {
    name: "Intake form",
    trigger: "application-submitted",
    due: "3-days-after-sent",
    moveOutDaysBefore: 14,
    questions: [
      question("legal_name", "Legal name", "text", { required: true, section: "About you" }),
      question("date_of_birth", "Date of birth", "date", { required: true, section: "About you" }),
      question("phone", "Phone number", "phone", { required: true, section: "About you" }),
      question("current_address", "Current address", "text", { required: true, section: "About you" }),
      question("emergency_contact_name", "Emergency contact name", "text", { required: true, section: "Emergency contact" }),
      question("emergency_contact_phone", "Emergency contact phone", "phone", { required: true, section: "Emergency contact" }),
      question("emergency_contact_relationship", "Relationship", "text", { required: true, section: "Emergency contact" }),
      question("has_vehicle", "Will you park a vehicle at the property?", "yes_no", { required: true, section: "Vehicle and pets" }),
      question("vehicle_make", "Vehicle make", "text", { required: true, section: "Vehicle and pets", showIf: yes("has_vehicle") }),
      question("vehicle_model", "Vehicle model", "text", { required: true, section: "Vehicle and pets", showIf: yes("has_vehicle") }),
      question("vehicle_plate", "License plate", "text", { required: true, section: "Vehicle and pets", showIf: yes("has_vehicle") }),
      question("has_pets", "Are you bringing a pet?", "yes_no", { required: true, section: "Vehicle and pets" }),
      question("pet_description", "Describe your pet", "long_text", { required: true, section: "Vehicle and pets", showIf: yes("has_pets") }),
      question("anything_to_know", "Anything we should know", "long_text", { section: "Anything else" }),
      question("signature", "Sign to confirm the above", "signature", { required: true, section: "Signature" }),
    ],
  },
  "move-in": {
    name: "Move-in form",
    trigger: "lease-signed",
    due: "day-before",
    moveOutDaysBefore: 14,
    questions: [
      question("move_in_date", "Move-in date", "date", { required: true, section: "Arrival" }),
      question("arrival_time", "Arrival time", "text", { required: true, section: "Arrival" }),
      question("keys_received", "Keys received", "yes_no", { required: true, section: "Keys and access" }),
      question("door_code_works", "The door code works", "yes_no", { required: true, section: "Keys and access" }),
      question("room_condition_notes", "Room condition notes", "long_text", { section: "Room condition" }),
      question("room_photos", "Room photos", "photos", { required: true, section: "Room condition" }),
      question("utilities_set_up", "Utilities set up", "yes_no", { required: true, section: "Utilities" }),
      question("signature", "Sign to confirm the above", "signature", { required: true, section: "Signature" }),
    ],
  },
  "move-out": {
    name: "Move-out form",
    trigger: "before-move-out",
    due: "move-out-day",
    moveOutDaysBefore: 14,
    questions: [
      question("move_out_date", "Move-out date", "date", { required: true, section: "Departure" }),
      question("move_out_time", "Move-out time", "text", { required: true, section: "Departure" }),
      question("forwarding_address", "Forwarding address", "text", { required: true, section: "Departure" }),
      question("keys_returned", "Keys returned", "yes_no", { required: true, section: "Keys and cleaning" }),
      question("cleaning_done", "Cleaning done", "yes_no", { required: true, section: "Keys and cleaning" }),
      question("condition_notes", "Condition notes", "long_text", { section: "Room condition" }),
      question("condition_photos", "Photos", "photos", { required: true, section: "Room condition" }),
      question("deposit_refund_method", "Deposit refund method", "select", {
        required: true, section: "Deposit", options: ["Direct deposit", "Check", "Other"],
      }),
      question("signature", "Sign to confirm the above", "signature", { required: true, section: "Signature" }),
    ],
  },
};

/** A fresh copy of one default form, exactly as it ships (also what "Reset to default questions" restores). */
export function defaultMoveInForm(kind: MoveInFormDefaultKind, timestamps?: { createdAt?: string; updatedAt?: string }): MoveInFormTemplate {
  const definition = DEFAULT_FORM_DEFINITIONS[kind];
  const now = starterTimestamp();
  return {
    id: MOVE_IN_FORM_DEFAULT_IDS[kind],
    name: definition.name,
    source: "built",
    questions: structuredClone(definition.questions),
    pdf: null,
    audience: { kind: "every-room" },
    trigger: definition.trigger,
    due: definition.due,
    kind,
    moveOutDaysBefore: definition.moveOutDaysBefore,
    linkedApplicationTemplateIds: [],
    linkedLeaseTemplateIds: [],
    createdAt: timestamps?.createdAt ?? "2026-10-03T00:00:00.000Z",
    updatedAt: timestamps?.updatedAt ?? now,
  };
}

/** Reset a default form's questions (and its Sends/Due) to the shipped ones, keeping its audience and links. */
export function resetMoveInFormToDefault(template: MoveInFormTemplate): MoveInFormTemplate {
  const kind = moveInFormDefaultKindOfId(template.id);
  if (!kind) return template;
  const fresh = defaultMoveInForm(kind, { createdAt: template.createdAt });
  return { ...fresh, audience: template.audience, linkedApplicationTemplateIds: template.linkedApplicationTemplateIds, linkedLeaseTemplateIds: template.linkedLeaseTemplateIds };
}

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
    kind: "other" as const,
    moveOutDaysBefore: 14 as const,
    linkedApplicationTemplateIds: [] as string[],
    linkedLeaseTemplateIds: [] as string[],
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
    kind: "other",
    moveOutDaysBefore: 14,
    linkedApplicationTemplateIds: [],
    linkedLeaseTemplateIds: [],
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

function normalizeIdList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const ids = raw
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().slice(0, 120))
    .filter((item) => item.length > 0);
  return [...new Set(ids)].slice(0, MAX_LINKS);
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
  // A default form's kind is fixed by its id; anything stored before kinds existed reads as "other".
  const defaultKind = moveInFormDefaultKindOfId(id);
  const storedKind = KINDS.includes(raw.kind as MoveInFormKind) ? (raw.kind as MoveInFormKind) : "other";
  const days = Number(raw.moveOutDaysBefore);
  return {
    id,
    name: text(raw.name, 120),
    source,
    questions,
    pdf,
    audience: normalizeAudience(raw.audience),
    trigger,
    due: DUE_RULES.includes(raw.due as MoveInFormDueRule) ? (raw.due as MoveInFormDueRule) : "day-before",
    kind: defaultKind ?? storedKind,
    moveOutDaysBefore: (MOVE_OUT_DAYS_OPTIONS as readonly number[]).includes(days) ? (days as MoveInFormMoveOutDays) : 14,
    linkedApplicationTemplateIds: normalizeIdList(raw.linkedApplicationTemplateIds),
    linkedLeaseTemplateIds: normalizeIdList(raw.linkedLeaseTemplateIds),
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

/**
 * The three default forms always exist and always come first, in Intake, Move-in, Move-out order.
 * A saved list that lacks one (older data, or a client that dropped it) gets it back here, so a
 * default can never be deleted through the property JSON the client can write. Every other form keeps
 * its place after them. A default the saved list lacks comes back as `restoredTrigger` when given (a
 * property that saved its forms before these existed must not start messaging residents unasked).
 */
export function withDefaultMoveInForms(
  list: readonly MoveInFormTemplate[],
  options: { restoredTrigger?: MoveInFormTrigger } = {},
): MoveInFormTemplate[] {
  const pinned = MOVE_IN_FORM_DEFAULT_KINDS.map((kind) => {
    const existing = list.find((item) => item.id === MOVE_IN_FORM_DEFAULT_IDS[kind]);
    if (existing) return existing;
    const fresh = defaultMoveInForm(kind);
    return options.restoredTrigger ? { ...fresh, trigger: options.restoredTrigger } : fresh;
  });
  return [...pinned, ...list.filter((item) => !isDefaultMoveInForm(item))];
}

function submissionRecord(listingSubmission: unknown): Record<string, unknown> | null {
  return isRecord(listingSubmission) ? listingSubmission : null;
}

/**
 * The property's forms: the three default forms first (always), then the rest. When the key was never
 * written (a property nobody has touched here) the five starters follow them. Once the manager
 * saves anything the stored list is the truth, even if it is empty.
 */
export function readMoveInFormTemplates(listingSubmission: unknown): MoveInFormTemplate[] {
  const submission = submissionRecord(listingSubmission);
  if (!submission || !("moveInFormTemplates" in submission) || submission.moveInFormTemplates === undefined) {
    return structuredClone([...withDefaultMoveInForms(MOVE_IN_FORM_STARTERS)]);
  }
  // A saved list that lacks a default (older data) gets it back as "Only when I send it".
  return withDefaultMoveInForms(normalizeMoveInFormTemplates(submission.moveInFormTemplates), { restoredTrigger: "manual" });
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

type DueAnchor = "move-in" | "sent" | "lease-end";

/** Which date a rule counts from, and by how many days (negative = before the anchor). */
const DUE_OFFSETS: Record<MoveInFormDueRule, { anchor: DueAnchor; days: number }> = {
  "day-before": { anchor: "move-in", days: -1 },
  "move-in-day": { anchor: "move-in", days: 0 },
  "3-days-before": { anchor: "move-in", days: -3 },
  "7-days-before": { anchor: "move-in", days: -7 },
  "3-days-after-sent": { anchor: "sent", days: 3 },
  "7-days-after-sent": { anchor: "sent", days: 7 },
  "move-out-day": { anchor: "lease-end", days: 0 },
  "3-days-before-move-out": { anchor: "lease-end", days: -3 },
  "7-days-before-move-out": { anchor: "lease-end", days: -7 },
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

/** `YYYY-MM-DD` of an instant on the Pacific wall clock. */
function pacificDateOf(instant: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(instant);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Which of the three dates a rule counts from. */
export function moveInFormDueAnchor(rule: MoveInFormDueRule): DueAnchor {
  return DUE_OFFSETS[rule]?.anchor ?? "move-in";
}

export type MoveInFormDueDates = {
  /** Move-in date (`YYYY-MM-DD`). */
  moveInDate?: string | null;
  /** Lease end date (`YYYY-MM-DD`). */
  leaseEnd?: string | null;
  /** When the form goes out; defaults to now. */
  sentAt?: Date;
};

/**
 * Due moment for a rule: end of the due day (Pacific). Counts from the move-in date, the day the
 * form is sent, or the lease end date, per the rule. Null when the rule's anchor date is unusable.
 */
export function moveInFormDueFor(rule: MoveInFormDueRule, dates: MoveInFormDueDates): string | null {
  const offset = DUE_OFFSETS[rule] ?? DUE_OFFSETS["day-before"];
  const anchorISO = offset.anchor === "move-in" ? dates.moveInDate
    : offset.anchor === "lease-end" ? dates.leaseEnd
    : pacificDateOf(dates.sentAt ?? new Date());
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec((anchorISO ?? "").trim());
  if (!match) return null;
  const base = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (Number.isNaN(base)) return null;
  const due = new Date(base + offset.days * 86_400_000);
  if (Number.isNaN(due.getTime())) return null;
  return endOfPacificDay(due.getUTCFullYear(), due.getUTCMonth() + 1, due.getUTCDate());
}

/** Due moment for a rule relative to the move-in date (`YYYY-MM-DD`); null when there is no usable date. */
export function moveInFormDueAt(rule: MoveInFormDueRule, moveInDateISO: string | null | undefined): string | null {
  return moveInFormDueFor(rule, { moveInDate: moveInDateISO });
}

/**
 * Whether a form's links admit a residency. An empty list means "all"; otherwise the residency's
 * own application or lease template id must be listed. A residency whose id is unknown matches only
 * an empty list: an unknown is never guessed into a linked form.
 */
export function templateLinkMatches(linked: readonly string[], residencyTemplateId: string | null | undefined): boolean {
  if (linked.length === 0) return true;
  const id = (residencyTemplateId ?? "").trim();
  return Boolean(id) && linked.includes(id);
}

/** Whether a residency in `roomId` is in the template's audience. Whole-house forms go to every lease. */
export function templateAppliesToRoom(template: Pick<MoveInFormTemplate, "audience">, roomId: string | null | undefined): boolean {
  const audience = template.audience;
  if (audience.kind === "every-room" || audience.kind === "whole-house") return true;
  const id = (roomId ?? "").trim();
  return Boolean(id) && audience.roomIds.includes(id);
}
