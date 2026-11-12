/**
 * Pure: the facts of one stay message, built from the stay, the property record and the settings (design-1112 §7).
 *
 * The guest's room is found by its STRUCTURED room id and its code is that room's own `doorCode`, nothing else: never
 * the house code, never another room, never `houseInfo.internal`. Every other room's code and the Internal section are
 * returned as a deny list, so the builder can refuse a body that somehow carries one.
 */
import { createHash } from "node:crypto";
import { getHouseInfoValue, HOUSE_INTERNAL_SECTION_ID, houseInfoWithoutInternal } from "@/lib/house-info";
import { wallInstantIso } from "@/lib/bookings/stay-times";
import type { StayMessageFacts, StayMessageSettings } from "@/lib/stay-messages/templates";
import type { StayCandidate, StayMessageKind, StayProperty } from "@/lib/stay-messages/types";
import { checkInDueAt } from "@/lib/stay-messages/schedule";

function firstName(name: string): string {
  const first = name.trim().split(/\s+/)[0] ?? "";
  return /^(airbnb|booking)/i.test(first) ? "" : first;
}

function dayWord(candidate: StayCandidate, now: Date, timeZone: string): string {
  const local = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const today = local(now);
  const tomorrow = local(new Date(now.getTime() + 24 * 3_600_000));
  if (candidate.checkIn === today) return "today";
  if (candidate.checkIn === tomorrow) return "tomorrow";
  const at = new Date(wallInstantIso(candidate.checkIn, "12:00", timeZone));
  return `on ${new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric" }).format(at)}`;
}

/** Every secret value in the Internal section (pantry / lockbox / mailbox codes): never allowed into a message. */
function internalSecrets(property: StayProperty): string[] {
  const internal = property.houseInfo[HOUSE_INTERNAL_SECTION_ID] ?? {};
  return Object.values(internal).map((value) => String(value ?? "").trim()).filter(Boolean);
}

export function buildStayFacts(input: {
  kind: StayMessageKind;
  candidate: StayCandidate;
  property: StayProperty;
  settings: StayMessageSettings;
  now: Date;
}): StayMessageFacts {
  const { candidate, property, settings, now } = input;
  const info = houseInfoWithoutInternal(property.houseInfo);
  const room = property.rooms.find((candidateRoom) => candidateRoom.id === candidate.roomId) ?? null;
  const own = room?.doorCode.trim() ?? "";
  const otherCodes = property.rooms.filter((other) => other.id !== room?.id).map((other) => other.doorCode.trim()).filter(Boolean);
  const checkoutSteps = ["trash", "keys", "lights", "other"].map((key) => (info.checkout?.[key] ?? "").trim()).filter(Boolean);
  const timeZone = property.timeZone;
  return {
    kind: input.kind,
    firstName: firstName(candidate.guestName),
    propertyLabel: property.label,
    roomLabel: room?.label.trim() ?? "",
    roomResolved: Boolean(room),
    houseHasRooms: property.rooms.length > 0 && Boolean(candidate.roomId) && candidate.roomId !== candidate.propertyId,
    addressLine: property.addressLine,
    checkInDay: dayWord(candidate, now, timeZone),
    checkInTime: candidate.checkInTime,
    checkOutTime: candidate.checkOutTime,
    frontDoorCode: getHouseInfoValue(info, "access", "doorCode"),
    gateCode: getHouseInfoValue(info, "access", "gateCode"),
    roomDoorCode: own,
    wifiNetwork: getHouseInfoValue(info, "wifi", "network"),
    wifiPassword: getHouseInfoValue(info, "wifi", "password"),
    bathroomRule: getHouseInfoValue(info, "rules", "bathroom"),
    checkoutSteps,
    contactPhoneE164: settings.contactPhone[candidate.source],
    forbiddenCodes: [...otherCodes, ...internalSecrets(property)],
  };
}

/** What a correction compares: the room, its code and the dates/times. A hash, so a code is never stored. */
export function stayFactsHash(candidate: StayCandidate, property: StayProperty): string {
  const room = property.rooms.find((candidateRoom) => candidateRoom.id === candidate.roomId);
  return createHash("sha256")
    .update(JSON.stringify([candidate.roomId, room?.doorCode.trim() ?? "", candidate.checkIn, candidate.checkOut, candidate.checkInTime, candidate.checkOutTime]))
    .digest("hex");
}

export { checkInDueAt };
