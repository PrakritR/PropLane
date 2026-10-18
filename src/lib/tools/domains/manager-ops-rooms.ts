/**
 * W8: two room tools a manager uses by text.
 *
 *   list_vacant_rooms  "What's vacant at 5259 Brooklyn?"   (read)
 *   mark_room_rented   "Mark room 3 at 4709A rented to Sam from Nov 1"   (write, YES-gated)
 *
 * Both sit on the Bookings tool layer's own scope (`calendarReadableProperties`: the workspace the
 * number belongs to, plus the Calendar grant a teammate holds) and on the same room-date-block row
 * `block_room_dates` writes, so the calendar, the public listing and the capacity trigger all see
 * one booking, never a second kind.
 */
import { z } from "zod";
import { defineTool, defineWriteTool } from "../registry";
import { updateAuditResult, writeAuditLog } from "../audit";
import {
  announceBookingEvent,
  blockFromRecord,
  calendarReadableProperties,
  conflictMessage,
  formatDay,
  loadBlockRecords,
  overlappingBlock,
  pickProperty,
  resolveBlockInput,
  type BlockView,
  type ScopedProperty,
} from "./bookings";
import { roomAvailabilityForRange } from "@/lib/room-availability-range.server";
import { pacificTodayKey } from "@/lib/room-availability-range";
import { ROOM_DATE_BLOCK_RECORD_TYPE, roomDateBlockRecordId } from "@/lib/portal-schedule-record-scope";

/** The date stored for a booking with no end: the same sentinel the Bookings page saves. */
export const OPEN_ENDED_CHECK_OUT = "9999-12-31";

const MAX_HOUSES = 12;

