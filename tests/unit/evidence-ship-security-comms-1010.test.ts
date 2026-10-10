/**
 * Evidence harness for the ship-to-production security pass (2026-10-10) — the
 * comms and public-surface half.
 *
 * Drives real code against a fake database and records what it returned:
 *
 *   1. Team chat roster — with no resolvable workspace the roster is the owner
 *      alone, never every account that ever linked to them.
 *   2. Team relay hourly cap — re-counted AFTER the insert, so a text that a
 *      concurrent fan-out pushed over the cap is blocked instead of sent.
 *   3. The public room-occupancy snapshot is rate-limited for every caller (the
 *      REAL limiter, not a stub) and a query-stringed snapshot read is sent
 *      back to the one cacheable URL without touching the database.
 *   4. A View-as session heals nothing on read.
 *
 * With EVIDENCE_DIR set it writes `security-comms.txt`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { createFakeDb, type FakeDb } from "../helpers/fake-table-db";
import { createMemoryDb } from "./support/memory-supabase";

const OUT = process.env.EVIDENCE_DIR ?? "";
const log: string[] = [];
const say = (line = "") => log.push(line);

// ── Team chat relay ──────────────────────────────────────────────────────────
let racingDb: FakeDb | null = null;
const enqueueOwnerSms = vi.fn(async (_input: Record<string, unknown>, _db?: unknown) => {
  // Our row, plus a concurrent fan-out's row landing at the same moment.
  const mine = { id: "outbox-mine", manager_user_id: "owner-1", purpose: "team_chat_relay", selected_work_line_id: "line-ws1", status: "queued", created_at: new Date().toISOString() };
  racingDb?.tables.sms_outbox!.push(mine, { ...mine, id: "outbox-racer" });
  return { ok: true as const, outboxId: "outbox-mine", status: "queued", deduplicated: false };
});
vi.mock("@/lib/sms/owner-sms-dispatcher.server", () => ({
  enqueueOwnerSms: (input: Record<string, unknown>, db?: unknown) => enqueueOwnerSms(input, db),
}));
vi.mock("@/lib/sms/manager-number-provisioning.server", () => ({
  resolveWorkspaceSendLine: async () => ({ phoneNumber: "+15005550001", numberId: "line-ws1" }),
}));
vi.mock("@/lib/sms-consent", () => ({ isPhoneOptedOut: async () => false }));
const defaultWorkspace = vi.hoisted(() => ({ id: "ws-1" }));
vi.mock("@/lib/communication/manager-assistant-workspace.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/communication/manager-assistant-workspace.server")>()),
  userDefaultWorkspaceId: async () => defaultWorkspace.id,
}));

// ── Public room occupancy route (the REAL rate limiter stays in play) ────────
const publicMocks = vi.hoisted(() => ({ db: {}, listings: vi.fn(), load: vi.fn() }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => publicMocks.db }));
vi.mock("@/lib/public-listings.server", () => ({ getPublicListings: publicMocks.listings }));
vi.mock("@/lib/public-room-occupancy.server", () => ({ loadPublicRoomOccupancy: publicMocks.load }));

// ── Manager Communication GET (View-as) ──────────────────────────────────────
const SCOPE = "axis_portal_inbox_manager_v1";
const A = "owner-a";
const W1 = "workspace-a-default";
const state = vi.hoisted(() => ({ viewer: { id: "", email: "" }, cookie: undefined as string | undefined, db: null as unknown, viewAs: false }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === "proplane-workspace" && state.cookie ? { value: state.cookie } : undefined) }),
}));
vi.mock("@/lib/portal-inbox-thread-scope", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveInboxScopeUser: async () => ({ user: { id: state.viewer.id, email: state.viewer.email, role: "manager" }, db: state.db }),
  applyPortalInboxThreadScope: (query: { in: (col: string, ids: string[]) => unknown }, user: { id: string }, extra: string[] = []) =>
    query.in("owner_user_id", [user.id, ...extra]),
}));
vi.mock("@/lib/auth/view-as.server", () => ({ isViewAsSessionOpen: async () => state.viewAs }));
const ensureNotice = vi.hoisted(() => vi.fn());
vi.mock("@/lib/agent-notify.server", () => ({ ensureManagerAgentNoticeThread: ensureNotice }));
vi.mock("@/lib/agent/resident-inbox-agent.server", () => ({ ensureResidentAgentThread: vi.fn() }));
vi.mock("@/lib/resident-manager-scope", () => ({ managerIdsOwningResident: vi.fn(async () => []) }));
vi.mock("@/lib/sms-inbox-state.server", () => ({ smsNoticeMembers: vi.fn(async () => []), storedSmsNoticeIdentity: () => false, updateSmsNoticeMailboxState: vi.fn() }));
vi.mock("@/lib/portal-inbox-storage", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  collapseAssistantInboxThreads: (rows: unknown[]) => rows,
  collapsePersonInboxThreads: (rows: unknown[]) => rows,
}));
vi.mock("@/lib/manager-access-server", () => ({ getEffectiveManagerSkuTier: async () => ({ ok: true, tier: "business" }) }));

import { relayTeamChatMessageToSms, resolveWorkspaceTeamMembers } from "@/lib/team-comms.server";
import { GET as publicOccupancyGET } from "@/app/api/public/approved-room-occupancy/route";
import { GET as inboxThreadsGET } from "@/app/api/portal-inbox-threads/route";

const OWNER = "owner-1";
const verified = "2026-10-01T00:00:00.000Z";

function teamSeed() {
  return createFakeDb({
    portal_workspaces: [{ id: "ws-1", owner_user_id: OWNER, is_default: true, name: "Seattle" }],
    account_link_invites: [
      { inviter_user_id: OWNER, invitee_user_id: "tm-default", status: "accepted", workspace_id: null, team_role: "admin" },
      { inviter_user_id: OWNER, invitee_user_id: "tm-elsewhere", status: "accepted", workspace_id: "ws-2", team_role: "admin" },
    ],
    profiles: [
      { id: OWNER, phone: "+12065550100", phone_verified_at: verified },
      { id: "tm-default", phone: "+12065550101", phone_verified_at: verified },
    ],
    sms_outbox: [],
  });
}

beforeEach(() => {
  defaultWorkspace.id = "ws-1";
  racingDb = null;
  enqueueOwnerSms.mockClear();
});

describe("evidence · Team chat roster and relay cap", () => {
  it("falls back to the owner alone when no workspace resolves, and lists the teammates when one does", async () => {
    say("PropLane · security evidence · comms and public surface (2026-10-10)");
    say("Real product code against a fake database. Every line is what the function or route returned.");
    say();
    say("1. Who a Team chat message is relayed to");
    say(`   Workspace ws-1 is ${OWNER}'s. tm-default is linked with no workspace of their own; tm-elsewhere belongs to ws-2.`);

    defaultWorkspace.id = "";
    const noWorkspace = (await resolveWorkspaceTeamMembers(teamSeed() as unknown as SupabaseClient, { ownerManagerUserId: OWNER })).map((m) => m.userId);
    say(`     no workspace resolves      -> roster: ${noWorkspace.join(", ")}`);
    expect(noWorkspace).toEqual([OWNER]);

    defaultWorkspace.id = "ws-1";
    const resolved = (await resolveWorkspaceTeamMembers(teamSeed() as unknown as SupabaseClient, { ownerManagerUserId: OWNER })).map((m) => m.userId).sort();
    say(`     ws-1 resolves              -> roster: ${resolved.join(", ")}  (tm-elsewhere, in ws-2, is not on it)`);
    expect(resolved).toEqual([OWNER, "tm-default"]);
    say();
  });

  it("blocks a relayed text that a concurrent fan-out pushed over the hourly cap", async () => {
    const db = teamSeed();
    racingDb = db;
    const outcomes = await relayTeamChatMessageToSms(db as unknown as SupabaseClient, {
      ownerManagerUserId: OWNER,
      workspaceId: "ws-1",
      senderUserId: "tm-default",
      senderName: "Tee",
      text: "hello",
      messageId: "m1",
      cap: 1,
    });
    const mine = db.tables.sms_outbox!.find((row) => row.id === "outbox-mine") as Record<string, unknown>;
    say("2. The relay's hourly cap is re-counted AFTER the insert");
    say("   Cap 1/hour. Our text inserts, and a concurrent fan-out's text lands in the same instant.");
    say(`     relay outcome              -> ${JSON.stringify(outcomes)}`);
    say(`     our outbox row             -> status=${String(mine.status)} blocked_reason=${String(mine.blocked_reason)}  (nothing left the building)`);
    expect(outcomes).toEqual([{ memberUserId: OWNER, status: "skipped", reason: "hourly_cap" }]);
    expect(mine).toMatchObject({ status: "blocked", blocked_reason: "hourly_cap" });
    say();
  });
});

describe("evidence · the public room-occupancy snapshot is rate-limited", () => {
  it("serves the snapshot, then answers 429 once the real limiter's window is spent", async () => {
    publicMocks.listings.mockResolvedValue([{ id: "home" }, { id: "other" }]);
    publicMocks.load.mockResolvedValue([]);
    // A fixed, non-caller-controllable client address for this run.
    const ip = `203.0.113.${Math.floor(Math.random() * 200) + 1}`;
    const request = (query: string) =>
      new NextRequest(`http://localhost/api/public/approved-room-occupancy${query}`, { headers: { "x-vercel-forwarded-for": ip } });

    say("3. The public room-availability snapshot (anonymous, CDN-cached) is rate-limited for every caller");
    say(`   One client address, the product's own limiter (30 snapshot reads / 60s).`);

    const first = await publicOccupancyGET(request(""));
    say(`     read 1                     -> HTTP ${first.status}  cache-control: ${first.headers.get("cache-control")}`);
    expect(first.status).toBe(200);

    let statuses: number[] = [first.status];
    for (let i = 0; i < 40; i += 1) statuses.push((await publicOccupancyGET(request(""))).status);
    const firstRefusal = statuses.indexOf(429);
    say(`     reads 2…41                 -> first 429 at read ${firstRefusal + 1}; ${statuses.filter((s) => s === 429).length} of 41 refused`);
    expect(firstRefusal).toBeGreaterThan(0);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);

    publicMocks.listings.mockClear();
    publicMocks.load.mockClear();
    const redirected = await publicOccupancyGET(request("?x=cache-buster-9f3"));
    say(`     snapshot read with ?x=…    -> HTTP ${redirected.status} -> ${redirected.headers.get("location")}  (database untouched)`);
    expect(redirected.status).toBe(308);
    expect(new URL(redirected.headers.get("location")!).search).toBe("");
    expect(publicMocks.listings).not.toHaveBeenCalled();
    expect(publicMocks.load).not.toHaveBeenCalled();
    say();
  });
});

describe("evidence · a View-as session heals nothing on read", () => {
  it("creates no Assistant thread while viewing as someone, and heals on an ordinary read", async () => {
    const thread = (id: string, owner: string, extra: Record<string, unknown> = {}, rowData: Record<string, unknown> = {}) => ({
      id,
      scope: SCOPE,
      owner_user_id: owner,
      participant_email: null,
      thread_type: null,
      updated_at: "2026-09-15T00:00:00.000Z",
      row_data: { id, folder: "inbox", from: id, email: "", subject: id, preview: "", body: "", time: "Sep 15, 9:00 AM", unread: false, ...rowData },
      ...extra,
    });
    state.db = createMemoryDb({
      profiles: [{ id: A, email: "a@example.test", role: "manager" }],
      portal_workspaces: [{ id: W1, name: "A default", owner_user_id: A, is_default: true, created_at: "2026-01-01" }],
      manager_property_records: [{ id: "h1", manager_user_id: A, workspace_id: W1, row_data: { buildingName: "House One" } }],
      account_link_invites: [],
      portal_inbox_thread_records: [thread("t-h1", A, {}, { propertyId: "h1" })],
    });
    state.viewer = { id: A, email: "a@example.test" };
    state.cookie = W1;
    ensureNotice.mockClear();

    say("4. View-as is read-only — a read never heals, never writes");
    state.viewAs = true;
    const duringViewAs = await inboxThreadsGET(new Request(`https://example.test/api/portal-inbox-threads?scope=${SCOPE}`));
    say(`     operator viewing as ${A} -> HTTP ${duringViewAs.status}, Assistant-thread heal calls: ${ensureNotice.mock.calls.length}`);
    expect(duringViewAs.status).toBe(200);
    expect(ensureNotice).not.toHaveBeenCalled();

    state.viewAs = false;
    const ordinary = await inboxThreadsGET(new Request(`https://example.test/api/portal-inbox-threads?scope=${SCOPE}`));
    say(`     ${A} reading their own  -> HTTP ${ordinary.status}, Assistant-thread heal calls: ${ensureNotice.mock.calls.length}`);
    expect(ensureNotice).toHaveBeenCalledTimes(1);

    if (OUT) {
      mkdirSync(OUT, { recursive: true });
      writeFileSync(`${OUT}/security-comms.txt`, `${log.join("\n")}\n`);
    }
  });
});
