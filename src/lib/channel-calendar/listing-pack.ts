import { getPropertyById } from "@/lib/rental-application/data";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";

export type AirbnbListingPack = {
  title: string;
  propertyLine: string;
  description: string;
  amenities: string[];
  houseRules: string;
  pricing: string;
  photoUrls: string[];
  text: string;
};

const TITLE_MAX = 32;

function trimTitle(raw: string): string {
  if (raw.length <= TITLE_MAX) return raw;
  return `${raw.slice(0, TITLE_MAX - 1).trimEnd()}…`;
}

function splitList(text: string | undefined): string[] {
  return (text ?? "").split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
}

/** Pure: builds the pack from an already-loaded listing submission. */
export function buildAirbnbListingPackFromSubmission(
  sub: Pick<ManagerListingSubmissionV1, "rooms" | "city" | "neighborhood" | "houseOverview" | "houseRulesText" | "housePhotoDataUrls" | "buildingName" | "address" | "petFriendly"> | undefined,
  roomId: string,
): AirbnbListingPack {
  const room = sub?.rooms?.find((r) => r.id === roomId);
  const place = (sub?.neighborhood || sub?.city || "").trim();
  const title = trimTitle(place ? `Private room · ${place}` : "Private room");
  const propertyLine = [sub?.buildingName, sub?.address, sub?.city].map((s) => (s ?? "").trim()).filter(Boolean).join(", ");
  const description = (sub?.houseOverview ?? "").trim();
  const amenities = splitList(room?.roomAmenitiesText);
  if (sub?.petFriendly && !amenities.some((a) => /pet/i.test(a))) amenities.push("Pets allowed");
  const houseRules = (sub?.houseRulesText ?? "").trim();
  const rent = Number(room?.monthlyRent ?? 0);
  const nightly = rent > 0 ? Math.ceil((rent / 30) * 1.2) : 0;
  const pricing = rent > 0
    ? `Nightly $${nightly} · 28-night discount to match $${rent}/month`
    : "Set the room's monthly rent in PropLane to get a nightly price";
  const photoUrls = [...(room?.photoDataUrls ?? []), ...(sub?.housePhotoDataUrls ?? [])].filter((u) => typeof u === "string" && u.trim());
  const text = [
    `Title: ${title}`,
    `Property: ${propertyLine || "—"}`,
    `Description: ${description || "—"}`,
    `Amenities: ${amenities.join(", ") || "—"}`,
    `House rules: ${houseRules || "—"}`,
    `Pricing: ${pricing}`,
    `Photos (${photoUrls.length}):`,
    ...photoUrls.map((u, i) => `${i + 1}. ${u.startsWith("data:") ? "embedded photo (open the room in PropLane to save it)" : u}`),
  ].join("\n");
  return { title, propertyLine, description, amenities, houseRules, pricing, photoUrls, text };
}

export function buildAirbnbListingPack({ propertyId, roomId }: { propertyId: string; roomId: string }): AirbnbListingPack {
  const sub = getPropertyById(propertyId)?.listingSubmission;
  return buildAirbnbListingPackFromSubmission(sub?.v === 1 ? sub : undefined, roomId);
}
