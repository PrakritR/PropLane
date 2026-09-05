import { beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_HOUSEMATE_SHARING } from "@/lib/resident-housemate-sharing";
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => db }));
import { loadResidentMoveInForEmail } from "@/lib/resident-move-in-info";
let preferences: typeof DEFAULT_HOUSEMATE_SHARING | null = null;
let prefError = false;
let peerName = "Private Peer";
let selfStage = "Approved";
let peerStage = "Approved";
let peerMoveOut: string | undefined;
const application = (email: string, room: string, name: string) => ({ id: email, resident_email: email, manager_user_id: "manager", property_id: "home", assigned_property_id: "home", row_data: { id: email, email, name, bucket: "approved", propertyId: "home", assignedPropertyId: "home", stage: email.startsWith("self") ? selfStage : peerStage, manualResidentDetails: { roomNumber: room, moveOutDate: email.startsWith("self") ? undefined : peerMoveOut } } });
const db = { from: (table: string) => {
  const data: Record<string, unknown>[] = table === "manager_application_records" ? [application("self@example.test", "Room 1", "Self"), application("peer@example.test", "Room 2", peerName)]
    : table === "manager_property_records" ? [{ id: "home", property_data: { id: "home", title: "Test home", address: "Test address" }, row_data: {} }]
    : table === "profiles" ? [{ id: "peer-id", email: "peer@example.test", full_name: peerName, phone: "2065550100" }]
    : preferences ? [{ user_id: "peer-id", preferences }] : [];
  let values = data;
  const result = () => ({ data: values, error: table === "resident_housemate_sharing" && prefError ? { message: "unavailable" } : null });
  const q = { select: () => q, order: () => q, range: () => q, eq: (key: string, value: string) => { values = values.filter(row => row[key] === value); return q; }, in: (key: string, allowed: string[]) => { values = values.filter(row => allowed.includes(String(row[key]))); return q; }, maybeSingle: async () => ({ ...result(), data: values[0] ?? null }), then: (resolve: (r: ReturnType<typeof result>) => unknown) => Promise.resolve(result()).then(resolve) }; return q;
} };
beforeEach(() => { preferences = null; prefError = false; peerName = "Private Peer"; selfStage = "Approved"; peerStage = "Approved"; peerMoveOut = undefined; });
it("redacts peers before the server passes house details to the browser", async () => {
  const result = await loadResidentMoveInForEmail("self@example.test");
  expect(result?.housemates).toHaveLength(1);
  const payload = JSON.stringify(result?.housemates);
  for (const privateValue of ["Private Peer", "peer@example.test", "206", "Room 2"]) expect(payload).not.toContain(privateValue);
});
it("returns only the peer's opted-in fields and immediately honors revocation", async () => {
  preferences = { ...DEFAULT_HOUSEMATE_SHARING, shareName: true, shareEmail: true };
  const shared = (await loadResidentMoveInForEmail("self@example.test"))?.housemates[0];
  expect(shared).toMatchObject({ name: "Private Peer", email: "peer@example.test", phone: null, roomLabel: "" });
  preferences = DEFAULT_HOUSEMATE_SHARING;
  expect((await loadResidentMoveInForEmail("self@example.test"))?.housemates[0].email).toBe("");
});
it("fails closed if preferences cannot be loaded", async () => {
  preferences = { shareName: true, shareEmail: true, sharePhone: true, shareRoom: true }; prefError = true;
  expect((await loadResidentMoveInForEmail("self@example.test"))?.housemates[0]).toMatchObject({ name: "Housemate", email: "", phone: null, roomLabel: "", isRoommate: false });
});

it("never reveals an email through a missing name when only name sharing is enabled", async () => {
  peerName = "";
  preferences = { ...DEFAULT_HOUSEMATE_SHARING, shareName: true };
  const mate = (await loadResidentMoveInForEmail("self@example.test"))?.housemates[0];
  expect(mate).toMatchObject({ name: "Housemate", email: "" });
  expect(JSON.stringify(mate)).not.toContain("peer@example.test");
});

it.each(["Moved out", "Former", "Inactive"])("hides current housemates from a %s resident", async stage => {
  selfStage = stage; preferences = { shareName: true, shareEmail: true, shareRoom: true, sharePhone: true };
  expect((await loadResidentMoveInForEmail("self@example.test"))?.housemates).toEqual([]);
});
it("excludes former peers and peers whose move-out date passed", async () => {
  preferences = { shareName: true, shareEmail: true, shareRoom: true, sharePhone: true };
  peerStage = "Moved out";
  expect((await loadResidentMoveInForEmail("self@example.test"))?.housemates).toEqual([]);
  peerStage = "Approved"; peerMoveOut = "2020-01-01";
  expect((await loadResidentMoveInForEmail("self@example.test"))?.housemates).toEqual([]);
});
