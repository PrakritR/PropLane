/**
 * Which house and room does this text mean? Pure over a live catalog. The answer is a record, or ONE line asking the
 * manager to pick: never a silent guess (design-1112 section 3.3). Matching reads the address and the title only, never
 * a record id (production slugs are misnamed).
 */

export type CatalogRoom = { id: string; name: string; rentUsd: number | null };

export type CatalogProperty = {
  id: string;
  workspaceId: string;
  ownerUserId: string;
  status: string;
  /** Street line, the label a manager recognizes ("5259 Brooklyn Ave NE"). */
  label: string;
  title: string;
  rooms: CatalogRoom[];
};

export type TargetNeed = "rent" | "available" | "description" | "photos";

export type TargetResolution =
  | { kind: "resolved"; property: CatalogProperty; room: CatalogRoom | null }
  | { kind: "ask"; question: string; candidates: string[]; reason: "ambiguous" | "no_match" | "room" };

const STOPWORDS = new Set([
  "change", "set", "make", "update", "room", "rent", "price", "rate", "to", "at", "for", "the", "of", "on", "in", "a", "an",
  "my", "available", "availability", "from", "now", "today", "please", "per", "month", "mo", "house", "home", "property",
  "listing", "new", "is", "be", "and", "it", "this", "that", "photos", "photo", "pics", "pictures", "picture", "these",
  "add", "put", "file", "are", "all", "with", "unit", "by", "date", "starting", "starts", "open", "opens", "up", "ave",
  "avenue", "st", "street", "rd", "road", "dr", "drive", "blvd", "ln", "lane", "way", "ct", "court", "pl", "place", "ne",
  "nw", "se", "sw", "n", "s", "e", "w",
]);

const ROOM_TOKEN = /\b(?:room|rm|r)\s*#?\s*(\d{1,2}[a-z]?|[a-z])\b/gi;

