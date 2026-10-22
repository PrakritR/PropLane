// The in-app house chat's pure rules: ids, who lives in a house today, who joined or left, who has moved out,
// and what one viewer may see of the stored row (first name + room only, never an email, phone, id or amount).
import { describe, expect, it } from "vitest";

import {
  diffHouseResidents,
  houseResidentsFromStays,
  HOUSE_LIST_MESSAGE_LIMIT,
  houseThreadRowForViewer,
  houseThreadUnreadFor,
  housemateLabel,
  planMoveOutArchives,
  type HouseChatMessage,
  type HouseViewer,
} from "@/lib/house-chat/model";
import { teamScopeAllowsHouseThread } from "@/lib/house-chat/access.server";
import {
  houseConversationKey,
  houseThreadDisplayName,
  houseThreadId,
  isHouseInboxThread,
  parseHouseThreadId,
} from "@/lib/house-thread-id";
import type { OccupancyStayLike } from "@/lib/house-groups/stay-members";
import type { CommunicationScope } from "@/lib/communication/conversation-visibility.server";

const TODAY = "2026-10-20";

function stay(over: Partial<OccupancyStayLike> & { email?: string; name?: string }): OccupancyStayLike {
  const { email, name, ...rest } = over;
  return {
    propertyId: "prop-a",
    roomLabel: "Room 1",
    start: "2026-06-01",
    end: "2027-05-31",
    resident: { source: "proplane", residentName: name ?? "Maya Lopez", residentEmail: email ?? "maya@example.com", residentPhone: "+12065550101" },
    ...rest,
  };
}

describe("house thread ids", () => {
  it("round-trips owner, workspace and house, and names the chat after the house", () => {
    const id = houseThreadId("owner-1", "ws-1", "prop-a");
    expect(id).toBe("house-thread:owner-1:ws:ws-1:prop:prop-a");
    expect(parseHouseThreadId(id)).toEqual({ ownerManagerUserId: "owner-1", workspaceId: "ws-1", propertyId: "prop-a" });
    expect(houseConversationKey("prop-a")).toBe("house:prop-a");
    expect(houseThreadDisplayName("12 Pine St")).toBe("House · 12 Pine St");
    expect(isHouseInboxThread({ id })).toBe(true);
    expect(isHouseInboxThread({ id: "team-thread:o:ws:w" })).toBe(false);
  });

  it("refuses a malformed or other-kind id", () => {
    expect(parseHouseThreadId("team-thread:owner-1:ws:ws-1")).toBeNull();
    expect(parseHouseThreadId("house-thread:owner-1")).toBeNull();
    expect(parseHouseThreadId("house-thread::ws:ws-1:prop:p")).toBeNull();
  });
});

describe("houseResidentsFromStays", () => {
  it("holds a house's current long-term residents: no consent, no phone and no nine-member cap needed", () => {
    const names = ["Ada", "Ben", "Cy", "Dee", "Eli", "Fay", "Gus", "Hal", "Ivy", "Jo", "Kai", "Lou"];
    const stays = names.map((first, i) =>
      stay({ roomLabel: `Room ${i + 1}`, start: `2026-06-${String(i + 1).padStart(2, "0")}`, resident: { source: "proplane", residentName: `${first} Last`, residentEmail: `r${i}@example.com` } }),
    );
    const residents = houseResidentsFromStays(stays, { propertyId: "prop-a", today: TODAY });
    expect(residents).toHaveLength(12);
    expect(residents[0]).toMatchObject({ email: "r0@example.com", firstName: "Ada", roomLabel: "Room 1" });
  });

  it("leaves out a short stay, an ended stay, a future stay, another house and a stay with no email", () => {
    const stays = [
      stay({ email: "keep@example.com" }),
      stay({ email: "short@example.com", start: "2026-10-10", end: "2026-10-24" }),
      stay({ email: "ended@example.com", end: "2026-09-30" }),
      stay({ email: "future@example.com", start: "2026-11-01" }),
      stay({ email: "elsewhere@example.com", propertyId: "prop-b" }),
      stay({ email: "", resident: { source: "hold", residentName: "No Email" } }),
      { propertyId: "prop-a", roomLabel: "Room 9", start: "2026-06-01", end: "2027-05-31" },
    ];
    expect(houseResidentsFromStays(stays, { propertyId: "prop-a", today: TODAY }).map((r) => r.email)).toEqual(["keep@example.com"]);
  });

  it("counts an open-ended stay and lists a resident once, at the earliest move-in", () => {
    const stays = [
      stay({ email: "a@example.com", openEnded: true, end: "2028-01-01" }),
      stay({ email: "a@example.com", start: "2026-08-01", roomLabel: "Room 2" }),
    ];
    const residents = houseResidentsFromStays(stays, { propertyId: "prop-a", today: TODAY });
    expect(residents).toHaveLength(1);
    expect(residents[0]!.moveIn).toBe("2026-06-01");
  });
});