/** Case-insensitive "does this house answer to that text": any word of the ask appears in the title. */
export function houseMatches(title: string, ask: string): boolean {
  const words = ask.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = title.toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** Match a spoken room name ("room 3", "3") to exactly one room of the house, or explain why not. */
export function resolveRoomByName(property: Pick<ScopedProperty, "title" | "rooms">, ask: string): { id: string; label: string } {
  const wanted = ask.trim().toLowerCase();
  const rooms = [...property.rooms.entries()].map(([id, label]) => ({ id, label }));
  const exact = rooms.filter((r) => r.label.toLowerCase() === wanted);
  const number = /^\d+$/.test(wanted) ? rooms.filter((r) => r.label.toLowerCase() === `room ${wanted}`) : [];
  const loose = rooms.filter((r) => r.label.toLowerCase().includes(wanted));
  const hits = exact.length ? exact : number.length ? number : loose;
  if (hits.length === 1) return hits[0]!;
  const names = rooms.map((r) => r.label).join(", ");
  throw new Error(
    hits.length === 0
      ? `${property.title} has no room called "${ask}".${names ? ` Its rooms are: ${names}.` : ""}`
      : `More than one room at ${property.title} matches "${ask}": ${hits.map((r) => r.label).join(", ")}. Ask which one.`,
  );
}

// ---- list_vacant_rooms -----------------------------------------------------------------------

export const listVacantRoomsTool = defineTool({
  name: "list_vacant_rooms",
  description:
    "List the rooms that are vacant right now, and the rooms that open soon, for one house (name its address or title) or for every house the manager can see. Use for 'what's vacant at 5259 Brooklyn' and 'any vacancies'. Rooms and dates come from the same calendar the public listing uses.",
  kind: "read",
  inputSchema: z
    .object({
      house: z.string().max(120).optional().describe("Optional house name or address to narrow to, e.g. \"5259 Brooklyn\"."),
    })
    .strict(),
  handler: async (ctx, input) => {
    const ask = input.house?.trim() ?? "";
    const readable = (await calendarReadableProperties(ctx)).filter((p) => houseMatches(p.title, ask));
    if (readable.length === 0) {
      return { count: 0, houses: [], message: ask ? `No house matching "${ask}" on this account.` : "No houses on this account." };
    }
    const today = pacificTodayKey();
    const houses: Array<{ propertyId: string; title: string; vacantNow: Array<{ room: string; rent: string | null }>; opening: Array<{ room: string; from: string }>; verified: boolean }> = [];
    for (const property of readable.slice(0, MAX_HOUSES)) {
      const result = await roomAvailabilityForRange({ propertyId: property.id, moveIn: today }, { submission: property.submission });
      if (!result.ok) {
        houses.push({ propertyId: property.id, title: property.title, vacantNow: [], opening: [], verified: false });
        continue;
      }
      const vacantNow = result.rooms.filter((r) => r.available === true).map((r) => ({ room: r.roomLabel, rent: r.rentLabel }));
      const opening = result.rooms
        .filter((r) => r.available === false && r.nextAvailableFrom)
        .map((r) => ({ room: r.roomLabel, from: r.nextAvailableFrom! }))
        .sort((a, b) => a.from.localeCompare(b.from));
      houses.push({ propertyId: property.id, title: property.title, vacantNow, opening, verified: result.verified });
    }
    return { count: houses.reduce((n, h) => n + h.vacantNow.length, 0), houses };
  },
});

// ---- mark_room_rented ------------------------------------------------------------------------

type RentedInput = { propertyId: string; roomName: string; residentName: string; from: string; until?: string };

async function resolveRented(ctx: Parameters<typeof calendarReadableProperties>[0], input: RentedInput) {
  const property = pickProperty(await calendarReadableProperties(ctx), input.propertyId);
  const room = resolveRoomByName(property, input.roomName);
  const from = input.from.trim();
  if (from < pacificTodayKey()) throw new Error("The move-in date is in the past. Give today or a later date.");
  const openEnded = !input.until?.trim();
  const resolved = await resolveBlockInput(ctx, {
    propertyId: property.id,
    roomId: room.id,
    start: from,
    end: openEnded ? OPEN_ENDED_CHECK_OUT : input.until!.trim(),
    residentName: input.residentName,
  });
  return { resolved, openEnded, room };
}

export const markRoomRentedTool = defineWriteTool({
  name: "mark_room_rented",
  description:
    "Mark ONE room as rented to a named person from a move-in date (YYYY-MM-DD), with no end date unless `until` is given. Use for 'mark room 3 at 4709A rented to Sam from Nov 1'. Pass the property id from list_properties and the room as the manager said it (\"Room 3\"). Needs Calendar edit on that house; refuses dates that overlap another booking. It records the booking on the calendar; it does not create a lease or a charge.",
  inputSchema: z
    .object({
      propertyId: z.string().min(1).describe("Property id from list_properties."),
      roomName: z.string().min(1).max(60).describe("The room as the manager said it, e.g. \"Room 3\"."),
      residentName: z.string().min(1).max(120).describe("Who the room is rented to."),
      from: z.string().describe("Move-in day, YYYY-MM-DD."),
      until: z.string().optional().describe("Optional last-night-plus-one check-out day, YYYY-MM-DD, exclusive. Omit for no end date."),
    })
    .strict(),
  preview: async (ctx, input) => {
    const { resolved, openEnded, room } = await resolveRented(ctx, input);
    const conflict = overlappingBlock(
      (await loadBlockRecords(ctx, [resolved.property.id])).map(blockFromRecord).filter((b): b is BlockView => b !== null),
      resolved,
    );
    if (conflict) throw new Error(conflictMessage(resolved, conflict));
    return {
      kind: "mark_room_rented",
      title: "Mark room rented",
      summary: `Mark ${room.label} at ${resolved.property.title} rented to ${resolved.residentName} from ${formatDay(resolved.start)}.`,
      fields: [
        { label: "House", value: resolved.property.title },
        { label: "Room", value: room.label },
        { label: "Rented to", value: resolved.residentName },
        { label: "From", value: formatDay(resolved.start) },
        { label: "Until", value: openEnded ? "No end date" : formatDay(resolved.end) },
      ],
      confirmLabel: "Mark rented",
    };
  },
  handler: async (ctx, input) => {
    // Re-derive the house, the room and the overlap from live, actor-scoped data: nothing stored is proof.
    const { resolved: r, openEnded } = await resolveRented(ctx, input);
    const existing = (await loadBlockRecords(ctx, [r.property.id])).map(blockFromRecord).filter((b): b is BlockView => b !== null);
    const conflict = overlappingBlock(existing, r);
    if (conflict) {
      if (conflict.roomId === r.roomId && conflict.checkIn === r.start && conflict.residentName === r.residentName) {
        return { reply: `Already done: ${r.roomLabel} at ${r.property.title} is rented to ${r.residentName} from ${formatDay(r.start)}.`, resultSummary: { blockId: conflict.id, duplicate: true } };
      }
      throw new Error(conflictMessage(r, conflict));
    }

    const uid = crypto.randomUUID();
    const id = roomDateBlockRecordId(ctx.userId, uid);
    const dedupeKey = `mark_room_rented:${ctx.landlordId}:${r.property.id}:${r.roomId}:${r.start}:${r.residentName.toLowerCase()}`;
    const audit = await writeAuditLog(ctx, {
      action: "mark_room_rented",
      toolName: "mark_room_rented",
      inputSummary: { propertyId: r.property.id, roomId: r.roomId, from: r.start, openEnded },
      dedupeKey,
    });
    if (!audit.recorded) {
      if (audit.duplicate) return { reply: "Already done: that room was marked rented." };
      throw new Error("Could not record the action; the room was not marked rented.");
    }

    const now = new Date().toISOString();
    const checkOut = openEnded ? OPEN_ENDED_CHECK_OUT : r.end;
    const row = {
      id,
      propertyId: r.property.id,
      roomId: r.roomId,
      checkIn: r.start,
      checkOut,
      openEnded,
      reason: "",
      bookingStatus: "confirmed",
      residentName: r.residentName,
      createdAt: now,
      createdByUserId: ctx.userId,
      recordType: ROOM_DATE_BLOCK_RECORD_TYPE,
      startsAt: `${r.start}T00:00:00`,
      endsAt: `${checkOut}T00:00:00`,
    };
    // A booking belongs to the house: the capacity trigger accepts only the property OWNER's id.
    const ownerId = r.property.ownerId.trim() || ctx.userId;
    const { error } = await ctx.db.from("portal_schedule_records").insert({
      id,
      manager_user_id: ownerId,
      property_id: r.property.id,
      record_type: ROOM_DATE_BLOCK_RECORD_TYPE,
      starts_at: row.startsAt,
      ends_at: row.endsAt,
      row_data: row,
      updated_at: now,
      ...(ctx.testWorkspaceId ? { test_workspace_id: ctx.testWorkspaceId } : {}),
    });
    if (error) {
      await updateAuditResult(ctx, dedupeKey, { error: "write_failed" }, { clearDedupeKey: true });
      throw new Error(String(error.message ?? "Could not mark that room rented."));
    }
    await updateAuditResult(ctx, dedupeKey, { blockId: id });
    announceBookingEvent(ctx, "booking_created", { blockId: id, ownerId, propertyId: r.property.id, roomId: r.roomId, guestName: r.residentName, checkIn: r.start, checkOut, openEnded, closed: false, reason: "" });
    return {
      reply: `Marked ${r.roomLabel} at ${r.property.title} rented to ${r.residentName} from ${formatDay(r.start)}.`,
      resultSummary: { blockId: id },
    };
  },
});

export const managerOpsRoomTools = [listVacantRoomsTool, markRoomRentedTool];
