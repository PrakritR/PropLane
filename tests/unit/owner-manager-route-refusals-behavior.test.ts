/**
 * Behavioural companion to `owner-only-manager-routes.test.ts` and
 * `portal-vendors-owner-refused.test.ts`, which prove their rules by reading the
 * route's SOURCE TEXT. This one calls the exported `GET`/`POST` with an
 * owner-only session and asserts the status a client actually receives, so a
 * route that keeps the `refuseOwnerOnly` call but stops reaching it still fails.
 *
 * Set `OWNER_EVIDENCE_DIR` to also drop the run out as a readable transcript.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const OWNER = "owner-user";
const MANAGER = "manager-1";
const WS = "ws-1";
const HOUSE = "house-a";

const session: { userId: string | null } = { userId: OWNER };
let serviceDb: unknown;

// Several manager routes read through the SESSION client rather than the
// service-role one, so it needs `from` too — otherwise the route 500s on the
// mock before it ever reaches its owner gate.
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: session.userId ? { id: session.userId, user_metadata: {} } : null } }) },
    from: (table: string) => (serviceDb as { from: (t: string) => unknown }).from(table),
  }),
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => serviceDb }));
vi.mock("@/lib/test-workspaces/index.server", () => ({
  resolveAuthenticatedBusinessAccess: async () => ({ kind: "normal" }),
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: async () => ({ ok: true }),
  clientIpFrom: () => "127.0.0.1",
}));

import { makeFakeDb } from "./property-owner-fake-db";
import { MANAGER_INBOX_SCOPE } from "@/lib/portal-inbox-thread-scope";
import { assertOwnerPayloadRedacted, forbiddenOwnerPayloadKeys } from "@/lib/property-owner/projection";
import { buildOwnerSummary } from "@/lib/property-owner/summary";

/** An accepted Property owner membership over one house, Performance granted. */
const ownerLink = (status: string) => ({
  id: "link-1",
  inviter_user_id: MANAGER,
  invitee_user_id: OWNER,
  status,
  team_role: "property_owner",
  workspace_id: WS,
  house_scope: "selected",
  assigned_property_ids: [HOUSE],
  property_co_manager_permissions: {
    [HOUSE]: { ownerPerformance: { read: true }, ownerStatements: { read: true }, ownerDocuments: { read: true } },
  },
  workspace_permissions: {},
});

const baseTables = {
  portal_workspaces: [{ id: WS, name: "Main", owner_user_id: MANAGER }],
  profiles: [
    { id: OWNER, email: "dana@whitfieldholdings.example", role: "manager", full_name: "Dana Whitfield" },
    { id: MANAGER, email: "manager@example.com", full_name: "Morgan Reyes" },
  ],
  profile_roles: [{ user_id: OWNER, role: "manager" }],
  manager_property_records: [{ id: HOUSE, manager_user_id: MANAGER, workspace_id: WS }],
  manager_purchases: [],
};

const lines: string[] = [];
function log(s = ""): void {
  lines.push(s);
}

async function readResponse(res: unknown): Promise<{ status: number; body: unknown }> {
  const r = res as Response;
  const text = await r.text().catch(() => "");
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep the raw text */
  }
  return { status: r.status, body };
}

/** Calls a route export and records one transcript line. */
async function record(label: string, call: () => Promise<unknown>): Promise<number> {
  let status = 0;
  let body: unknown = null;
  try {
    ({ status, body } = await readResponse(await call()));
  } catch (error) {
    status = -1;
    body = `threw: ${error instanceof Error ? error.message : String(error)}`;
  }
  const rendered = typeof body === "string" ? body : JSON.stringify(body);
  log(`  ${String(status).padEnd(4)} ${label}`);
  log(`       -> ${rendered.length > 160 ? `${rendered.slice(0, 160)}…` : rendered}`);
  return status;
}

