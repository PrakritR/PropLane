import type { ManagerRoomSubmission } from "@/lib/manager-listing-submission";

/** What a room can include — one multi-select; empty means Unfurnished. */
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

const FURN_FULL_DEFAULT = ["Bed", "Desk", "Chair", "Dresser"];

/** Parse legacy `furnishing` text into item ids (studio 0930 migration). */
export function roomFurnitureItems(room: ManagerRoomSubmission | null | undefined): string[] {
  if (!room) return [];
  const raw = (room.furnishing ?? "").trim();
  if (!raw) return [];
  const lower = raw.toLowerCase();
  if (lower === "unfurnished") return [];
  const fromLine = raw
    .split(/[,·]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => s.toLowerCase() !== "furnished" && s.toLowerCase() !== "partly furnished");
  if (fromLine.length > 0) {
    return fromLine.map((label) => {
      const hit = ROOM_FURNITURE_ITEMS.find((x) => x.toLowerCase() === label.toLowerCase());
      return hit ?? (label === "Other" ? "Other" : label);
    });
  }
  if (lower.includes("partial") || lower.includes("partly")) return ["Bed"];
  if (lower.includes("furnished")) return FURN_FULL_DEFAULT.slice();
  return [];
}

export function roomFurnishingLabel(items: readonly string[], other?: string): string {
  const named = items
    .map((x) => (x === "Other" ? (other?.trim() || "Other") : x))
    .filter(Boolean);
  return named.length ? `Furnished · ${named.join(", ")}` : "Unfurnished";
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