describe("diffHouseResidents", () => {
  it("reports who joined and who left by email", () => {
    const desired = houseResidentsFromStays(
      [stay({ email: "a@example.com" }), stay({ email: "b@example.com", name: "Noah Kim", roomLabel: "Room 2" })],
      { propertyId: "prop-a", today: TODAY },
    );
    const diff = diffHouseResidents([{ email: "a@example.com" }, { email: "gone@example.com" }], desired);
    expect(diff.joined.map((r) => r.email)).toEqual(["b@example.com"]);
    expect(diff.leftEmails).toEqual(["gone@example.com"]);
    expect(diffHouseResidents([{ email: "a@example.com" }, { email: "b@example.com" }], desired).same).toBe(true);
  });
});

describe("planMoveOutArchives", () => {
  it("plans a resident whose only long-term residency ended, with the day it ended", () => {
    const plans = planMoveOutArchives([stay({ email: "old@example.com", end: "2026-10-15" })], { today: TODAY });
    expect(plans).toEqual([{ email: "old@example.com", endedOn: "2026-10-15" }]);
  });

  it("never plans a resident who still has another current, open-ended or upcoming residency in the workspace", () => {
    const stays = [
      stay({ email: "moved@example.com", end: "2026-10-15" }),
      stay({ email: "moved@example.com", propertyId: "prop-b", start: "2026-09-01", end: "2027-08-31" }),
      stay({ email: "open@example.com", end: "2026-10-01" }),
      stay({ email: "open@example.com", propertyId: "prop-b", start: "2026-10-02", end: "2030-01-01", openEnded: true }),
      stay({ email: "next@example.com", end: "2026-10-01" }),
      stay({ email: "next@example.com", propertyId: "prop-b", start: "2026-12-01", end: "2027-11-30" }),
      stay({ email: "still@example.com" }),
    ];
    expect(planMoveOutArchives(stays, { today: TODAY })).toEqual([]);
  });

  it("ignores a short guest hold, an ancient residency, and picks the latest end of several", () => {
    const stays = [
      stay({ email: "guest@example.com", start: "2026-10-01", end: "2026-10-10" }),
      stay({ email: "ancient@example.com", start: "2024-01-01", end: "2025-01-01" }),
      stay({ email: "twice@example.com", start: "2025-01-01", end: "2025-12-31" }),
      stay({ email: "twice@example.com", start: "2026-01-01", end: "2026-10-18" }),
    ];
    expect(planMoveOutArchives(stays, { today: TODAY })).toEqual([{ email: "twice@example.com", endedOn: "2026-10-18" }]);
  });
});