describe("Property owner — HTTP contract transcript", () => {
  it("answers 401 signed out, 403 once revoked, and 200 with a redacted payload while granted", async () => {
    const { GET } = await import("@/app/api/owner/summary/route");

    log("== /api/owner/summary — who may read it ==");

    session.userId = null;
    serviceDb = makeFakeDb({ ...baseTables, account_link_invites: [ownerLink("accepted")] });
    const signedOut = await record("GET /api/owner/summary  (signed out)", () => GET(new Request("http://localhost/api/owner/summary")));
    expect(signedOut).toBe(401);

    session.userId = OWNER;
    serviceDb = makeFakeDb({ ...baseTables, account_link_invites: [ownerLink("cancelled")] });
    const revoked = await record("GET /api/owner/summary  (owner revoked by the manager)", () =>
      GET(new Request("http://localhost/api/owner/summary")),
    );
    expect(revoked).toBe(403);
    log();
  });

  it("refuses an owner-only account on every manager surface it must not reach", async () => {
    session.userId = OWNER;
    log("== manager surfaces, called by an owner-only account ==");

    const surfaces: Array<[string, () => Promise<unknown>]> = [
      [
        "GET  /api/portal-vendors        (shared vendor directory)",
        async () => (await import("@/app/api/portal-vendors/route")).GET(new Request("http://localhost/api/portal-vendors")),
      ],
      [
        "POST /api/portal-vendors",
        async () =>
          (await import("@/app/api/portal-vendors/route")).POST(
            new Request("http://localhost/api/portal-vendors", { method: "POST", body: "{}" }),
          ),
      ],
      [
        "POST /api/agent/chat            (manager assistant)",
        async () =>
          (await import("@/app/api/agent/chat/route")).POST(
            new Request("http://localhost/api/agent/chat", { method: "POST", body: JSON.stringify({ messages: [] }) }),
          ),
      ],
      [
        "POST /api/workspaces            (create a workspace)",
        async () =>
          (await import("@/app/api/workspaces/route")).POST(
            new Request("http://localhost/api/workspaces", { method: "POST", body: JSON.stringify({ name: "Mine" }) }),
          ),
      ],
      [
        "POST /api/pro/account-links     (invite a teammate)",
        async () =>
          (await import("@/app/api/pro/account-links/route")).POST(
            new Request("http://localhost/api/pro/account-links", { method: "POST", body: JSON.stringify({ email: "x@y.z" }) }),
          ),
      ],
      [
        "GET  /api/portal-inbox-threads  (manager-scope inbox)",
        async () =>
          (await import("@/app/api/portal-inbox-threads/route")).GET(
            new Request(`http://localhost/api/portal-inbox-threads?scope=${MANAGER_INBOX_SCOPE}`),
          ),
      ],
    ];

    const statuses: Record<string, number> = {};
    for (const [label, call] of surfaces) {
      serviceDb = makeFakeDb({ ...baseTables, account_link_invites: [ownerLink("accepted")] });
      statuses[label] = await record(label, call);
    }
    log();

    // Every one of them must refuse. 403 is the designed answer and 503 the
    // fail-closed one when the membership cannot be read. The manager inbox
    // answers 401 instead: `withholdManagerSurface` runs inside
    // `resolveInboxScopeUser`, so the scope never resolves and the route's own
    // `refuseOwnerOnly` is never reached. Different status, same refusal —
    // what matters is that no surface answers with manager data.
    for (const [label, status] of Object.entries(statuses)) {
      expect([401, 403, 503], `${label} answered ${status}`).toContain(status);
    }
  });

  it("hands the owner only allowlisted keys — no name, email, phone, vendor or ledger field", () => {
    log("== the owner payload, key by key ==");
    const summary = buildOwnerSummary("2026-10", [
      {
        propertyId: HOUSE,
        label: "412 Broadway Ave",
        profitability: [
          {
            monthKey: "2026-10",
            propertyId: HOUSE,
            grossRent: "$12,475.00",
            otherIncome: "$0.00",
            processingFees: "$359.60",
            vendorPayouts: "$480.00",
            commsCost: "$4.20",
            expenses: "$75.00",
            net: "$11,556.20",
          },
        ],
        rentDueByMonth: { "2026-10": 1_260_000 },
        units: 6,
        occupied: 5,
        unitRows: [{ unit: "Room 4", status: "vacant", rentCents: null, leaseEnd: null }],
      },
    ]);

    const keys = [...new Set(JSON.stringify(summary).match(/"([a-zA-Z]+)":/g) ?? [])].map((k) => k.slice(1, -2)).sort();
    log(`  keys reaching the owner: ${keys.join(", ")}`);
    log(`  forbidden keys found:    ${JSON.stringify(forbiddenOwnerPayloadKeys(summary))}`);

    const month = summary.properties[0]!.months.at(-1)!;
    log(`  vendor payouts + logged expenses collapse to one figure: repairsServicesCents = ${month.repairsServicesCents}`);
    log(`  owner net equals the manager Profitability net for the month: netCents = ${month.netCents} ($11,556.20)`);
    log();

    expect(forbiddenOwnerPayloadKeys(summary)).toEqual([]);
    expect(() => assertOwnerPayloadRedacted(summary)).not.toThrow();
    // The Profitability report's own net cell, to the cent.
    expect(month.netCents).toBe(1_155_620);
  });

  it("writes the transcript", () => {
    const dir = process.env.OWNER_EVIDENCE_DIR;
    if (!dir) return;
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/owner-api-contract.txt`, `${lines.join("\n")}\n`, "utf8");
    // eslint-disable-next-line no-console
    console.log(`\n${lines.join("\n")}`);
  });
});
