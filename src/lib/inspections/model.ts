import { z } from "zod";

export const INSPECTION_CONDITIONS = {
  unchecked: "Not checked", good: "Good", fair: "Wear / fair", damaged: "Damaged", na: "Not applicable",
} as const;
/** Stored assignment values may be catalog keys; never show those keys as room names. */
export function inspectionRoomLabel(value: string) {
  return value.includes("::") ? "Assigned room" : value;
}

export type InspectionRole = "manager" | "resident";
export type InspectionKind = "move-in" | "move-out";
export type InspectionStatus = "draft" | "submitted" | "completed";
export type InspectionPhoto = { id: string; path: string; uploadedBy: string; uploadedAt: string; sourceRef?: string; url?: string };
export type InspectionObservation = { condition: keyof typeof INSPECTION_CONDITIONS; notes: string; photos: InspectionPhoto[] };
export type InspectionItem = { id: string; label: string; manager: InspectionObservation; resident: InspectionObservation };
export type InspectionArea = { id: string; label: string; items: InspectionItem[] };
export type InspectionHistory = { action: string; role: InspectionRole; userId: string; at: string };
export type InspectionDocument = {
  /** New reports pin the actual room assignment; legacy reports retain their saved shape. */
  roomScope?: { assignment: string; label: string };
  areas: InspectionArea[];
  history: InspectionHistory[];
  residentAcknowledgment: { userId: string; at: string } | null;
};
export type InspectionRecord = {
  id: string; application_id: string; manager_user_id: string; property_id: string;
  resident_email: string; resident_user_id: string | null; resident_name: string;
  property_label: string; room_label: string; kind: InspectionKind; status: InspectionStatus;
  inspection_date: string; baseline_id: string | null; revision: number;
  document: InspectionDocument; created_at: string; updated_at: string;
};
export type InspectionResidency = { id: string; name: string; property: string; room: string; canCreate: boolean; requiredKinds?: InspectionKind[] };
export type InspectionDetail = { report: InspectionRecord; baseline: InspectionRecord | null; canEdit: boolean };
export type InspectionSummary = Omit<InspectionRecord, "document" | "resident_email" | "resident_user_id">;

