/**
 * Evidence harness — `GET /api/manager-applications` after the 2026-10-10 pass.
 *
 * The route used to AWAIT an orphan-housing sweep (14 sequential reads that may delete) before
 * answering, which is most of why the live Applications/Residents read took ~30s. It now answers
 * first and hands the sweep to `after()`, reports its phase durations as `Server-Timing`, and
 * warns once when a request crosses 3s.
 *
 * Every line written below is what the REAL route returned against a fake database — the header
 * string, the ordering, the warn line. With EVIDENCE_DIR set it writes `applications-timing.txt`.
 */
import { beforeEach, describe, expect, it, vi, afterAll } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";

vi.mock("server-only", () => ({}));

const getUser = vi.fn();
const afterCallbacks: Array<() => unknown> = [];
let VIEW_AS_OPEN = false;
let LINK_LOOKUP_FAILS = false;
const OWNER = "mgr-seattle";
const HOUSE = "seattle-homes-1";

const purge = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ applicationsCleared: 0, recordsDeleted: 0 }));
const linkedIds = vi.fn(async (_db: unknown, _uid: string, _module: string, options?: { strict?: boolean }) => {
  if (LINK_LOOKUP_FAILS && options?.strict) throw new Error("Co-manager link permissions lookup failed: boom");
  return new Set<string>(["co-managed-house"]);
});

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (fn: () => unknown) => {
    afterCallbacks.push(fn);
  },
}));
vi.mock("@/lib/auth/view-as.server", () => ({ isViewAsSessionOpen: vi.fn(async () => VIEW_AS_OPEN) }));
vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: vi.fn(async () => false) }));
vi.mock("@/lib/auth/co-manager-module-scope", () => ({
  linkedPropertyIdsForModule: (...args: Parameters<typeof linkedIds>) => linkedIds(...args),
}));
vi.mock("@/lib/auth/clear-property-housing-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/clear-property-housing-access")>()),
  purgeOrphanHousingRecordsForManager: (...args: unknown[]) => purge(...args),
}));
vi.mock("@/lib/auth/provision-approved-resident", () => ({
  provisionApprovedResidentAccount: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/workspaces/scope.server", () => ({ activeWorkspacePropertyScope: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getUser } }) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => makeDb() }));

/** Three of the Seattle Homes residents, enough for the response body to be real. */
const APP_ROWS = ["Ambika Rao", "Bennett Cole", "Carla Nguyen"].map((name, i) => ({
  id: `AXIS-SEA-0${i + 1}`,
  row_data: { id: `AXIS-SEA-0${i + 1}`, name, email: `r${i}@example.test`, bucket: "approved", manuallyAdded: true, stage: "Active", detail: "" },
  manager_user_id: OWNER,
  property_id: HOUSE,
  assigned_property_id: HOUSE,
  updated_at: "2026-10-01T00:00:00.000Z",
}));

function makeDb() {
  return {
    from(table: string) {
      let eqCol: string | null = null;
      let eqVal: string | null = null;
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq(column: string, value: string) {
          eqCol = column;
          eqVal = value;
          return builder;
        },
        in: () => builder,
        is: () => builder,
        order: () => builder,
        limit: () => builder,
        maybeSingle: () =>
          Promise.resolve({ data: table === "profiles" ? { role: "manager", email: "owner@seattlehomes.test" } : null, error: null }),
        then(resolve: (v: { data: unknown; error: unknown }) => unknown) {
          const data =
            table === "manager_property_records"
              ? [{ id: HOUSE, manager_user_id: OWNER }].filter((p) => eqCol !== "manager_user_id" || p.manager_user_id === eqVal)
              : table === "manager_application_records"
                ? APP_ROWS.filter((r) => eqCol !== "manager_user_id" || r.manager_user_id === eqVal)
                : [];
          return Promise.resolve({ data, error: null }).then(resolve);
        },
      };
      return builder;
    },
  };
}

const OUT = process.env.EVIDENCE_DIR ?? "";
const log: string[] = [];
const say = (line = "") => log.push(line);
afterAll(() => {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}/applications-timing.txt`, `${log.join("\n")}\n`);
});

async function get() {
  const { GET } = await import("@/app/api/manager-applications/route");
  return GET(new Request("https://example.test/api/manager-applications"));
}
async function drainAfter() {
  while (afterCallbacks.length) await afterCallbacks.shift()!();
}

beforeEach(() => {
  vi.clearAllMocks();
  afterCallbacks.length = 0;
  VIEW_AS_OPEN = false;
  LINK_LOOKUP_FAILS = false;
  getUser.mockResolvedValue({ data: { user: { id: OWNER, email: "owner@seattlehomes.test", user_metadata: {} } }, error: null });
});

describe("evidence · GET /api/manager-applications answers before the sweep, and reports its phases", () => {
  it("returns the rows, a Server-Timing breakdown, and leaves the sweep for after the response", async () => {
    say("PropLane · GET /api/manager-applications (2026-10-10)");
    say("The real route handler against a fake database. Every value below is what it returned.");
    say();
    const res = await get();
    const body = (await res.json()) as { rows: { id: string; name?: string }[] };
    say("A normal manager read:");
    say(`  status                 ${res.status}`);
    say(`  rows                   ${body.rows.length} (${body.rows.map((r) => r.id).join(", ")})`);
    say(`  Cache-Control          ${res.headers.get("Cache-Control")}`);
    say(`  Server-Timing          ${res.headers.get("Server-Timing")}`);
    say(`  orphan sweep ran BEFORE the response was sent?   ${purge.mock.calls.length > 0 ? "YES" : "no"}`);
    say(`  sweep handed to after()?                         ${afterCallbacks.length > 0 ? "yes" : "no"}`);
    await drainAfter();
    say(`  after the response, the sweep ran with live houses: [${[...((purge.mock.calls[0]?.[2] as Set<string>) ?? [])].sort().join(", ")}]`);
    say();

    expect(res.status).toBe(200);
    expect(body.rows).toHaveLength(APP_ROWS.length);
    const header = res.headers.get("Server-Timing") ?? "";
    for (const phase of ["auth", "role", "links", "owned", "workspace", "rows", "normalize", "total"]) {
      expect(header).toMatch(new RegExp(`(^|, )${phase};dur=\\d`));
    }
    // Names and numbers only: no ids, emails or row content in a header a proxy may log.
    expect(header).not.toMatch(/AXIS|mgr-seattle|seattle-homes|@/);
  });

  it("never sweeps in a View-as session, and skips the sweep when the co-manager lookup fails", async () => {
    VIEW_AS_OPEN = true;
    const viewAs = await get();
    await drainAfter();
    say("A View-as session (read-only) making the same read:");
    say(`  status ${viewAs.status} · scheduled sweeps ${afterCallbacks.length} · deletions attempted ${purge.mock.calls.length}`);
    expect(viewAs.status).toBe(200);
    expect(purge).not.toHaveBeenCalled();

    vi.clearAllMocks();
    afterCallbacks.length = 0;
    VIEW_AS_OPEN = false;
    LINK_LOOKUP_FAILS = true;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const failed = await get();
    await drainAfter();
    say("The co-manager link lookup failing (a lookup that did not answer, not an empty portfolio):");
    say(`  status ${failed.status} · deletions attempted ${purge.mock.calls.length} — a failed scope lookup deletes nothing`);
    say();
    expect(failed.status).toBe(200);
    expect(purge).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("warns once, with phases only, when a request crosses 3s", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await get();
    const quiet = warn.mock.calls.length;
    const now = vi.spyOn(performance, "now");
    let t = 0;
    now.mockImplementation(() => (t += 2000));
    await get();
    const line = warn.mock.calls.map((c) => String(c[0])).find((l) => l.includes("manager-applications"));
    say("Slow-read warning (server log, emitted only past 3s):");
    say(`  a fast read logged nothing: ${quiet === 0 ? "confirmed" : `${quiet} line(s)`}`);
    say(`  a slow read logged: ${line}`);
    now.mockRestore();
    warn.mockRestore();
    expect(quiet).toBe(0);
    expect(line).toBeTruthy();
    expect(line).not.toMatch(/AXIS|@/);
  });
});
