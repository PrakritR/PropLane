import { describe, expect, it } from "vitest";
import { buildManagerSmsRegistry, agentRegistry } from "@/lib/tools";
import { executeWriteTool, previewWriteTool } from "@/lib/tools/registry";
import { OWNER, WS, propertyRow, roomPhotos, world } from "../helpers/manager-commands-world";

function submissionOf(w: ReturnType<typeof world>, id: string) {
  const row = w.db.tables.manager_property_records!.find((r) => r.id === id)!;
  return (row.property_data as { listingSubmission: { houseOverview: string; rooms: Array<{ id: string; name: string; availability: string; moveInAvailableDate: string; detail: string; monthlyRent: number }> } }).listingSubmission;
}

describe("update_listing_details (availability date, description detail)", () => {
  it("sets a room's availability date through the normalized submission", async () => {
    const w = world();
    const registry = buildManagerSmsRegistry();
    const prepared = await previewWriteTool(registry, w.ctx, "update_listing_details", { propertyId: "prop-5259", roomName: "Room 4", availableOn: "2027-01-15" });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.preview.summary).toContain("Room 4");
    expect(prepared.preview.fields.map((f) => f.label)).toEqual(expect.arrayContaining(["Property", "Room", "Availability"]));
    // the preview wrote nothing
    expect(submissionOf(w, "prop-5259").rooms[3]!.moveInAvailableDate).toBe("");
    const done = await executeWriteTool(registry, w.ctx, "update_listing_details", prepared.input);
    expect(done.ok).toBe(true);
    const room = submissionOf(w, "prop-5259").rooms[3]!;
    expect(room.moveInAvailableDate).toBe("2027-01-15");
    expect(room.availability).toBe("Available from January 15, 2027");
    // no other room, no other house
    expect(submissionOf(w, "prop-5259").rooms[0]!.moveInAvailableDate).toBe("");
    expect(submissionOf(w, "prop-5257").rooms[3]!.moveInAvailableDate).toBe("");
  });

  it("'now' reads as available now", async () => {
    const w = world();
    const registry = buildManagerSmsRegistry();
    await executeWriteTool(registry, w.ctx, "update_listing_details", { propertyId: "prop-5259", roomName: "Room 2", availableOn: "2027-03-01" });
    await executeWriteTool(registry, w.ctx, "update_listing_details", { propertyId: "prop-5259", roomName: "Room 2", availableOn: "now" });
    const room = submissionOf(w, "prop-5259").rooms[1]!;
    expect([room.availability, room.moveInAvailableDate]).toEqual(["Available now", ""]);
  });

  it("replaces or appends a room description and the house description", async () => {
    const w = world();
    const registry = buildManagerSmsRegistry();
    await executeWriteTool(registry, w.ctx, "update_listing_details", { propertyId: "prop-5259", roomName: "Room 4", detail: "Sunny corner room." });
    await executeWriteTool(registry, w.ctx, "update_listing_details", { propertyId: "prop-5259", roomName: "Room 4", detail: "New desk.", mode: "append" });
    expect(submissionOf(w, "prop-5259").rooms[3]!.detail).toBe("Sunny corner room. New desk.");
    await executeWriteTool(registry, w.ctx, "update_listing_details", { propertyId: "prop-5259", detail: "New washer and dryer." });
    expect(submissionOf(w, "prop-5259").houseOverview).toBe("New washer and dryer.");
  });

  it("needs a room for an availability date on a house with several, and never invents a room", async () => {
    const w = world();
    const registry = buildManagerSmsRegistry();
    const noRoom = await previewWriteTool(registry, w.ctx, "update_listing_details", { propertyId: "prop-5259", availableOn: "now" });
    expect(noRoom).toMatchObject({ ok: false, error: expect.stringContaining("Which room?") });
    const wrongRoom = await previewWriteTool(registry, w.ctx, "update_listing_details", { propertyId: "prop-5259", roomName: "Room 40", availableOn: "now" });
    expect(wrongRoom).toMatchObject({ ok: false, error: expect.stringContaining("no room named") });
    const badDate = await previewWriteTool(registry, w.ctx, "update_listing_details", { propertyId: "prop-5259", roomName: "Room 1", availableOn: "2027-02-30" });
    expect(badDate.ok).toBe(false);
    const nothing = await previewWriteTool(registry, w.ctx, "update_listing_details", { propertyId: "prop-5259", roomName: "Room 1" });
    expect(nothing.ok).toBe(false);
  });

  it("will not touch a house the context does not own", async () => {
    const w = world();
    w.db.tables.manager_property_records!.push({ ...propertyRow("prop-other", "1 Elsewhere Rd", 2), manager_user_id: "someone-else" });
    const registry = buildManagerSmsRegistry();
    const result = await previewWriteTool(registry, w.ctx, "update_listing_details", { propertyId: "prop-other", roomName: "Room 1", availableOn: "now" });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("No property with that id") });
  });
});