const roomItems = ["Doors, knobs & locks", "Flooring & baseboards", "Walls & ceiling", "Window coverings", "Windows, locks & screens", "Light fixtures & fans", "Switches & outlets", "Closets, doors & tracks", "Other"];
const template: [string, string[]][] = [
  ["Bedroom / private room", roomItems],
  ["Bathroom", [...roomItems.slice(0, 7), "Toilet", "Tub & shower", "Shower door / curtain", "Sink & faucets", "Plumbing & drains", "Exhaust fan", "Towel racks & toilet paper holder", "Cabinets & counters", "Other"]],
  ["Kitchen", ["Flooring & baseboards", "Walls & ceiling", "Windows & coverings", "Lights, switches & outlets", "Range, fan & hood", "Oven & microwave", "Refrigerator", "Dishwasher", "Sink & disposal", "Faucets & plumbing", "Cabinets & counters", "Other"]],
  ["Living room", roomItems], ["Dining room", roomItems], ["Other room", roomItems],
  ["Entry", ["Security / screen doors", "Doors, knobs & locks", "Flooring & baseboards", "Walls & ceiling", "Lights, switches & outlets", "Fireplace equipment", "Other"]],
  ["Hall & stairs", ["Flooring & baseboards", "Walls & ceiling", "Lights, switches & outlets", "Closets & cabinets", "Railings & banisters", "Other"]],
  ["Laundry", ["Faucets & valves", "Plumbing & drains", "Washer & dryer", "Cabinets & counters", "Other"]],
  ["Systems", ["Furnace & thermostat", "Air conditioning", "Water heater", "Water softener", "Other"]],
  ["Front yard & exterior", ["Landscaping", "Fences & gates", "Sprinklers & timers", "Walks & driveway", "Porches & stairs", "Mailbox", "Light fixtures", "Building exterior", "Other"]],
  ["Garage & parking", ["Garage door", "Other doors", "Driveway & floor", "Cabinets & counters", "Lights, switches & outlets", "Electrical / exposed wiring", "Windows", "Storage & shelving", "Other"]],
  ["Back & side yard", ["Patio, deck & balcony", "Patio covers", "Landscaping", "Sprinklers & timers", "Pool & equipment", "Spa & equipment", "Fences & gates", "Other"]],
  ["Safety & security", ["Smoke & CO detectors", "Security system", "Security window bars", "Other"]],
  ["Keys & access", ["Room keys", "House keys", "Mailbox keys", "Fobs & remotes", "Other"]],
];
export function createInspectionDocument(): InspectionDocument {
  const observation = (): InspectionObservation => ({ condition: "unchecked", notes: "", photos: [] });
  return { areas: template.map(([label, items], a) => ({ id: `area-${a}`, label,
    items: items.map((label, i) => ({ id: `area-${a}-item-${i}`, label, manager: observation(), resident: observation() })),
  })), history: [], residentAcknowledgment: null };
}
export const createInspectionSchema = z.object({
  applicationId: z.string().trim().min(1).max(100), kind: z.enum(["move-in", "move-out"]),
  inspectionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
    const date = new Date(`${value}T12:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }, "Choose a valid inspection date"),
  baselineId: z.string().uuid().nullable().optional(),
}).strict();
export const saveInspectionSchema = z.object({
  revision: z.number().int().positive(),
  observations: z.array(z.object({
    itemId: z.string().max(100), condition: z.enum(["unchecked", "good", "fair", "damaged", "na"]),
    notes: z.string().max(3000),
  }).strict()).max(250),
}).strict();
export const transitionInspectionSchema = z.object({
  revision: z.number().int().positive(), action: z.enum(["submit", "acknowledge", "complete", "reopen"]),
}).strict();

export class InspectionError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

/** Copy only the caller's observations; identity, peer observations and photos are server-owned. */
export function applyInspectionObservations(report: InspectionRecord, role: InspectionRole, raw: unknown): InspectionDocument {
  const input = saveInspectionSchema.parse(raw);
  if (report.status !== "draft") throw new InspectionError("This report is locked. Ask the manager to reopen it before changing observations.", 409);
  if (report.revision !== input.revision) throw new InspectionError("This report changed in another session. Reload before saving.", 409);
  const document = structuredClone(report.document);
  const items = new Map(document.areas.flatMap(area => area.items).map(item => [item.id, item]));
  const seen = new Set<string>();
  for (const update of input.observations) {
    const item = items.get(update.itemId);
    if (!item || seen.has(update.itemId)) throw new InspectionError("Unknown or repeated checklist item.");
    seen.add(update.itemId);
    item[role].condition = update.condition;
    item[role].notes = update.notes;
  }
  return document;
}

export function transitionInspection(report: InspectionRecord, role: InspectionRole, userId: string, raw: unknown, now = new Date().toISOString()) {
  const input = transitionInspectionSchema.parse(raw);
  if (report.revision !== input.revision) throw new InspectionError("This report changed in another session. Reload before continuing.", 409);
  const document = structuredClone(report.document);
  let status = report.status;
  if (input.action === "submit") {
    if (role !== "manager") throw new InspectionError("Only the manager can request confirmation. Your photos and notes are already saved.", 403);
    if (status !== "draft") throw new InspectionError("Only a draft can be submitted.", 409);
    const meaningful = document.areas.flatMap(a => a.items).some(i => [i.resident, i.manager].some(o => o.condition !== "unchecked" || o.notes.trim() || o.photos.length));
    if (!meaningful) throw new InspectionError("Record at least one observation before submitting.");
    status = "submitted";
  } else if (input.action === "acknowledge") {
    if (role !== "resident" || status !== "submitted" || document.residentAcknowledgment) throw new InspectionError("Resident acknowledgment is only available once on a submitted report.", 409);
    document.residentAcknowledgment = { userId, at: now };
  } else if (input.action === "complete") {
    if (role !== "manager" || status !== "submitted" || !document.residentAcknowledgment) throw new InspectionError("The resident must acknowledge the submitted report before the manager completes it.", 409);
    status = "completed";
  } else {
    if (role !== "manager" || status !== "submitted") throw new InspectionError("Only a manager can reopen a submitted report. Completed reports are permanent.", 409);
    status = "draft";
    document.residentAcknowledgment = null;
  }
  document.history.push({ action: input.action, role, userId, at: now });
  return { status, document };
}
