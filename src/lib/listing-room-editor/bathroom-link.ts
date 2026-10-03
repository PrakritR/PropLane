import type {
  ManagerBathroomSubmission,
  ManagerBathroomRoomAccessKind,
  ManagerListingSubmissionV1,
  ManagerRoomSubmission,
} from "@/lib/manager-listing-submission";
import { writeBathroomType } from "@/lib/listing-record-defaults";
import { duplicateBathroomEntry, emptyBathroom } from "@/lib/manager-listing-submission";

export type RoomBathroomMode = "private" | "shared" | "none";
export type BathroomHallLocation = "ensuite" | "hall";

export type RoomBathroomState = {
  mode: RoomBathroomMode;
  location: BathroomHallLocation;
  bath: ManagerBathroomSubmission | null;
  sharedWithRoomIds: string[];
};

export function usersOfBath(sub: ManagerListingSubmissionV1, bath: ManagerBathroomSubmission): ManagerRoomSubmission[] {
  const ids = bath.assignedRoomIds ?? [];
  return (sub.rooms ?? []).filter((r) => ids.includes(r.id));
}

export function bathOfRoom(sub: ManagerListingSubmissionV1, roomId: string): ManagerBathroomSubmission | null {
  return (sub.bathrooms ?? []).find((b) => (b.assignedRoomIds ?? []).includes(roomId)) ?? null;
}

export function bathAccessOf(sub: ManagerListingSubmissionV1, bath: ManagerBathroomSubmission): "private" | "shared" {
  if (bath.accessKind === "shared") return "shared";
  const users = usersOfBath(sub, bath);
  if (users.length > 1) return "shared";
  return "private";
}

export function roomBathroomState(sub: ManagerListingSubmissionV1, roomId: string): RoomBathroomState {
  const bath = bathOfRoom(sub, roomId);
  if (!bath) return { mode: "none", location: "hall", bath: null, sharedWithRoomIds: [] };
  const mode = bathAccessOf(sub, bath);
  const loc: BathroomHallLocation =
    bath.accessKind === "ensuite" || bath.accessKindByRoomId?.[roomId] === "ensuite" ? "ensuite" : "hall";
  const sharedWithRoomIds = usersOfBath(sub, bath).map((r) => r.id).filter((id) => id !== roomId);
  return { mode, location: loc, bath, sharedWithRoomIds };
}

export function bathFactLabel(mode: RoomBathroomMode, location: BathroomHallLocation, sharedRoomCount: number): string {
  if (mode === "none") return "No bath";
  if (mode === "shared") {
    const base = location === "ensuite" ? "Shared ensuite bath" : "Shared bath";
    return sharedRoomCount > 1 ? `${base} · ${sharedRoomCount} rooms` : base;
  }
  return location === "ensuite" ? "Private ensuite bath" : "Private hall bath";
}

export function bathroomDropdownLabel(
  sub: ManagerListingSubmissionV1,
  bath: ManagerBathroomSubmission,
  roomId: string,
): string {
  const i = (sub.bathrooms ?? []).indexOf(bath);
  const name = bath.name.trim() || `Bathroom ${i + 1}`;
  const st = roomBathroomState(sub, roomId);
  const users = usersOfBath(sub, bath);
  const access = bathAccessOf(sub, bath);
  const suffix = access === "shared" ? "Shared" : "Private";
  if (users.some((r) => r.id === roomId)) return `${name} · ${suffix}`;
  return `${name} · ${suffix}`;
}

const ADD_BATHROOM_VALUE = "__add_bathroom__";

export function bathroomOptionsForRoom(
  sub: ManagerListingSubmissionV1,
  roomId: string,
): { value: string; label: string }[] {
  const baths = sub.bathrooms ?? [];
  const opts = baths.map((b) => ({
    value: b.id,
    label: bathroomDropdownLabel(sub, b, roomId),
  }));
  opts.push({ value: ADD_BATHROOM_VALUE, label: "+ Add bathroom" });
  return opts;
}

