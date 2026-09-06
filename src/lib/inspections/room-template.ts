import type { ManagerRoomSubmission, ManagerBathroomSubmission } from "@/lib/manager-listing-submission";
import { roomFurnishingIsFurnished } from "@/data/manager-listing-presets";
import { InspectionError, type InspectionDocument, type InspectionObservation } from "./model";

type InspectionRoomListing = {
  rooms: Pick<ManagerRoomSubmission, "id" | "name" | "furnishing">[];
  bathrooms: Pick<ManagerBathroomSubmission, "allResidents" | "assignedRoomIds" | "accessKindByRoomId">[];
};

/** Read only the listing facts used by a room inspection; ignore malformed legacy values. */
export function inspectionRoomListing(rooms: unknown, bathrooms: unknown): InspectionRoomListing {
  const objects = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry)) : [];
  const text = (value: unknown) => typeof value === "string" ? value : "";
  return {
    rooms: objects(rooms).filter(r => text(r.id)).map(r => ({ id: text(r.id), name: text(r.name), furnishing: text(r.furnishing) })),
    bathrooms: objects(bathrooms).map(b => ({ allResidents: b.allResidents === true,
      assignedRoomIds: Array.isArray(b.assignedRoomIds) ? b.assignedRoomIds.filter((id): id is string => typeof id === "string") : [],
      accessKindByRoomId: b.accessKindByRoomId && typeof b.accessKindByRoomId === "object" ? Object.fromEntries(Object.entries(b.accessKindByRoomId).filter(([, kind]) => kind === "ensuite" || kind === "shared")) : {},
    })),
  };
}

export type InspectionRoom = { assignment: string; label: string; furnished: boolean; privateBathroom: boolean };

/** An explicit placement is required. Never pick another room by rent or array position. */
export function resolveInspectionRoom(propertyId: string, assignment: string, manualRoom: string, submission?: InspectionRoomListing): InspectionRoom {
  const choice = assignment.trim();
  const manual = manualRoom.trim();
  const separator = choice.indexOf("::");
  if (separator >= 0 && choice.slice(0, separator) !== propertyId) {
    throw new InspectionError("The assigned room does not belong to this property.");
  }
  const roomId = separator >= 0 ? choice.slice(separator + 2) : "";
  const rooms = submission?.rooms ?? [];
  const room = roomId ? rooms.find(r => r.id === roomId) : rooms.find(r =>
    r.id === choice || r.name.trim().toLowerCase() === (manual || choice).toLowerCase());
  if (roomId && !room) throw new InspectionError("The assigned room could not be found. Update the resident's room placement before starting an inspection.");
  const label = room?.name.trim() || manual || (choice !== propertyId && separator < 0 ? choice : "");
  if (!label) throw new InspectionError("Assign a room to this resident before starting an inspection.");
  return {
    assignment: room ? `${propertyId}::${room.id}` : manual || choice,
    label,
    furnished: roomFurnishingIsFurnished(room?.furnishing),
    privateBathroom: Boolean(room && submission?.bathrooms.some(b => !b.allResidents &&
      b.assignedRoomIds.length === 1 && b.assignedRoomIds[0] === room.id && b.accessKindByRoomId?.[room.id] === "ensuite")),
  };
}

/** Photos fill one small section at a time. Shared property areas are deliberately absent. */
export function createRoomInspectionDocument(room: InspectionRoom): InspectionDocument {
  const sections: Array<[string, string]> = [
    ["room-overview", "Room overview"], ["room-surfaces", "Walls, ceiling & floor"],
    ["room-windows", "Windows & blinds"], ["room-access", "Door, lock & closet"],
    ["room-electrical", "Lights & outlets"],
  ];
  if (room.furnished) sections.push(["room-furniture", "Furniture"]);
  if (room.privateBathroom) sections.push(["room-bathroom", "Private bathroom"]);
  const observation = (): InspectionObservation => ({ condition: "unchecked", notes: "", photos: [] });
  return { roomScope: { assignment: room.assignment, label: room.label }, history: [], residentAcknowledgment: null,
    areas: sections.map(([id, label]) => ({ id, label,
      items: [{ id: `${id}-condition`, label, resident: observation(), manager: observation() }],
    })),
  };
}