function norm(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function tokens(value: string): string[] {
  return norm(value).split(" ").filter(Boolean);
}

/** "5259 Brooklyn Ave NE, Seattle" -> "5259 Brooklyn Ave NE". */
export function shortLabel(address: string, title = ""): string {
  const street = address.split(",")[0]?.trim();
  return street || title.trim() || "that listing";
}

function joinChoices(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
}

function askWhichHouse(candidates: CatalogProperty[]): TargetResolution {
  const labels = candidates.map((p) => p.label).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const shown = labels.slice(0, 5);
  const more = labels.length > shown.length ? ` (and ${labels.length - shown.length} more)` : "";
  return { kind: "ask", question: `Which one: ${joinChoices(shown)}${more}?`, candidates: labels, reason: "ambiguous" };
}

function roomWanted(text: string): { token: string | null; rest: string } {
  let token: string | null = null;
  const rest = text.replace(ROOM_TOKEN, (_all, t: string) => {
    token ??= t.toLowerCase();
    return " ";
  });
  return { token, rest };
}

function roomMatches(room: CatalogRoom, token: string): boolean {
  const name = norm(room.name);
  const t = token.replace(/^0+(?=\d)/, "");
  if (name === t) return true;
  return new RegExp(`\\b(?:room|rm|r|unit|suite|bedroom|br)\\s*0*${t}\\b`).test(name);
}

export function findRoom(property: CatalogProperty, token: string): CatalogRoom[] {
  return property.rooms.filter((room) => roomMatches(room, token));
}

function addressTokens(property: CatalogProperty): Set<string> {
  return new Set([...tokens(property.label), ...tokens(property.title)]);
}

function matchesProperties(text: string, catalog: CatalogProperty[]): { matched: CatalogProperty[]; hadHint: boolean } {
  const all = tokens(text).filter((t) => !STOPWORDS.has(t));
  const numbers = all.filter((t) => /^\d{1,5}[a-z]?$/.test(t));
  const words = all.filter((t) => /^[a-z]{3,}$/.test(t));
  const hadHint = numbers.length > 0 || words.length > 0;
  if (!hadHint) return { matched: catalog, hadHint };

  let pool = catalog;
  if (numbers.length > 0) {
    const exact = pool.filter((p) => numbers.some((n) => addressTokens(p).has(n)));
    const prefix = pool.filter((p) => numbers.some((n) => /^\d+$/.test(n) && [...addressTokens(p)].some((t) => new RegExp(`^${n}[a-z]$`).test(t))));
    pool = exact.length > 0 ? exact : prefix;
    if (pool.length === 0) return { matched: [], hadHint };
  }
  if (words.length > 0) {
    const narrowed = pool.filter((p) => {
      const have = addressTokens(p);
      return words.some((w) => have.has(w) || (w.length >= 4 && [...have].some((t) => t.startsWith(w))));
    });
    if (numbers.length === 0) return { matched: narrowed, hadHint };
    if (narrowed.length > 0) pool = narrowed;
  }
  return { matched: pool, hadHint };
}

/**
 * `text` is what remains of the manager's text once the amount or date is cut out. `need` says whether this change must
 * name a room: a rent or availability on a house with several rooms must, a description or a photo set may be the house's.
 */
export function resolveTarget(text: string, catalog: CatalogProperty[], need: TargetNeed): TargetResolution {
  if (catalog.length === 0) {
    return { kind: "ask", question: "I do not see any listings in your workspace yet. Text \"new listing\" to start one.", candidates: [], reason: "no_match" };
  }
  const { token, rest } = roomWanted(String(text ?? ""));
  const { matched, hadHint } = matchesProperties(rest, catalog);
  if (matched.length === 0) {
    const labels = catalog.map((p) => p.label);
    return hadHint
      ? { kind: "ask", question: `I could not find that house. Which one: ${joinChoices(labels.slice(0, 5))}?`, candidates: labels, reason: "no_match" }
      : askWhichHouse(catalog);
  }
  // A room named in the text can narrow several houses to one (only one of them has a "Room 9").
  let pool = matched;
  if (token && pool.length > 1) {
    const withRoom = pool.filter((p) => findRoom(p, token).length > 0);
    if (withRoom.length >= 1 && withRoom.length < pool.length) pool = withRoom;
  }
  if (pool.length > 1) return askWhichHouse(pool);
  const property = pool[0]!;

  if (token) {
    const rooms = findRoom(property, token);
    if (rooms.length === 1) return { kind: "resolved", property, room: rooms[0]! };
    const names = property.rooms.map((r) => r.name).filter(Boolean);
    return {
      kind: "ask",
      question: rooms.length > 1
        ? `Which room at ${property.label}: ${joinChoices(rooms.map((r) => r.name))}?`
        : names.length > 0
          ? `${property.label} has no Room ${token.toUpperCase()}. Which room: ${joinChoices(names)}?`
          : `${property.label} has no rooms listed. Do you mean the whole house?`,
      candidates: rooms.map((r) => r.name),
      reason: "room",
    };
  }
  if ((need === "rent" || need === "available") && property.rooms.length > 1) {
    return { kind: "ask", question: `Which room at ${property.label}: ${joinChoices(property.rooms.map((r) => r.name))}?`, candidates: property.rooms.map((r) => r.name), reason: "room" };
  }
  return { kind: "resolved", property, room: need !== "description" && need !== "photos" && property.rooms.length === 1 ? property.rooms[0]! : null };
}

/** Does the text name a house (a street number or a street word)? A bare "room 4" does not. */
export function hasPropertyHint(text: string): boolean {
  const { rest } = roomWanted(String(text ?? ""));
  return tokens(rest).some((t) => !STOPWORDS.has(t) && (/^\d{1,5}[a-z]?$/.test(t) || /^[a-z]{3,}$/.test(t)));
}

/** Does the text name a room ("room 4", "r4")? */
export function hasRoomHint(text: string): boolean {
  return roomWanted(String(text ?? "")).token !== null;
}
