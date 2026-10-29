/**
 * The Airbnb-style check-in guide: numbered steps (address, front door, your room, Wi-Fi, house guide,
 * checkout), each with its real photo and copy buttons.
 *
 * ONE builder for both audiences. A long-term resident reads it on My home > Check-in; a short-stay
 * guest reads it from the Approved row of their stay. The server builds it from the house's current
 * details and the reveal decision (`checkInReveal`); while the codes are not yet unlocked, every
 * secret VALUE is `null` in the result, so the browser is never sent a code it should not show.
 *
 * Pure: no framework or database imports. Photos are only ever the manager's own uploads; a step
 * with no photo simply has none (never a stock image).
 */
import { getHouseInfoValue, houseInfoRenderSections, type HouseInfoV1 } from "@/lib/house-info";
import { formatRevealLabel, type CheckInReveal } from "@/lib/check-in-reveal";

export type CheckInStepId = "address" | "front_door" | "room" | "wifi" | "house_guide" | "checkout";

/** `value: null` is a masked secret: the row is drawn as "Unlocks <time>" with nothing to copy. */
export type CheckInSecretRow = { label: string; value: string | null };

export type CheckInStep = {
  id: CheckInStepId;
  title: string;
  /** Plain facts under the title (parking, instructions). */
  lines: string[];
  secrets: CheckInSecretRow[];
  photoUrl: string | null;
  /** A "Open in Maps" link on the address step. */
  mapsUrl: string | null;
  /** The room step has no door code on file: the guide says "Ask your manager" and the manager is told. */
  missingCode: boolean;
};

export type CheckInGuide = {
  revealed: boolean;
  reason: CheckInReveal["reason"];
  /** "Thu 3:00 PM" when the codes unlock at a known moment; null otherwise. */
  unlockLabel: string | null;
  steps: CheckInStep[];
  /** ISO; set once the resident tapped "I'm in". */
  checkedInAt: string | null;
  /** What "I'm in" posts: `stay:<blockId>` or `tenancy:<applicationRecordId>`. Null = no tap offered. */
  checkInKey: string | null;
};

export type CheckInSource = {
  propertyLabel: string;
  addressLine: string;
  roomLabel: string;
  houseInfo: HouseInfoV1;
  frontDoorPhotoUrl: string | null;
  exteriorPhotoUrl: string | null;
  roomDoorCode: string | null;
  roomDoorPhotoUrl: string | null;
  /** "Check-in from 3:00 PM Thursday, Oct 30" (already formatted in the property's zone). */
  checkInLabel?: string | null;
  /** "11:00 AM" - the stay's real checkout time (short stays). */
  checkOutTimeLabel?: string | null;
};