describe("create_listing_draft_by_text", () => {
  const input = { flowId: "flowabc123456", address: "812 Pine St Seattle", roomCount: 3, rentsUsd: [900, 950, 1000], details: "Near the light rail." };

  it("saves a DRAFT (never public) in the workspace, one rent per room, and nothing else", async () => {
    const w = world();
    const registry = buildManagerSmsRegistry();
    const prepared = await previewWriteTool(registry, w.ctx, "create_listing_draft_by_text", input);
    expect(prepared.ok).toBe(true);
    expect(w.db.tables.manager_property_records).toHaveLength(3);
    const done = await executeWriteTool(registry, w.ctx, "create_listing_draft_by_text", input);
    expect(done.ok).toBe(true);
    const created = w.db.tables.manager_property_records!.find((r) => String(r.id).startsWith("mgr-text-"))!;
    expect(created).toMatchObject({ status: "draft", manager_user_id: OWNER, workspace_id: WS, property_data: null });
    const sub = (created.row_data as { submission: { address: string; houseOverview: string; rooms: Array<{ name: string; monthlyRent: number }> } }).submission;
    expect(sub.address).toBe("812 Pine St Seattle");
    expect(sub.houseOverview).toBe("Near the light rail.");
    expect(sub.rooms.map((r) => r.monthlyRent)).toEqual([900, 950, 1000]);
    expect(sub.rooms.map((r) => r.name)).toEqual(["Room 1", "Room 2", "Room 3"]);
  });

  it("is idempotent for one flow: a retried confirmation updates the same draft", async () => {
    const w = world();
    const registry = buildManagerSmsRegistry();
    await executeWriteTool(registry, w.ctx, "create_listing_draft_by_text", input);
    await executeWriteTool(registry, w.ctx, "create_listing_draft_by_text", input);
    expect(w.db.tables.manager_property_records!.filter((r) => String(r.id).startsWith("mgr-text-"))).toHaveLength(1);
  });

  it("will not overwrite a draft the manager already published or changed", async () => {
    const w = world();
    const registry = buildManagerSmsRegistry();
    await executeWriteTool(registry, w.ctx, "create_listing_draft_by_text", input);
    w.db.tables.manager_property_records!.find((r) => String(r.id).startsWith("mgr-text-"))!.status = "live";
    const again = await executeWriteTool(registry, w.ctx, "create_listing_draft_by_text", { ...input, flowId: input.flowId });
    expect(again).toMatchObject({ ok: false });
  });

  it("rejects a rent list that does not match the rooms", async () => {
    const w = world();
    const registry = buildManagerSmsRegistry();
    const bad = await previewWriteTool(registry, w.ctx, "create_listing_draft_by_text", { ...input, rentsUsd: [900, 950] });
    expect(bad.ok).toBe(false);
  });
});

describe("what a text can reach (registry guard)", () => {
  const registry = buildManagerSmsRegistry();

  it("exposes the listing tools by text and keeps every destructive tool out", () => {
    for (const name of ["update_room_rent", "update_property", "update_listing_details", "create_listing_draft_by_text", "apply_listing_photos", "reply_to_sms_conversation"]) {
      expect(registry.has(name), name).toBe(true);
    }
    for (const tool of registry.values()) {
      expect(tool.kind === "write" && tool.destructive, `${tool.name} is destructive and textable`).toBeFalsy();
    }
    // every destructive tool of the portal catalog is withheld, by the flag, not by a name list
    const destructive = [...agentRegistry.values()].filter((t) => t.kind === "write" && t.destructive).map((t) => t.name);
    expect(destructive.length).toBeGreaterThan(0);
    for (const name of destructive) expect(registry.has(name), name).toBe(false);
  });

  it("the new listing tools are not destructive, and publishing / approval stay out of reach", () => {
    expect(registry.get("update_listing_details")).toMatchObject({ kind: "write" });
    expect((registry.get("update_listing_details") as { destructive?: boolean }).destructive).toBeFalsy();
    expect((registry.get("create_listing_draft_by_text") as { destructive?: boolean }).destructive).toBeFalsy();
    expect(registry.has("update_application_bucket")).toBe(false);
    expect(registry.has("set_resident_approval")).toBe(false);
  });

  it("a read-only seat gets no write tool at all", () => {
    const readOnly = buildManagerSmsRegistry({ mode: "delegated", workNumberOwnerId: "o", actorUserId: "a", dataOwnerIds: [], assignedPropertyIds: [], readOnly: true } as never);
    expect([...readOnly.values()].filter((t) => t.kind === "write")).toEqual([]);
    for (const name of ["update_room_rent", "update_listing_details", "create_listing_draft_by_text", "apply_listing_photos"]) expect(readOnly.has(name)).toBe(false);
  });

  it("a delegated seat only gets the tools its grants scope, so a seat cannot edit what it was not granted", () => {
    const delegated = buildManagerSmsRegistry({ mode: "delegated", workNumberOwnerId: "o", actorUserId: "a", dataOwnerIds: ["o"], assignedPropertyIds: ["p1"] } as never);
    // The three listing edits are present but gated per house on Properties at edit (tests/unit/delegated-listing-edit-scope.test.ts).
    expect(delegated.has("update_listing_details")).toBe(true);
    expect(delegated.has("update_lease_terms")).toBe(false);
    expect(delegated.has("create_listing_draft_by_text")).toBe(false);
  });
});

describe("room photos helper sanity", () => {
  it("starts empty", () => {
    const w = world();
    expect(roomPhotos(w.db, "prop-5259", 0)).toEqual([]);
  });
});
