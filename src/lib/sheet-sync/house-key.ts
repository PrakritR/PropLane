import { cellText, compactKey } from "@/lib/sheet-sync/csv";

/** Seattle Sales tabs, plus a lowercase slug for any other house tab. */
export function inferHouseKey(raw: string): string | null {
  const text = cellText(raw);
  if (!text) return null;
  if (/^room\s*\d+$/i.test(text) || /^room\d+$/i.test(compactKey(text))) return null;
  if (/5257/.test(text)) return "5257";
  if (/5259/.test(text)) return "5259";
  if (/4709|8th\s*ave/i.test(text)) return "4709A";
  const key = compactKey(text.replace(/seattle/gi, ""));
  if (!key || key === "residents" || key === "sheet" || /^sheet\d+$/.test(key)) return null;
  if (key.length < 3) return null;
  return key;
}

export function inferOccupancyHouseKey(cells: readonly string[], previous: string | null): string | null {
  for (const cell of cells.slice(0, 3)) {
    const key = inferHouseKey(cell);
    if (key) return key;
  }
  return previous;
}

export function parseRoomNumber(raw: string): number | null {
  const text = cellText(raw);
  if (!text) return null;
  const labeled = /^room\s*(\d+)$/i.exec(text);
  if (labeled) return Number(labeled[1]);
  if (/^\d{1,2}$/.test(text)) {
    const n = Number(text);
    return n >= 1 && n <= 20 ? n : null;
  }
  const embedded = /room\s*(\d+)/i.exec(text);
  return embedded ? Number(embedded[1]) : null;
}

export function namesOverlap(a: string, b: string): boolean {
  const left = cellText(a).toLowerCase();
  const right = cellText(b).toLowerCase();
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.includes(right) || right.includes(left)) return true;
  const leftParts = left.split(" ").filter((p) => p.length > 2);
  const rightParts = right.split(" ").filter((p) => p.length > 2);
  return leftParts.some((part) => rightParts.includes(part));
}

export function listingMatchesHouseKey(
  houseKey: string,
  listing: { address?: string | null; title?: string | null; buildingName?: string | null },
): boolean {
  const hay = `${listing.address ?? ""} ${listing.title ?? ""} ${listing.buildingName ?? ""}`;
  if (houseKey === "5257") return /5257/.test(hay);
  if (houseKey === "5259") return /5259/.test(hay);
  if (houseKey === "4709A") return /4709|8th\s*ave/i.test(hay);
  const token = houseKey.replace(/[^a-z0-9]/gi, "");
  return token.length >= 3 && compactKey(hay).includes(token.toLowerCase());
}