function nonEmpty(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function mapsUrlFor(address: string): string | null {
  const clean = address.trim();
  return clean ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(clean)}` : null;
}

function secret(label: string, value: string, revealed: boolean): CheckInSecretRow | null {
  const clean = nonEmpty(value);
  if (!clean) return null;
  return { label, value: revealed ? clean : null };
}

/** The room name as it should read in a title: "Room 9", never the loader's "Not assigned yet". */
function usableRoomLabel(label: string): string {
  const clean = label.trim();
  return !clean || /^not assigned/i.test(clean) || /^room tbd$/i.test(clean) ? "" : clean;
}

export function buildCheckInGuide(
  source: CheckInSource,
  reveal: CheckInReveal,
  options: { checkedInAt?: string | null; checkInKey?: string | null; timeZone?: string } = {},
): CheckInGuide {
  const revealed = reveal.revealed;
  const info = source.houseInfo;
  const get = (section: Parameters<typeof getHouseInfoValue>[1], key: string) => getHouseInfoValue(info, section, key);
  const steps: CheckInStep[] = [];

  // 1. Arrive
  const address = nonEmpty(source.addressLine) || nonEmpty(source.propertyLabel);
  const arriveLines = [nonEmpty(source.checkInLabel), get("access", "parking") ? `Parking: ${get("access", "parking")}` : ""].filter(Boolean);
  if (address) {
    steps.push({
      id: "address",
      title: `Arrive at ${address}`,
      lines: arriveLines,
      secrets: [],
      photoUrl: nonEmpty(source.exteriorPhotoUrl) || null,
      mapsUrl: mapsUrlFor(address),
      missingCode: false,
    });
  }

  // 2. Front door
  const frontSecrets = [
    secret("Door code", get("access", "doorCode"), revealed),
    secret("Gate or building code", get("access", "gateCode"), revealed),
    secret("Key pickup", get("access", "keyPickup"), revealed),
  ].filter((row): row is CheckInSecretRow => row !== null);
  const frontPhoto = nonEmpty(source.frontDoorPhotoUrl) || null;
  // Free-text access notes are where a manager types a code: they unlock with the codes.
  const frontNotes = revealed ? get("access", "notes") : "";
  if (frontSecrets.length > 0 || frontPhoto || frontNotes) {
    steps.push({
      id: "front_door",
      title: "Front door",
      lines: frontNotes ? [frontNotes] : [],
      secrets: frontSecrets,
      photoUrl: frontPhoto,
      mapsUrl: null,
      missingCode: false,
    });
  }

  // 3. Your room
  const roomName = usableRoomLabel(source.roomLabel);
  const roomCode = nonEmpty(source.roomDoorCode);
  const roomPhoto = nonEmpty(source.roomDoorPhotoUrl) || null;
  if (roomName || roomCode || roomPhoto) {
    steps.push({
      id: "room",
      title: roomName ? `Your room: ${roomName}` : "Your room",
      lines: !roomCode ? ["Ask your manager for your room code."] : [],
      secrets: roomCode ? [{ label: "Room code", value: revealed ? roomCode : null }] : [],
      photoUrl: roomPhoto,
      mapsUrl: null,
      missingCode: !roomCode,
    });
  }

  // 4. Wi-Fi
  const network = get("wifi", "network");
  const password = get("wifi", "password");
  if (network || password) {
    steps.push({
      id: "wifi",
      title: "Wi-Fi",
      lines: [],
      secrets: [
        ...(network ? [{ label: "Network", value: network } as CheckInSecretRow] : []),
        ...(password ? [{ label: "Password", value: revealed ? password : null } as CheckInSecretRow] : []),
      ],
      photoUrl: null,
      mapsUrl: null,
      missingCode: false,
    });
  }

  // 5. House guide: the rules and the trash, as the resident's own list reads them.
  const guideLines: string[] = [];
  for (const section of houseInfoRenderSections(info)) {
    if (section.id !== "rules" && section.id !== "trash") continue;
    for (const row of section.rows) guideLines.push(`${row.label}: ${row.value}`);
  }
  if (guideLines.length > 0) {
    steps.push({ id: "house_guide", title: "House guide", lines: guideLines, secrets: [], photoUrl: null, mapsUrl: null, missingCode: false });
  }

  // 6. Checkout
  const checkoutLines: string[] = [];
  const timeNote = get("checkout", "timeNote");
  if (timeNote) checkoutLines.push(timeNote);
  else if (nonEmpty(source.checkOutTimeLabel)) checkoutLines.push(`Checkout is at ${source.checkOutTimeLabel}.`);
  for (const key of ["trash", "keys", "lights", "other"] as const) {
    const value = get("checkout", key);
    if (value) checkoutLines.push(value);
  }
  if (checkoutLines.length > 0) {
    steps.push({ id: "checkout", title: "Checkout", lines: checkoutLines, secrets: [], photoUrl: null, mapsUrl: null, missingCode: false });
  }

  return {
    revealed,
    reason: reveal.reason,
    unlockLabel: revealed ? null : formatRevealLabel(reveal.revealAtIso, options.timeZone),
    steps,
    checkedInAt: options.checkedInAt ?? null,
    checkInKey: options.checkInKey ?? null,
  };
}

/** True when a step wants a code the manager has not entered: drives the manager's "Missing room code" item. */
export function checkInGuideMissingRoomCode(guide: Pick<CheckInGuide, "steps">): boolean {
  return guide.steps.some((step) => step.missingCode);
}
