/**
 * The in-app house chat, pure half: who is in a house, who has moved out, and what one viewer may see
 * of the stored row. No database, no server-only imports, so the rules are table-testable.
 *
 * Members are decided by the Bookings occupancy snapshot (the same stays the SMS house group reads,
 * `house-groups/stay-members.ts`), re-derived on every read and write. The stored roster only narrows
 * which threads to look at and who gets a "Welcome" line; it is never the authority.
 */
import { HOUSE_ROOT_TEXT, houseThreadDisplayName } from "@/lib/house-thread-id";
import {
  firstNameOf,
  stayCoversDay,
  stayIsLongTerm,
  type OccupancyStayLike,
} from "@/lib/house-groups/stay-members";

export type HouseResident = {
  /** Lower-cased login email: the identity a lease carries. */
  email: string;
  firstName: string;
  roomLabel: string;
  /** Move-in day (`YYYY-MM-DD`); the earliest of a resident's current stays in the house. */
  moveIn: string;
};

/**
 * A house's current long-term residents: stays at `propertyId` that cover `today`, are long-term, and
 * carry a resident with an email. One per email (earliest move-in), earliest move-in first. In-app
 * needs no SMS consent, no verified phone and no member cap.
 */
export function houseResidentsFromStays(
  stays: readonly OccupancyStayLike[],
  input: { propertyId: string; today: string },
): HouseResident[] {
  const byEmail = new Map<string, HouseResident>();
  for (const stay of stays) {
    if (stay.propertyId !== input.propertyId || !stay.resident) continue;
    if (!stayCoversDay(stay, input.today) || !stayIsLongTerm(stay)) continue;
    const email = String(stay.resident.residentEmail ?? "").trim().toLowerCase();
    if (!email.includes("@")) continue;
    const prior = byEmail.get(email);
    if (prior && prior.moveIn <= stay.start) continue;
    byEmail.set(email, {
      email,
      firstName: firstNameOf(stay.resident.residentName) || capitalized(firstNameOf(email.split("@")[0])) || "Resident",
      roomLabel: String(stay.roomLabel ?? "").trim().slice(0, 60),
      moveIn: stay.start,
    });
  }
  return [...byEmail.values()].sort((a, b) => a.moveIn.localeCompare(b.moveIn) || a.email.localeCompare(b.email));
}

