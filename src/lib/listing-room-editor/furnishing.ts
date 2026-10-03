import type { ManagerRoomSubmission } from "@/lib/manager-listing-submission";

/** What a room can include — one multi-select; empty means Not furnished. */
export const ROOM_FURNITURE_ITEMS = [
  "Bed",
  "Desk",
  "Chair",
  "Dresser",
  "Wardrobe",
  "Nightstand",
  "Bookshelf",
  "Mirror",
  "Lamp",
  "Rug",
  "Other",
] as const;

/**
 * Old free-text presets that never named an item. They do not count as a
 * selection — the field shows exactly what is ticked, and nothing ticked reads
 * "Not furnished" (captain, Oct 3). No furniture is invented from them.
 */
const LEGACY_FURNISHING_PHRASES = new Set([
  "furnished",
  "unfurnished",
  "not furnished",
  "fully furnished",
  "partially furnished",
  "partly furnished",
]);

/** The ticked furniture, read back from the room's stored `furnishing` line. */
export function roomFurnitureItems(room: ManagerRoomSubmission | null | undefined): string[] {
  if (!room) return [];
  const raw = (room.furnishing ?? "").trim();
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(/[,·]|\band\b/i)) {
    const label = part.trim();
    if (!label || LEGACY_FURNISHING_PHRASES.has(label.toLowerCase())) continue;
    const hit = ROOM_FURNITURE_ITEMS.find((x) => x.toLowerCase() === label.toLowerCase());
    const item = hit ?? label;
    if (!out.includes(item)) out.push(item);
  }
  return out;
}

export function roomFurnishingLabel(items: readonly string[], other?: string): string {
  const named = items
    .map((x) => (x === "Other" ? (other?.trim() || "Other") : x))
    .filter(Boolean);
  return named.length ? `Furnished · ${named.join(", ")}` : "Not furnished";
}

/** Persist items back onto the room's legacy `furnishing` string. */
export function applyRoomFurnitureItems(room: ManagerRoomSubmission, items: readonly string[], other?: string): Partial<ManagerRoomSubmission> {
  const list = items.filter((x) => x !== "Other" || (other?.trim() ?? "").length > 0);
  const line = list.length ? roomFurnishingLabel(list, other) : "";
  return { furnishing: line };
}

export function serializeFurnishingLine(items: readonly string[]): string {
  if (!items.length) return "";
  return items.join(", ");
}