describe("houseThreadRowForViewer", () => {
  const messages: HouseChatMessage[] = [
    { id: "w1", from: "PropLane", body: "Welcome Maya", at: "Oct 1, 9:00 AM", atMs: 1_000, system: true },
    { id: "m1", from: "Maya · Room 1", body: "Trash is out", at: "Oct 2, 9:00 AM", atMs: 2_000, actorUserId: "user-maya" },
    { id: "m2", from: "Noah · Room 2", body: "Thanks", at: "Oct 3, 9:00 AM", atMs: 3_000, actorUserId: "user-noah" },
    { id: "m3", from: "Pat Owner", body: "Plumber Tuesday", at: "Oct 4, 9:00 AM", atMs: 4_000, actorUserId: "owner-1" },
  ];
  const stored = {
    id: houseThreadId("owner-1", "ws-1", "prop-a"),
    row_data: {
      time: "Oct 4, 9:00 AM",
      rootAt: "Oct 1, 9:00 AM",
      workspaceId: "ws-1",
      houseId: "prop-a",
      messages,
      houseChat: {
        version: 1,
        houseLabel: "12 Pine St",
        residents: [
          { email: "maya@example.com", firstName: "Maya", roomLabel: "Room 1", moveIn: "2026-06-01", joinedAt: "x" },
          { email: "noah@example.com", firstName: "Noah", roomLabel: "Room 2", moveIn: "2026-06-02", joinedAt: "x" },
        ],
        viewerState: {},
      },
    },
  };
  const maya: HouseViewer = { userId: "user-maya", email: "maya@example.com", scope: "axis_portal_inbox_resident_v1", kind: "resident" };

  it("draws the viewer's own lines on their side and everyone else by first name and room", () => {
    const row = houseThreadRowForViewer(stored, maya) as { messages: { id: string; from: string; outbound: boolean }[]; subject: string };
    expect(row.subject).toBe("House · 12 Pine St");
    expect(row.messages.map((m) => [m.id, m.from, m.outbound])).toEqual([
      ["w1", "PropLane", false],
      ["m1", "Maya · Room 1", true],
      ["m2", "Noah · Room 2", false],
      ["m3", "Pat Owner", false],
    ]);
  });

  it("gives a RESIDENT the opaque house id, never the stored one that names the owner's account", () => {
    const publicId = "a".repeat(32);
    const withPublic = { ...stored, row_data: { ...stored.row_data, houseChat: { ...stored.row_data.houseChat, publicId } } };
    const row = houseThreadRowForViewer(withPublic, maya);
    expect(row.id).toBe(`house-chat:${publicId}`);
    expect(row.rootMessageId).toBe(`house-root:house-chat:${publicId}`);
    expect(JSON.stringify(row)).not.toContain("owner-1");
    // The team addresses the stored row directly, so they keep the stored id.
    expect(houseThreadRowForViewer(withPublic, { ...maya, kind: "team" }).id).toBe(stored.id);
  });

  it("hands back the newest lines only, so one shared row never grows into the whole history", () => {
    const many = Array.from({ length: HOUSE_LIST_MESSAGE_LIMIT + 10 }, (_, i) => ({
      id: `m-${i}`,
      from: "Noah · Room 2",
      body: `line ${i}`,
      at: "Oct 4, 9:00 AM",
      atMs: 1_000 + i,
      actorUserId: "user-noah",
    }));
    const row = houseThreadRowForViewer({ ...stored, row_data: { ...stored.row_data, messages: many } }, maya) as {
      messages: { id: string }[];
    };
    expect(row.messages).toHaveLength(HOUSE_LIST_MESSAGE_LIMIT);
    expect(row.messages[0]!.id).toBe("m-10");
  });

  it("never carries another person's email, phone, user id, amount or the roster to a viewer", () => {
    const json = JSON.stringify(houseThreadRowForViewer(stored, maya));
    for (const secret of ["maya@example.com", "noah@example.com", "user-noah", "user-maya", "actorUserId", "residents", "joinedAt", "+1206", "$"]) {
      expect(json).not.toContain(secret);
    }
  });

  it("is unread only for lines that are someone else's, newer than the viewer's read marker, and not a house line", () => {
    expect(houseThreadUnreadFor(stored.row_data, maya)).toBe(true);
    const read = { ...stored.row_data, houseChat: { ...stored.row_data.houseChat, viewerState: { "user-maya": { readAtMs: 5_000 } } } };
    expect(houseThreadUnreadFor(read, maya)).toBe(false);
    const onlyWelcome = { ...stored.row_data, messages: [messages[0]!] };
    expect(houseThreadUnreadFor(onlyWelcome, maya)).toBe(false);
  });

  it("archive is the viewer's own: another viewer still sees the chat in Active", () => {
    const archived = { ...stored, row_data: { ...stored.row_data, houseChat: { ...stored.row_data.houseChat, viewerState: { "user-maya": { folder: "trash" } } } } };
    expect(houseThreadRowForViewer(archived, maya)).toMatchObject({ folder: "trash" });
    expect(houseThreadRowForViewer(archived, { ...maya, userId: "user-noah", email: "noah@example.com" })).toMatchObject({ folder: "inbox" });
  });

  it("names a housemate by first name and room only", () => {
    expect(housemateLabel({ firstName: "Maya", roomLabel: "Room 2" })).toBe("Maya · Room 2");
    expect(housemateLabel({ firstName: "Maya", roomLabel: "" })).toBe("Maya");
  });
});