export function isAddBathroomOption(value: string): boolean {
  return value === ADD_BATHROOM_VALUE;
}

function linkRoomToBath(
  baths: ManagerBathroomSubmission[],
  roomId: string,
  bathId: string | null,
): ManagerBathroomSubmission[] {
  return baths.map((b) => {
    let assigned = (b.assignedRoomIds ?? []).filter((id) => id !== roomId);
    if (bathId && b.id === bathId) assigned = [...assigned, roomId];
    const accessKindByRoomId = { ...(b.accessKindByRoomId ?? {}) };
    if (!assigned.includes(roomId)) delete accessKindByRoomId[roomId];
    return { ...b, assignedRoomIds: assigned, accessKindByRoomId: Object.keys(accessKindByRoomId).length ? accessKindByRoomId : undefined };
  });
}

function mintBathroom(sub: ManagerListingSubmissionV1): ManagerBathroomSubmission {
  const n = (sub.bathrooms ?? []).length + 1;
  const blank = writeBathroomType({ ...emptyBathroom(n - 1), id: `bath-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name: `Bathroom ${n}` }, "full");
  return blank;
}

/** Apply Private / Shared / None (+ location + shared-with) from the room editor. Returns updated submission. */
export function applyRoomBathroom(
  sub: ManagerListingSubmissionV1,
  roomId: string,
  mode: RoomBathroomMode,
  location: BathroomHallLocation,
  sharedWithRoomIds: string[],
): ManagerListingSubmissionV1 {
  let bathrooms = [...(sub.bathrooms ?? [])];
  const cur = bathOfRoom({ ...sub, bathrooms }, roomId);

  if (mode === "none") {
    bathrooms = linkRoomToBath(bathrooms, roomId, null);
    return { ...sub, bathrooms };
  }

  const perRoomKind: ManagerBathroomRoomAccessKind = location === "ensuite" ? "ensuite" : "hall";

  if (mode === "private") {
    const sole = cur && usersOfBath({ ...sub, bathrooms }, cur).every((r) => r.id === roomId);
    let bath = sole && cur ? cur : mintBathroom(sub);
    if (!sole || !cur) bathrooms = [...bathrooms, bath];
    else bath = cur;
    bathrooms = linkRoomToBath(bathrooms, roomId, bath.id);
    bathrooms = bathrooms.map((b) =>
      b.id === bath.id
        ? {
            ...b,
            accessKind: "ensuite",
            accessKindByRoomId: { ...(b.accessKindByRoomId ?? {}), [roomId]: perRoomKind },
          }
        : b,
    );
    return { ...sub, bathrooms };
  }

  const want = [roomId, ...sharedWithRoomIds.filter((id) => id !== roomId)];
  const reuse =
    cur &&
    (bathAccessOf({ ...sub, bathrooms }, cur) === "shared" ||
      usersOfBath({ ...sub, bathrooms }, cur).every((r) => r.id === roomId));
  let bath = reuse && cur ? cur : mintBathroom(sub);
  if (!reuse || !cur) bathrooms = [...bathrooms, bath];
  else bath = cur;

  for (const b of bathrooms) {
    for (const rid of b.assignedRoomIds ?? []) {
      if (!want.includes(rid) && (b.assignedRoomIds ?? []).includes(rid) && b.id === bath.id) {
        /* unassign handled below */
      }
    }
  }
  bathrooms = bathrooms.map((b) => {
    if (b.id !== bath.id) {
      return linkRoomToBath([b], roomId, null)[0]!;
    }
    const assigned = [...new Set(want)];
    const accessKindByRoomId: Partial<Record<string, ManagerBathroomRoomAccessKind>> = {};
    for (const rid of assigned) accessKindByRoomId[rid] = perRoomKind;
    return {
      ...b,
      assignedRoomIds: assigned,
      accessKind: "shared",
      accessKindByRoomId,
      allResidents: false,
    };
  });
  for (const other of bathrooms) {
    if (other.id === bath.id) continue;
    const assigned = (other.assignedRoomIds ?? []).filter((id) => !want.includes(id));
    if (assigned.length !== (other.assignedRoomIds ?? []).length) {
      const idx = bathrooms.findIndex((x) => x.id === other.id);
      bathrooms[idx] = { ...other, assignedRoomIds: assigned };
    }
  }

  return { ...sub, bathrooms };
}

/** Mirror: edit bathroom type / location / rooms from bathroom editor. */
export function applyBathroomRooms(
  sub: ManagerListingSubmissionV1,
  bathId: string,
  access: "private" | "shared",
  location: BathroomHallLocation,
  roomIds: string[],
): ManagerListingSubmissionV1 {
  const perRoomKind: ManagerBathroomRoomAccessKind = location === "ensuite" ? "ensuite" : "hall";
  const keys = access === "private" ? roomIds.slice(0, 1) : [...new Set(roomIds)];
  let bathrooms = [...(sub.bathrooms ?? [])];

  for (const b of bathrooms) {
    if (b.id === bathId) continue;
    const assigned = (b.assignedRoomIds ?? []).filter((id) => !keys.includes(id));
    if (assigned.length !== (b.assignedRoomIds ?? []).length) {
      const idx = bathrooms.findIndex((x) => x.id === b.id);
      bathrooms[idx] = { ...b, assignedRoomIds: assigned };
    }
  }

  bathrooms = bathrooms.map((b) => {
    if (b.id !== bathId) return b;
    const accessKindByRoomId: Partial<Record<string, ManagerBathroomRoomAccessKind>> = {};
    for (const rid of keys) accessKindByRoomId[rid] = perRoomKind;
    return {
      ...b,
      assignedRoomIds: keys,
      accessKind: access === "shared" ? "shared" : "ensuite",
      accessKindByRoomId,
      allResidents: false,
    };
  });

  return { ...sub, bathrooms };
}

/** Pick an existing bathroom for this room (dropdown), without changing private/shared mode. */
export function assignRoomToBathroom(
  sub: ManagerListingSubmissionV1,
  roomId: string,
  bathId: string,
): ManagerListingSubmissionV1 {
  let bathrooms = (sub.bathrooms ?? []).map((b) => ({
    ...b,
    assignedRoomIds: (b.assignedRoomIds ?? []).filter((id) => id !== roomId),
    accessKindByRoomId: (() => {
      const next = { ...(b.accessKindByRoomId ?? {}) };
      delete next[roomId];
      return Object.keys(next).length ? next : undefined;
    })(),
  }));
  bathrooms = bathrooms.map((b) =>
    b.id === bathId ? { ...b, assignedRoomIds: [...(b.assignedRoomIds ?? []), roomId] } : b,
  );
  return { ...sub, bathrooms };
}

/** Same as Room X: copy bathroom link (mode, location, shared-with), not description fields. */
export function copyRoomBathroomLinkFrom(
  sub: ManagerListingSubmissionV1,
  targetRoomId: string,
  sourceRoomId: string,
): ManagerListingSubmissionV1 {
  const st = roomBathroomState(sub, sourceRoomId);
  return applyRoomBathroom(sub, targetRoomId, st.mode, st.location, st.sharedWithRoomIds);
}

export function addBathroomForRoom(sub: ManagerListingSubmissionV1, roomId: string): ManagerListingSubmissionV1 {
  const bath = mintBathroom(sub);
  const next = { ...sub, bathrooms: [...(sub.bathrooms ?? []), bath] };
  return applyRoomBathroom(next, roomId, "private", "hall", []);
}

export function duplicateBathroomInSubmission(
  sub: ManagerListingSubmissionV1,
  bathId: string,
): ManagerListingSubmissionV1 {
  const baths = sub.bathrooms ?? [];
  const source = baths.find((b) => b.id === bathId);
  if (!source) return sub;
  const idx = baths.indexOf(source);
  const copy = duplicateBathroomEntry(source);
  return { ...sub, bathrooms: [...baths.slice(0, idx + 1), copy, ...baths.slice(idx + 1)] };
}

export { ADD_BATHROOM_VALUE };
