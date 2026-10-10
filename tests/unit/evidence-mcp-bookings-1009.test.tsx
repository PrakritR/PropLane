// @vitest-environment jsdom
/**
 * Evidence harness for the MCP side of the Bookings pass (2026-10-09):
 *
 *  - the two connection screens a manager actually sees when an MCP client asks
 *    for access (Allow, then Connected), rendered for screenshotting;
 *  - a transcript of what the booking tools hand back to the client, including
 *    the resident's rent and the Airbnb stay fenced as untrusted feed text, and
 *    the approval card a write tool puts in front of the manager.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { mkdirSync, writeFileSync } from "node:fs";
import type { AgentContext } from "@/lib/tools/context";

const OUT = process.env.EVIDENCE_DIR ?? "";
const log: string[] = [];
const say = (line = "") => log.push(line);

function writeShot(name: string, caption: string, body: string) {
  if (!OUT) return;
  mkdirSync(`${OUT}/html`, { recursive: true });
  writeFileSync(
    `${OUT}/html/${name}.html`,
    `<!doctype html><html lang="en" class="h-full antialiased" data-theme="light"><head><meta charset="utf-8"><link rel="stylesheet" href="./app.css"></head>
<body class="min-h-full bg-background text-foreground">
<div style="max-width:900px;margin:16px auto;padding:0 16px">
<p style="font:600 13px/1.5 system-ui;color:#475569;margin:0 0 10px;white-space:pre-line">${caption}</p>
${body}</div></body></html>`,
  );
}

vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));
vi.mock("@/lib/tools/context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tools/context")>()),
  resolveAgentContext: async () => ({
    userId: "u1",
    email: "ambika@example.test",
    workspace: { id: "w1", name: "Seattle Homes" },
    db: { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { full_name: "Ambika Mago" } }) }) }) }) },
  }),
}));
vi.mock("@/lib/mcp/oauth.server", () => ({
  MCP_OAUTH_SCOPE: "mcp:tools",
  getMcpOAuthClient: async () => ({ clientId: "c1", clientName: "Claude", redirectUris: ["https://claude.ai/api/mcp/auth_callback"] }),
  signMcpApproval: () => "approval-token",
  verifyMcpConnected: () => ({
    userId: "u1",
    clientName: "Claude",
    workspaceName: "Seattle Homes",
    destination: "https://claude.ai/api/mcp/auth_callback?code=c&state=s",
  }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "u1" } } } ) } }),
}));

// Property access is a policy decision owned by manager-lease-scope.
const grants = vi.hoisted(() => ({ read: new Set(["prop_a"]), edit: new Set(["prop_a"]) }));
vi.mock("@/lib/auth/manager-lease-scope", () => ({
  managerHasCalendarAccessForProperty: async (_d: unknown, _u: string, id: string) => grants.read.has(id),
  managerCalendarReadableProperties: async (_d: unknown, _u: string, ids: readonly string[]) => new Set(ids.filter((id) => grants.read.has(id))),
  managerCanWriteCalendarForProperty: async (_d: unknown, _u: string, id: string) => grants.edit.has(id),
}));
vi.mock("@/lib/occupancy/snapshot.server", () => ({
  occupancySnapshotForManager: async (_d: unknown, _u: string, input: { propertyIds: string[]; from: string }) => ({
    days: [{ dayKey: input.from, occupied: 1, total: 2, checkIns: 0, checkOuts: 0, houses: input.propertyIds.map((propertyId) => ({ propertyId, occupied: 1, total: 2, checkIns: 0, checkOuts: 0 })) }],
    stays: [
      { id: "s1", propertyId: "prop_a", roomId: "room_1", roomLabel: "Room 1", start: "2026-10-10", end: "2026-12-31", kind: "lease", name: "Ana Resident", monthlyRent: 1500 },
      { id: "s2", propertyId: "prop_a", roomId: "room_1", roomLabel: "Room 1", start: "2026-11-01", end: "2026-11-04", kind: "hold", name: "Jo Hold" },
      { id: "s3", propertyId: "prop_a", roomId: "room_2", roomLabel: "Room 2", start: "2026-10-20", end: "2026-10-22", kind: "guest", name: "Reserved" },
    ].filter((s) => input.propertyIds.includes(s.propertyId)),
    version: "v",
  }),
}));
vi.mock("@/lib/channel-calendar/bookings.server", () => ({
  listManagerChannelCalendarBookings: async (_d: unknown, _u: string, propertyIds: string[]) =>
    propertyIds.includes("prop_a")
      ? [{ propertyId: "prop_a", propertyLabel: "5257 Brooklyn Ave", rooms: [{ roomId: "room_2", provider: "airbnb", ranges: [{ sourceUid: "uid-1", start: "2026-10-20", end: "2026-10-22", summary: "Reserved", reservationCode: "HMABCDEFGH", phoneLast4: "1234", guestName: "Maria Lopez" }] }] }]
      : [],
}));

import McpAuthorizePage from "@/app/mcp/authorize/page";
import McpConnectedPage from "@/app/mcp/connected/page";
import { blockRoomDatesTool, listBookingsTool, listRoomBlocksTool } from "@/lib/tools/domains/bookings";
import { previewWrite } from "./tools/fake-agent-ctx";

type Row = Record<string, unknown>;
function makeCtx(store: Record<string, Row[]>): AgentContext {
  class Q {
    private filters: Array<(r: Row) => boolean> = [];
    constructor(private table: string) { store[table] ??= []; }
    select() { return this; }
    limit() { return this; }
    order() { return this; }
    eq(col: string, val: unknown) { this.filters.push((r) => r[col] === val); return this; }
    in(col: string, vals: unknown[]) { this.filters.push((r) => vals.includes(r[col])); return this; }
    update() { return this; }
    insert(row: Row) { store[this.table]!.push({ ...row }); return Promise.resolve({ data: null, error: null }); }
    then<T>(resolve: (v: { data: Row[]; error: null }) => T) {
      return Promise.resolve({ data: store[this.table]!.filter((r) => this.filters.every((f) => f(r))), error: null }).then(resolve);
    }
  }
  return {
    landlordId: "manager_a", userId: "manager_a", email: "ambika@example.test", roles: ["manager"], isAdmin: false,
    db: { from: (table: string) => new Q(table) },
  } as unknown as AgentContext;
}

const store: Record<string, Row[]> = {
  manager_property_records: [
    { id: "prop_a", manager_user_id: "manager_a", row_data: {}, property_data: { title: "5257 Brooklyn Ave", listingSubmission: { rooms: [{ id: "room_1", name: "Room 1" }, { id: "room_2", name: "Room 2" }] } } },
  ],
  portal_schedule_records: [
    { id: "axis_room_block_manager_a_1", property_id: "prop_a", record_type: "room_date_block", row_data: { id: "axis_room_block_manager_a_1", propertyId: "prop_a", roomId: "room_1", checkIn: "2026-11-01", checkOut: "2026-11-05", reason: "Paint", residentName: "Jo Hold", rate: 900, rateBasis: "monthly" } },
  ],
  audit_log: [],
};

afterAll(() => {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}/mcp-bookings-tools.txt`, `${log.join("\n")}\n`);
});

describe("evidence · the MCP connection screens", () => {
  it("Allow names the client, the signed-in manager, the workspace and what it may do", async () => {
    const element = await McpAuthorizePage({ searchParams: Promise.resolve({
      client_id: "c1",
      redirect_uri: "https://claude.ai/api/mcp/auth_callback",
      code_challenge: "a".repeat(43),
      code_challenge_method: "S256",
      response_type: "code",
      scope: "mcp:tools",
      state: "s1",
    }) });
    const html = renderToStaticMarkup(element);
    expect(html).toContain("Connect Claude to PropLane");
    expect(html).toContain("Seattle Homes");
    expect(html).toContain("Allow");
    expect(html).toContain("Each one waits for your approval in PropLane");
    writeShot("mcp-consent-allow", "An MCP client (here Claude) asks for access. The consent screen names the client, the signed-in account and the workspace it will act in, says reads are reads and every change waits for approval inside PropLane, and offers Allow / Cancel.", html);
  });

  it("Connected confirms the workspace and returns to the client", async () => {
    const html = renderToStaticMarkup(await McpConnectedPage({ searchParams: Promise.resolve({ token: "t" }) }));
    expect(html).toContain("PropLane is connected");
    expect(html).toContain("Claude can now use Seattle Homes");
    writeShot("mcp-connected", "After Allow, PropLane's own Connected screen confirms which workspace the client got, then returns to it. A copied link opened by anybody else is inert.", html);
  });
});

describe("evidence · what the booking tools hand back", () => {
  it("list_bookings, list_room_blocks and the block_room_dates approval card", async () => {
    const ctx = makeCtx(store);
    const bookings = await listBookingsTool.handler(ctx, { from: "2026-10-09", to: "2026-12-31" });
    say("$ mcp call list_bookings { from: 2026-10-09, to: 2026-12-31 }");
    say(JSON.stringify(bookings, null, 2));
    say();

    const blocks = await listRoomBlocksTool.handler(ctx, {});
    say("$ mcp call list_room_blocks {}");
    say(JSON.stringify(blocks, null, 2));
    say();

    const preview = await previewWrite(blockRoomDatesTool, ctx, {
      propertyId: "prop_a", roomId: "room_2", start: "2026-12-01", end: "2026-12-04", reason: "Deep clean", residentName: "Pat",
    });
    say("$ mcp call block_room_dates { prop_a, room_2, Dec 1–4 }  → waits for the manager's approval");
    say(JSON.stringify(preview, null, 2));

    const typed = bookings as { count: number; properties: Array<{ rooms: Array<{ entries: Array<Record<string, unknown>> }> }> };
    const entries = typed.properties[0]!.rooms.flatMap((r) => r.entries);
    expect(entries.find((e) => e.name === "Ana Resident")).toMatchObject({ rent: { amount: 1500, basis: "monthly" } });
    // The channel's own text arrives fenced, never as a bare instruction-shaped string.
    expect(JSON.stringify(entries.find((e) => e.source === "Airbnb booking"))).toContain("EXTERNAL_CHANNEL_BOOKING");
    expect(preview.ok).toBe(true);
  });
});