describe("teamScopeAllowsHouseThread", () => {
  const parsed = { ownerManagerUserId: "owner-1", workspaceId: "ws-1", propertyId: "prop-a" };
  const scope = (over: Partial<CommunicationScope>): CommunicationScope => ({
    viewerId: "viewer",
    level: "read",
    ownerIds: ["viewer"],
    grantedHousesByOwner: new Map(),
    workspaceHouseIds: null,
    untaggedOwnedVisible: true,
    activeWorkspaceId: "ws-1",
    workspaceByLine: new Map(),
    ...over,
  });

  it("lets the owner in, in the active workspace only", () => {
    expect(teamScopeAllowsHouseThread(scope({ viewerId: "owner-1" }), parsed)).toEqual({ allowed: true, canPost: true });
    expect(teamScopeAllowsHouseThread(scope({ viewerId: "owner-1", activeWorkspaceId: "ws-2" }), parsed).allowed).toBe(false);
  });

  it("holds the active-workspace rule for a POST too: write access is never wider than read", () => {
    const other = scope({ viewerId: "owner-1", activeWorkspaceId: "ws-2" });
    expect(teamScopeAllowsHouseThread(other, parsed)).toEqual({ allowed: false, canPost: false });
    const member = new Map([["owner-1", new Map([["ws-1", { canPost: true }]])]]);
    const granted = new Map([["owner-1", new Set(["prop-a"])]]);
    const mate = scope({ teamWorkspacesByOwner: member, grantedHousesByOwner: granted, activeWorkspaceId: "ws-2" });
    expect(teamScopeAllowsHouseThread(mate, parsed)).toEqual({ allowed: false, canPost: false });
  });

  it("needs the workspace membership AND the house grant for a teammate; a Viewer reads but cannot post", () => {
    const member = new Map([["owner-1", new Map([["ws-1", { canPost: true }]])]]);
    const granted = new Map([["owner-1", new Set(["prop-a"])]]);
    expect(teamScopeAllowsHouseThread(scope({ teamWorkspacesByOwner: member, grantedHousesByOwner: granted }), parsed)).toEqual({ allowed: true, canPost: true });
    expect(teamScopeAllowsHouseThread(scope({ teamWorkspacesByOwner: member }), parsed).allowed).toBe(false);
    expect(teamScopeAllowsHouseThread(scope({ grantedHousesByOwner: granted }), parsed).allowed).toBe(false);
    const viewer = new Map([["owner-1", new Map([["ws-1", { canPost: false }]])]]);
    expect(teamScopeAllowsHouseThread(scope({ teamWorkspacesByOwner: viewer, grantedHousesByOwner: granted }), parsed)).toEqual({ allowed: true, canPost: false });
    const otherHouse = new Map([["owner-1", new Set(["prop-z"])]]);
    expect(teamScopeAllowsHouseThread(scope({ teamWorkspacesByOwner: member, grantedHousesByOwner: otherHouse }), parsed).allowed).toBe(false);
  });

  it("refuses a closed scope", () => {
    expect(teamScopeAllowsHouseThread(scope({ viewerId: "owner-1", closed: true }), parsed).allowed).toBe(false);
  });
});