function capitalized(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

export type HouseResidentDiff = { joined: HouseResident[]; leftEmails: string[]; same: boolean };

/** Who joined and who left between the stored roster and today's residents (by email only). */
export function diffHouseResidents(
  stored: readonly { email: string }[],
  desired: readonly HouseResident[],
): HouseResidentDiff {
  const had = new Set(stored.map((r) => r.email.trim().toLowerCase()));
  const want = new Set(desired.map((r) => r.email));
  const joined = desired.filter((r) => !had.has(r.email));
  const leftEmails = [...had].filter((email) => !want.has(email)).sort();
  return { joined, leftEmails, same: joined.length === 0 && leftEmails.length === 0 };
}

/** "Maya · Room 2": the only way a housemate is named to another resident. */
export function housemateLabel(resident: { firstName: string; roomLabel?: string | null }): string {
  const room = resident.roomLabel?.trim();
  return room ? `${resident.firstName} · ${room}` : resident.firstName;
}

export type MoveOutPlan = {
  email: string;
  /** The last day of the latest long-term residency they held in the workspace. */
  endedOn: string;
};

/**
 * Residents whose residency in this workspace has ended, so their one-on-one conversations move to
 * Archived. `stays` must cover EVERY house of the workspace. A resident is planned only when they
 * have at least one long-term stay with a resident payload and NO stay that is current, open-ended or
 * still to come anywhere in the workspace ("another current residency" keeps them active). Residencies
 * that ended more than `lookbackDays` ago are left alone: the sweep has long since handled them.
 */
export function planMoveOutArchives(
  stays: readonly OccupancyStayLike[],
  input: { today: string; lookbackDays?: number },
): MoveOutPlan[] {
  const lookback = input.lookbackDays ?? 90;
  const floor = new Date(Date.parse(`${input.today}T12:00:00Z`) - lookback * 86_400_000).toISOString().slice(0, 10);
  const latestEnd = new Map<string, string>();
  const stillResident = new Set<string>();
  for (const stay of stays) {
    if (!stay.resident) continue;
    const email = String(stay.resident.residentEmail ?? "").trim().toLowerCase();
    if (!email.includes("@")) continue;
    if (stay.openEnded || stay.end >= input.today) {
      // Current, open-ended or upcoming: a short guest hold does not end a long-term residency, but it
      // does not END one either, so only a long-term stay keeps the person active.
      if (stayIsLongTerm(stay)) stillResident.add(email);
      continue;
    }
    if (!stayIsLongTerm(stay)) continue;
    const prior = latestEnd.get(email);
    if (!prior || stay.end > prior) latestEnd.set(email, stay.end);
  }
  const plans: MoveOutPlan[] = [];
  for (const [email, endedOn] of latestEnd) {
    if (stillResident.has(email) || endedOn < floor) continue;
    plans.push({ email, endedOn });
  }
  return plans.sort((a, b) => a.email.localeCompare(b.email));
}

// ---- the stored row ----

export type HouseChatMessage = {
  id: string;
  /** Display name at post time: "Maya · Room 2" for a resident, a teammate's name, or "PropLane". */
  from: string;
  body: string;
  /** `formatInboxStamp` label. */
  at: string;
  atMs: number;
  /** Who typed it. Never sent to another viewer; only decides which side a line is drawn on. */
  actorUserId?: string;
  /** A "Welcome <name>" or other house line written by PropLane. */
  system?: boolean;
  attachments?: { url: string; name?: string }[];
};

export type HouseViewerState = { folder?: "trash"; readAtMs?: number };

export type HouseChatState = {
  version: 1;
  houseLabel: string;
  /** Last synced roster (narrowing + welcome lines only; occupancy is the authority). */
  residents: (HouseResident & { joinedAt: string })[];
  viewerState: Record<string, HouseViewerState>;
};

export type HouseViewer = {
  userId: string;
  email: string;
  /** Which inbox the row is drawn into. */
  scope: string;
  kind: "resident" | "team";
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function readHouseChatState(rowData: Record<string, unknown>): HouseChatState {
  const raw = asRecord(rowData.houseChat);
  const residents = Array.isArray(raw.residents) ? (raw.residents as HouseChatState["residents"]) : [];
  return {
    version: 1,
    houseLabel: typeof raw.houseLabel === "string" ? raw.houseLabel : "",
    residents: residents.filter((r) => r && typeof r.email === "string"),
    viewerState: asRecord(raw.viewerState) as Record<string, HouseViewerState>,
  };
}

function messagesOf(rowData: Record<string, unknown>): HouseChatMessage[] {
  return Array.isArray(rowData.messages) ? (rowData.messages as HouseChatMessage[]) : [];
}

function sameViewer(message: HouseChatMessage, viewer: HouseViewer): boolean {
  return Boolean(message.actorUserId) && Boolean(viewer.userId) && message.actorUserId === viewer.userId;
}

/** Unread for one viewer: the latest line is somebody else's, is not a house line, and is newer than they last read. */
export function houseThreadUnreadFor(rowData: Record<string, unknown>, viewer: HouseViewer): boolean {
  const state = readHouseChatState(rowData).viewerState[viewer.userId];
  const readAt = state?.readAtMs ?? 0;
  return messagesOf(rowData).some((m) => !m.system && !sameViewer(m, viewer) && (m.atMs ?? 0) > readAt);
}

/**
 * The row as ONE viewer may see it: an allowlist projection. A resident sees housemates by first name
 * and room only; no email, phone, user id or amount of anyone rides along, whoever the viewer is.
 */
export function houseThreadRowForViewer(
  stored: { id: string; row_data: Record<string, unknown> | null },
  viewer: HouseViewer,
): Record<string, unknown> {
  const row = stored.row_data ?? {};
  const state = readHouseChatState(row);
  const title = houseThreadDisplayName(state.houseLabel);
  const messages = messagesOf(row).map((m) => ({
    id: m.id,
    from: m.system ? "PropLane" : m.from,
    body: m.body,
    at: m.at,
    outbound: !m.system && sameViewer(m, viewer),
    channel: "proplane" as const,
    ...(m.system ? { automated: true } : {}),
    ...(m.attachments?.length ? { attachments: m.attachments } : {}),
  }));
  const last = messages[messages.length - 1];
  const folder = state.viewerState[viewer.userId]?.folder === "trash" ? "trash" : "inbox";
  return {
    id: stored.id,
    folder,
    from: title,
    email: "",
    subject: title,
    preview: last ? last.body.slice(0, 100).replace(/\n/g, " ") : "",
    body: HOUSE_ROOT_TEXT,
    time: typeof row.time === "string" ? row.time : "",
    rootAt: typeof row.rootAt === "string" ? row.rootAt : "",
    rootOutbound: false,
    unread: houseThreadUnreadFor(row, viewer),
    scope: viewer.scope,
    rootMessageId: typeof row.rootMessageId === "string" ? row.rootMessageId : `house-root:${stored.id}`,
    workspaceId: typeof row.workspaceId === "string" ? row.workspaceId : undefined,
    houseId: typeof row.houseId === "string" ? row.houseId : undefined,
    houseLabel: state.houseLabel || undefined,
    threadType: "house",
    messages,
  };
}
