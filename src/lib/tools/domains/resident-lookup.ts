/**
 * ONE resolver from how a manager says it ("5259 Room 2", "room 2 at 5259", "Priya", "eden@x.com") to the
 * resident(s) it names. Every manager tool that targets a resident goes through here, so a room is always matched by
 * its DISPLAY name ("Room 2") resolved from the house's listing rooms, never against the raw `property::roomId`
 * choice an application row stores.
 *
 * The matching core is pure (`matchResidents`); `resolveManagerResidents` only loads the two inputs the core needs
 * (the manager's approved residents and the houses the actor may read).
 */
import type { DemoApplicantRow } from "@/data/demo-portal";
import { parseRoomChoiceValue } from "@/lib/rental-application/room-choice-value";
import { pacificTodayKey } from "@/lib/room-availability-range";
import type { AgentContext } from "../context";
import { calendarReadableProperties } from "./bookings";
import { loadManagerApplications } from "./residents";

export type ResidentLookupHouse = { id: string; title: string; rooms: Map<string, string> };

export type ResidentMatch = {
  row: DemoApplicantRow;
  name: string;
  email: string;
  houseId: string;
  houseTitle: string;
  /** The room's display name ("Room 2"), or "" when it cannot be resolved. */
  roomLabel: string;
  movedOut: boolean;
};

export type ParsedResidentQuery = { houseWords: string[]; roomText: string; nameWords: string[] };

const STOPWORDS = new Set([
  "at", "in", "of", "the", "a", "an", "house", "home", "resident", "tenant", "who", "lives", "living", "from", "for", "to",
  "on", "is", "and", "residing", "lease", "whos", "that", "guy", "person",
]);

const words = (s: string): string[] => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** "room 2" / "rm 2" / "unit B" / "#3": the room part of a spoken resident reference. */
const ROOM_RE = /\b(?:room|rm|unit|suite|bedroom)\s*#?\s*([a-z0-9]+)\b|#\s*([a-z0-9]+)\b/i;

function titleWordMatches(titleWord: string, token: string): boolean {
  if (titleWord === token) return true;
  // "4709" names 4709A and 4709B alike: the ambiguity is then asked, not guessed.
  return /^\d+$/.test(token) && titleWord.startsWith(token) && /^[a-z]$/.test(titleWord.slice(token.length));
}

export function parseResidentQuery(q: string, houses: ResidentLookupHouse[]): ParsedResidentQuery {
  let rest = q.trim();
  let roomText = "";
  const m = rest.match(ROOM_RE);
  if (m) {
    roomText = (m[1] ?? m[2] ?? "").toLowerCase();
    rest = `${rest.slice(0, m.index)} ${rest.slice((m.index ?? 0) + m[0].length)}`;
  }
  const houseWordSet = new Set(houses.flatMap((h) => words(h.title)));
  const houseWords: string[] = [];
  const nameWords: string[] = [];
  for (const token of words(rest)) {
    if (STOPWORDS.has(token)) continue;
    const inHouse = [...houseWordSet].some((w) => titleWordMatches(w, token));
    (inHouse ? houseWords : nameWords).push(token);
  }
  return { houseWords, roomText, nameWords };
}

function roomLabelFor(row: DemoApplicantRow, houses: Map<string, ResidentLookupHouse>): { houseId: string; roomLabel: string } {
  const choice = String(row.assignedRoomChoice ?? "").trim();
  const parsed = parseRoomChoiceValue(choice);
  const houseId = parsed.listingRoomId !== undefined || choice.includes("::")
    ? parsed.propertyId
    : String(row.assignedPropertyId ?? row.propertyId ?? "").trim() || parsed.propertyId;
  let roomLabel = "";
  if (parsed.listingRoomId) roomLabel = houses.get(houseId)?.rooms.get(parsed.listingRoomId) ?? "";
  else if (choice && !choice.includes("::") && !houses.has(choice)) roomLabel = choice; // a legacy row stores the NAME
  if (!roomLabel) roomLabel = String(row.manualResidentDetails?.roomNumber ?? "").trim();
  return { houseId: houseId || String(row.assignedPropertyId ?? row.propertyId ?? "").trim(), roomLabel };
}

function isMovedOut(row: DemoApplicantRow, today: string): boolean {
  if (row.withdrawnAt) return true;
  const out = String(row.manualResidentDetails?.moveOutDate ?? "").slice(0, 10);
  return Boolean(out) && out < today;
}

