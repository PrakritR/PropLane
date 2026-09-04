/**
 * AXI-148 — the assistant answered "I can't set per-room rent from here. The
 * `update_property` tool only changes the listing-level monthly rent, not the
 * rent for an individual room (Room 2)."
 *
 * AGENTS.md: "If a capability is missing, ADD A TOOL — do not work around the
 * layer." So this is a new write tool, gated by the same preview/confirm path as
 * every other one.
 */
import { describe, expect, it } from "vitest";
import { updateRoomRentTool } from "@/lib/tools/domains/properties";

describe("update_room_rent", () => {
  it("is a confirm-gated write tool, not an inline write", () => {
    expect(updateRoomRentTool.name).toBe("update_room_rent");
    // A write tool with no preview is UNREACHABLE from chat — the preview IS
    // the safety gate.
    expect(typeof updateRoomRentTool.preview).toBe("function");
    expect(typeof updateRoomRentTool.handler).toBe("function");
  });

  it("takes the room by name, since ids are internal", () => {
    const shape = updateRoomRentTool.inputSchema.shape as Record<string, unknown>;
    expect(Object.keys(shape).sort()).toEqual(["propertyId", "rentUsd", "roomName"]);
  });

  it("rejects a non-positive rent at the schema, before any lookup", () => {
    expect(
      updateRoomRentTool.inputSchema.safeParse({ propertyId: "p", roomName: "Room 2", rentUsd: 0 }).success,
    ).toBe(false);
    expect(
      updateRoomRentTool.inputSchema.safeParse({ propertyId: "p", roomName: "Room 2", rentUsd: -50 }).success,
    ).toBe(false);
  });

  it("rejects unknown keys rather than silently ignoring them", () => {
    expect(
      updateRoomRentTool.inputSchema.safeParse({
        propertyId: "p",
        roomName: "Room 2",
        rentUsd: 700,
        landlordId: "someone-else",
      }).success,
    ).toBe(false);
  });

  it("accepts a valid patch", () => {
    expect(
      updateRoomRentTool.inputSchema.safeParse({ propertyId: "p1", roomName: "Room 2", rentUsd: 700 }).success,
    ).toBe(true);
  });

  it("points the model at update_property for the listing-level rent", () => {
    expect(updateRoomRentTool.description).toContain("update_property");
  });
});
