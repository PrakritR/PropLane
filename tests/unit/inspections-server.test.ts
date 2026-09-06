import { beforeEach, describe, expect, it, vi } from "vitest";
import { reportFixture } from "../helpers/inspection-fixture";
import type { AgentContext } from "@/lib/tools/context";
import type { ResidentAgentContext } from "@/lib/tools/resident-context";
import type { InspectionRecord } from "@/lib/inspections/model";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));
vi.mock("@/lib/tools/audit", () => ({ writeAuditLog: vi.fn(async () => ({ recorded: true })), updateAuditResult: vi.fn() }));
vi.mock("@/lib/auth/manager-application-access", () => ({ managerOwnedPropertyIdSet: async (_db: unknown, userId: string) => new Set(userId === "owner" ? ["home"] : []) }));
vi.mock("@/lib/auth/co-manager-module-scope", () => ({ linkedOwnerScopeForModule: async (_db: unknown, userId: string, _module: string, level: string) => ({ owners: new Set(), propertyIds: new Set(userId === "co-manager" && level === "read" ? ["home"] : []) }) }));
import { addInspectionPhoto, getInspection, listInspectionResidencies, listInspections, prepareInspection, removeInspectionPhoto, saveInspection, type InspectionActor } from "@/lib/inspections/server";

// Executable filtering + revision compare-and-swap, rather than canned query results.
let reports: InspectionRecord[];
let applications: Record<string, unknown>[];
let writes: number;
let properties: Record<string, unknown>[];
/** Table name → the PostgREST error every read of it should return. */
let readErrors: Record<string, { code?: string; message: string }>;
const storage = { upload: vi.fn(), remove: vi.fn(), createSignedUrls: vi.fn() };
const db = { storage: { from: () => storage }, from(table: string) {
  const filters: ((row: Record<string, unknown>) => boolean)[] = [];
  let patch: Record<string, unknown> | undefined;
  let from = 0; let to = Infinity;
  const rows = () => table === "resident_inspections" ? reports : table === "manager_application_records" ? applications : properties;
  const run = () => {
    const failure = readErrors[table];
    if (failure) return { data: null as unknown as Record<string, unknown>[], error: failure };
    const matched = rows().filter(row => filters.every(f => f(row as unknown as Record<string, unknown>))).slice(from, to + 1);
    if (patch) { for (const row of matched) Object.assign(row, patch); writes += matched.length; }
    return { data: structuredClone(matched), error: null };
  };
  const q = { select: () => q, order: () => q,
    eq: (key: string, value: unknown) => { filters.push(row => row[key] === value); return q; },
    in: (key: string, values: unknown[]) => { filters.push(row => values.includes(row[key])); return q; },
    range: (start: number, end: number) => { from = start; to = end; return q; },
    update: (value: Record<string, unknown>) => { patch = value; return q; },
    maybeSingle: async () => { const result = run(); return { ...result, data: result.data[0] ?? null }; },
    then: (resolve: (value: ReturnType<typeof run>) => unknown) => Promise.resolve(run()).then(resolve),
  }; return q;
} };
const manager = (userId = "owner"): InspectionActor => ({ role: "manager", context: { userId, landlordId: userId, db } as unknown as AgentContext });
const resident = (userId = "resident", email = "resident@example.test"): InspectionActor => ({ role: "resident", context: { userId, landlordId: userId, email, phase: "approved", db } as unknown as ResidentAgentContext });
beforeEach(() => { vi.clearAllMocks(); writes = 0; readErrors = {}; properties = [{ id: "home", manager_user_id: "owner" }]; reports = [reportFixture()]; applications = [{ id: "AXIS-TEST", manager_user_id: "owner", property_id: "home", resident_email: "resident@example.test", app_bucket: "approved", app_name: "Resident", app_resident_user_id: "resident", app_property_id: "home", app_room_choice: "Room 1" }]; });

