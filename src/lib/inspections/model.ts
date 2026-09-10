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
/** The resident's one-way handoff: their side closes until a manager reopens it. */
export type InspectionResidentSubmission = { userId: string; at: string };
export type InspectionDocument = {
  /** New reports pin the actual room assignment; legacy reports retain their saved shape. */
  roomScope?: { assignment: string; label: string };
  areas: InspectionArea[];
  history: InspectionHistory[];
  /**
   * Set when the RESIDENT submits their photos. It closes the resident's own side only —
   * the manager keeps adding photos throughout — and only a manager can clear it.
   */
  residentSubmission?: InspectionResidentSubmission | null;
  residentAcknowledgment: { userId: string; at: string } | null;
};
export type InspectionRecord = {
  id: string; application_id: string; manager_user_id: string; property_id: string;
  resident_email: string; resident_user_id: string | null; resident_name: string;
  property_label: string; room_label: string; kind: InspectionKind; status: InspectionStatus;
  inspection_date: string; baseline_id: string | null; revision: number;
  document: InspectionDocument; created_at: string; updated_at: string;
};
/**
 * Where a residency sits on the move-in / move-out timeline. The Inspections page is a roster
 * of people first and a list of filed reports second — a manager with residents but no reports
 * yet must still see who is due to move in and who is living there now.
 */
export type InspectionOccupancy = "upcoming" | "current" | "past";

export type InspectionResidency = {
  id: string; name: string; property: string; room: string; canCreate: boolean;
  /** Which inspections this room's own configuration requires (see ./requirements). */
  requiredKinds?: InspectionKind[];
  /** ISO `YYYY-MM-DD`, or "" when the placement carries no date yet. */
  moveInDate: string;
  moveOutDate: string;
  occupancy: InspectionOccupancy;
};

/** Today in the viewer's own day, as `YYYY-MM-DD`. Inspection dates are wall dates, not instants. */
export function inspectionToday(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/**
 * A residency with no move-in date is UPCOMING, never current: an approved applicant whose
 * dates are still blank has not moved in, and calling them current would file them under
 * move-out. A move-out date strictly before today is the only thing that makes one past, so a
 * lease ending today still counts as living there.
 */
export function residencyOccupancy(moveInDate: string, moveOutDate: string, today = inspectionToday()): InspectionOccupancy {
  const movedOut = moveOutDate && moveOutDate < today;
  if (movedOut) return "past";
  if (!moveInDate || moveInDate > today) return "upcoming";
  return "current";
}
export type InspectionDetail = { report: InspectionRecord; baseline: InspectionRecord | null; canEdit: boolean };
/**
 * Photo counts travel with every summary because the LIST is about photos now: a row says
 * how many each side has added, not which review step a report is parked on.
 */
export type InspectionPhotoCounts = { manager: number; resident: number; total: number; lastAt: string | null };
export type InspectionSummary = Omit<InspectionRecord, "document" | "resident_email" | "resident_user_id">
  & { photos: InspectionPhotoCounts };

export function inspectionPhotoCounts(document: InspectionDocument): InspectionPhotoCounts {
  const counts: InspectionPhotoCounts = { manager: 0, resident: 0, total: 0, lastAt: null };
  for (const item of document.areas.flatMap(area => area.items)) {
    for (const role of ["manager", "resident"] as const) {
      counts[role] += item[role].photos.length;
      for (const photo of item[role].photos) {
        if (!counts.lastAt || photo.uploadedAt > counts.lastAt) counts.lastAt = photo.uploadedAt;
      }
    }
  }
  counts.total = counts.manager + counts.resident;
  return counts;
}

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
export const inspectionSubmissionSchema = z.object({
  revision: z.number().int().positive(), action: z.enum(["submit", "reopen"]),
}).strict();

export const ensureInspectionSchema = z.object({
  applicationId: z.string().trim().min(1).max(100), kind: z.enum(["move-in", "move-out"]),
}).strict();

export class InspectionError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

/**
 * A resident who has submitted cannot write again until a manager reopens their side. The
 * check lives here rather than in the UI: hiding the button is a courtesy, refusing the
 * write is the rule.
 */
export function assertInspectionWritable(report: InspectionRecord, role: InspectionRole) {
  if (role === "resident" && report.document.residentSubmission) {
    throw new InspectionError("You have submitted these photos. Ask your manager to reopen the report before adding more.", 409);
  }
}

/**
 * The resident submits once; only the manager reopens. Nothing here freezes the MANAGER's
 * side, and nothing is permanent — this is a handoff, not an approval.
 */
export function transitionResidentSubmission(report: InspectionRecord, role: InspectionRole, userId: string, raw: unknown, now = new Date().toISOString()) {
  const input = inspectionSubmissionSchema.parse(raw);
  if (report.revision !== input.revision) throw new InspectionError("This report changed in another session. Reload before continuing.", 409);
  const document = structuredClone(report.document);
  if (input.action === "submit") {
    if (role !== "resident") throw new InspectionError("Only the resident submits their own photos.", 403);
    if (document.residentSubmission) throw new InspectionError("These photos were already submitted.", 409);
    const photographed = document.areas.some(area => area.items.some(item => item.resident.photos.length > 0));
    if (!photographed) throw new InspectionError("Add at least one photo before submitting.");
    document.residentSubmission = { userId, at: now };
  } else {
    if (role !== "manager") throw new InspectionError("Only the manager can reopen the resident's side.", 403);
    if (!document.residentSubmission) throw new InspectionError("This report is already open to the resident.", 409);
    document.residentSubmission = null;
  }
  document.history.push({ action: input.action === "submit" ? "resident-submit" : "resident-reopen", role, userId, at: now });
  return { document };
}

/**
 * Copy only the caller's observations; identity, peer observations and photos are server-owned.
 *
 * A report has no locked state: move-in and move-out photos stay open to both parties for as
 * long as the residency is theirs. The revision compare-and-swap is the only gate, so two
 * people editing at once still cannot overwrite each other.
 */
export function applyInspectionObservations(report: InspectionRecord, role: InspectionRole, raw: unknown): InspectionDocument {
  const input = saveInspectionSchema.parse(raw);
  assertInspectionWritable(report, role);
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