function roomMatches(label: string, roomText: string): boolean {
  if (!roomText) return true;
  const l = label.toLowerCase().trim();
  if (!l) return false;
  return l === roomText || l === `room ${roomText}` || words(l).includes(roomText);
}

/** Every resident the text names. Current residents only unless `includeMovedOut`. Pure. */
export function matchResidents(
  rows: DemoApplicantRow[],
  houseList: ResidentLookupHouse[],
  q: string,
  opts: { includeMovedOut?: boolean; today?: string } = {},
): ResidentMatch[] {
  const today = opts.today ?? pacificTodayKey();
  // A resident whose house is not among the readable ones still answers to the house label on their own row.
  const known = new Set(houseList.map((h) => h.id));
  const synthetic: ResidentLookupHouse[] = [];
  for (const row of rows) {
    const id = String(row.assignedPropertyId ?? row.propertyId ?? parseRoomChoiceValue(String(row.assignedRoomChoice ?? "")).propertyId ?? "").trim();
    const title = String(row.property ?? "").trim();
    if (id && title && !known.has(id)) {
      known.add(id);
      synthetic.push({ id, title, rooms: new Map() });
    }
  }
  const allHouses = [...houseList, ...synthetic];
  const houses = new Map(allHouses.map((h) => [h.id, h]));
  const parsed = parseResidentQuery(q, allHouses);
  const out: ResidentMatch[] = [];
  for (const row of rows) {
    if (row.bucket !== "approved" || row.mergedInto) continue;
    const movedOut = isMovedOut(row, today);
    if (movedOut && !opts.includeMovedOut) continue;
    const { houseId, roomLabel } = roomLabelFor(row, houses);
    const houseTitle = houses.get(houseId)?.title || String(row.property ?? "").trim();
    const houseTitleWords = words(houseTitle);
    if (!parsed.houseWords.every((t) => houseTitleWords.some((w) => titleWordMatches(w, t)))) continue;
    if (!roomMatches(roomLabel, parsed.roomText)) continue;
    const identity = `${row.name ?? ""} ${row.email ?? ""}`.toLowerCase();
    if (!parsed.nameWords.every((t) => identity.includes(t))) continue;
    out.push({ row, name: String(row.name ?? "").trim(), email: String(row.email ?? "").trim().toLowerCase(), houseId, houseTitle, roomLabel, movedOut });
  }
  return out;
}

const describe = (m: ResidentMatch): string => `${m.name || m.email} (${[m.houseTitle, m.roomLabel].filter(Boolean).join(" ")}${m.movedOut ? ", moved out" : ""})`;

/** The ONE question to ask when the text names none or several; null when exactly one. */
export function residentLookupQuestion(matches: ResidentMatch[], q: string): string | null {
  if (matches.length === 1) return null;
  if (matches.length === 0) return `No resident matches "${q}". Which house and room (or which name) do you mean?`;
  return `More than one resident matches "${q}": ${matches.slice(0, 5).map(describe).join("; ")}. Which one do you mean?`;
}

export async function resolveManagerResidents(
  ctx: AgentContext,
  q: string,
  opts: { includeMovedOut?: boolean } = {},
): Promise<{ matches: ResidentMatch[]; question: string | null }> {
  const [rows, properties] = await Promise.all([
    loadManagerApplications(ctx),
    // The house list only improves the room names; a read that fails falls back to the labels on the rows.
    calendarReadableProperties(ctx).catch(() => []),
  ]);
  const houses: ResidentLookupHouse[] = properties.map((p) => ({ id: p.id, title: p.title, rooms: p.rooms }));
  const matches = matchResidents(rows, houses, q, opts);
  return { matches, question: residentLookupQuestion(matches, q) };
}

/**
 * A tool argument that may be an email or a spoken reference ("5259 Room 2"): returns the one email, or throws the
 * one question to ask. An argument with an `@` is taken as the email it is.
 */
export async function resolveResidentRefToEmail(ctx: AgentContext, ref: string): Promise<string> {
  const text = ref.trim();
  if (text.includes("@")) return text.toLowerCase();
  const { matches, question } = await resolveManagerResidents(ctx, text);
  if (question || !matches[0]?.email) throw new Error(question ?? `${matches[0]?.name ?? "That resident"} has no email on file.`);
  return matches[0].email;
}

export async function expandResidentRefs(ctx: AgentContext, refs: string[] | undefined): Promise<string[] | undefined> {
  if (!refs) return refs;
  return Promise.all(refs.map((r) => resolveResidentRefToEmail(ctx, r)));
}