describe("inspection ownership and write isolation", () => {
  it("hides another landlord's report and another resident's evidence", async () => {
    for (const actor of [manager("other-owner"), resident("roommate", "roommate@example.test"), resident("imposter")]) {
      await expect(getInspection(actor, reports[0]!.id)).rejects.toMatchObject({ status: 404 });
      expect(await listInspections(actor)).toEqual([]);
    }
    expect((await getInspection(resident(), reports[0]!.id)).id).toBe(reports[0]!.id);
  });
  it("respects co-manager read grants without granting edits", async () => {
    const actor = manager("co-manager");
    expect((await getInspection(actor, reports[0]!.id)).property_id).toBe("home");
    await expect(saveInspection(actor, reports[0]!.id, { revision: 1, observations: [] })).rejects.toMatchObject({ status: 404 });
    expect(writes).toBe(0);
  });
  it("rejects application-phase residents before reading evidence", async () => {
    const actor = resident(); if (actor.role === "resident") actor.context.phase = "application";
    await expect(getInspection(actor, reports[0]!.id)).rejects.toMatchObject({ status: 403 });
  });
  it("denies a baseline from a different residency, uncompleted report or future date", async () => {
    const input = { applicationId: "AXIS-TEST", kind: "move-out", inspectionDate: "2026-09-06", baselineId: reports[0]!.id };
    await expect(prepareInspection(manager(), input)).rejects.toThrow(/completed move-in/);
    reports[0]!.status = "completed"; reports[0]!.application_id = "OTHER";
    await expect(prepareInspection(manager(), input)).rejects.toThrow(/this residency/);
    reports[0]!.application_id = "AXIS-TEST"; reports[0]!.inspection_date = "2026-09-07";
    await expect(prepareInspection(manager(), input)).rejects.toThrow(/before the move-out/);
    reports[0]!.inspection_date = "2026-09-05";
    expect((await prepareInspection(manager(), input)).baseline?.id).toBe(reports[0]!.id);
  });
  it("never accepts client ownership and rejects unauthorized creation", async () => {
    const input = { applicationId: "AXIS-TEST", kind: "move-in", inspectionDate: "2026-09-05" };
    await expect(prepareInspection(manager("other"), input)).rejects.toMatchObject({ status: 404 });
    await expect(prepareInspection(resident("other", "other@example.test"), input)).rejects.toMatchObject({ status: 404 });
    await expect(prepareInspection(manager(), { ...input, manager_user_id: "other" })).rejects.toThrow();
  });
  it("resolves only the assigned room from the actual property's saved listing", async () => {
    applications[0]!.app_room_choice = "home::b";
    properties[0]!.listing_rooms = [{ id: "a", name: "Room A", furnishing: "Unfurnished" }, { id: "b", name: "Room B", furnishing: "Bed" }];
    properties[0]!.listing_bathrooms = [{ assignedRoomIds: ["b"], allResidents: false, accessKindByRoomId: { b: "ensuite" } }];
    const input = { applicationId: "AXIS-TEST", kind: "move-in", inspectionDate: "2026-09-05" };
    expect((await prepareInspection(manager(), input)).room).toEqual({ assignment: "home::b", label: "Room B", furnished: true, privateBathroom: true });
    applications[0]!.app_room_choice = "other::b";
    await expect(prepareInspection(manager(), input)).rejects.toThrow("does not belong");
    applications[0]!.app_room_choice = "";
    await expect(prepareInspection(manager(), input)).rejects.toThrow("Assign a room");
  });
  it("uses the pinned room identity rather than a renamed room label when matching new baselines", async () => {
    applications[0]!.app_room_choice = "home::b";
    properties[0]!.listing_rooms = [{ id: "b", name: "Renamed room", furnishing: "Unfurnished" }];
    reports[0]!.status = "completed";
    reports[0]!.document.roomScope = { assignment: "home::b", label: "Original name" };
    const input = { applicationId: "AXIS-TEST", kind: "move-out", inspectionDate: "2026-09-06", baselineId: reports[0]!.id };
    expect((await prepareInspection(manager(), input)).baseline?.id).toBe(reports[0]!.id);
    reports[0]!.document.roomScope.assignment = "home::a";
    await expect(prepareInspection(manager(), input)).rejects.toThrow("this residency");
  });
  it("refuses concurrent writes rather than losing the other party's observations", async () => {
    const id = reports[0]!.id;
    const patch = { revision: 1, observations: [{ itemId: "area-0-item-0", condition: "fair", notes: "Scratch" }] };
    const results = await Promise.allSettled([saveInspection(manager(), id, patch), saveInspection(resident(), id, patch)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
    expect(reports[0]!.revision).toBe(2); expect(writes).toBe(1);
  });
  it("refuses oversized and spoofed photos before storage upload", async () => {
    const id = reports[0]!.id;
    await expect(addInspectionPhoto(manager(), id, "area-0-item-0", 1, new File([new Uint8Array(5 * 1024 * 1024 + 1)], "large.jpg"))).rejects.toThrow(/smaller than/);
    await expect(addInspectionPhoto(manager(), id, "area-0-item-0", 1, new File(["<svg></svg>"], "fake.jpg", { type: "image/jpeg" }))).rejects.toThrow(/valid JPEG/);
    expect(storage.upload).not.toHaveBeenCalled();
  });
  it("does not let a resident remove a manager photo", async () => {
    reports[0]!.document.areas[0]!.items[0]!.manager.photos.push({ id: "photo", path: "private", uploadedBy: "owner", uploadedAt: "2026-09-05" });
    await expect(removeInspectionPhoto(resident(), reports[0]!.id, "photo", 1)).rejects.toMatchObject({ status: 404 });
    expect(writes).toBe(0); expect(storage.remove).not.toHaveBeenCalled();
  });
  it("files a private source once per contributor and section without bypassing stale revision checks", async () => {
    const sharp = (await import("sharp")).default;
    const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: "white" } }).jpeg().toBuffer();
    const file = new File([new Uint8Array(bytes)], "photo.jpg", { type: "image/jpeg" });
    const sourceRef = "resident/inspection-chat/portal/source.jpg";
    const actor = resident();
    const id = reports[0]!.id;
    storage.upload.mockResolvedValue({ error: null });
    const first = await addInspectionPhoto(actor, id, "area-0-item-0", 1, file, sourceRef);
    const repeat = await addInspectionPhoto(actor, id, "area-0-item-0", first.revision, file, sourceRef);
    expect(repeat.revision).toBe(first.revision);
    expect(repeat.document.areas[0]!.items[0]!.resident.photos).toHaveLength(1);
    expect(repeat.document.areas[0]!.items[0]!.resident.photos[0]).toMatchObject({ sourceRef, uploadedBy: "resident" });
    expect(repeat.document.areas[0]!.items[0]!.manager.photos).toHaveLength(0);
    expect(storage.upload).toHaveBeenCalledTimes(1);
    expect(writes).toBe(1);
    await expect(addInspectionPhoto(actor, id, "area-0-item-0", 1, file, sourceRef)).rejects.toMatchObject({ status: 409 });
    expect(storage.upload).toHaveBeenCalledTimes(1);
  });
});

