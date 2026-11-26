/**
 * get_room_door_code: a manager asks for a room's door code by text ("door code for 5257 Room 6"). The workspace owner
 * may read any room of their own houses; a delegated seat (co-manager, staff) is refused because this tool is not in
 * the co-manager allow-list (new tools fail closed). The room is matched by its display name through the same house
 * and room matchers the room tools use. The code is a secret: it is returned only here, never logged.
 */
import { z } from "zod";
import { defineTool } from "../registry";
import { calendarReadableProperties } from "./bookings";
import { houseMatches, resolveRoomByName } from "./manager-ops-rooms";

const asObj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** The structured door code of one listing room, or "" when none is set. Pure. */
export function roomDoorCodeFromSubmission(submission: unknown, roomId: string): string {
  const rooms = asObj(submission)?.rooms;
  for (const raw of Array.isArray(rooms) ? rooms : []) {
    const room = asObj(raw);
    if (room && String(room.id ?? "") === roomId) return String(room.doorCode ?? "").trim();
  }
  return "";
}

export const getRoomDoorCodeTool = defineTool({
  name: "get_room_door_code",
  description:
    'A room\'s door code for a house the manager owns, by house ("5257", "4709A 8th Ave") and room ("Room 6" or "6"). Returns the code exactly as stored, or says none is set. Use for "door code for 5257 Room 6". When the house or room matches none or several, relay the one question the error asks.',
  kind: "read",
  inputSchema: z.object({ house: z.string().min(1).max(120), room: z.string().min(1).max(60) }).strict(),
  handler: async (ctx, input) => {
    if (ctx.managerSmsAccess?.mode === "delegated") throw new Error("Room door codes are not available on another manager's number.");
    const houses = (await calendarReadableProperties(ctx)).filter((p) => houseMatches(p.title, input.house));
    if (houses.length === 0) throw new Error(`No house matches "${input.house}". Which house do you mean?`);
    if (houses.length > 1) throw new Error(`More than one house matches "${input.house}": ${houses.map((h) => h.title).join(", ")}. Which one?`);
    const house = houses[0]!;
    const room = resolveRoomByName(house, input.room);
    const code = roomDoorCodeFromSubmission(house.submission, room.id);
    return { house: house.title, room: room.label, doorCode: code || null, message: code ? null : `No door code is set for ${house.title} ${room.label}.` };
  },
});