describe("residency roster", () => {
  it("reports the tenancy dates and where the resident sits on the timeline", async () => {
    applications[0]!.app_manual_move_in = "2026-08-01";
    applications[0]!.app_manual_move_out = "2027-07-31";

    const [residency] = await listInspectionResidencies(manager());

    expect(residency).toMatchObject({ id: "AXIS-TEST", moveInDate: "2026-08-01", moveOutDate: "2027-07-31" });
    // Occupancy is resolved against the real today, so only assert it is one of the three.
    expect(["upcoming", "current", "past"]).toContain(residency!.occupancy);
  });

  it("prefers the manager's own date over the one the applicant typed", async () => {
    applications[0]!.app_lease_start = "2026-08-01";
    applications[0]!.app_manual_move_in = "2026-09-15";

    expect((await listInspectionResidencies(manager()))[0]!.moveInDate).toBe("2026-09-15");
  });

  it("leaves the dates blank rather than guessing when the application has none", async () => {
    const [residency] = await listInspectionResidencies(manager());

    expect(residency).toMatchObject({ moveInDate: "", moveOutDate: "", occupancy: "upcoming" });
  });
});

describe("unreadable tables", () => {
  it("names the missing table and the migrations instead of asking for a retry", async () => {
    // Migrations do not ride along with a deploy, so the code can ship before the table
    // exists. "Please try again" sent managers round a loop no retry could break.
    readErrors.resident_inspections = { code: "PGRST205", message: "Could not find the table 'public.resident_inspections' in the schema cache" };

    await expect(listInspections(manager())).rejects.toMatchObject({
      status: 503,
      message: expect.stringContaining("resident_inspections"),
    });
    await expect(listInspections(manager())).rejects.toThrow(/migrations/);
  });

  it("keeps the retry wording for an ordinary read failure", async () => {
    readErrors.resident_inspections = { code: "57014", message: "canceling statement due to statement timeout" };

    await expect(listInspections(manager())).rejects.toMatchObject({ status: 500, message: expect.stringContaining("try again") });
  });
});
