/**
 * End-to-end proof of the Free plan's property cap, at the level a client sees.
 *
 * The unit files pin the rules one at a time; this one walks the whole story
 * through the REAL `GET`/`POST /api/property-records` handlers and the REAL
 * plan resolver (`getEffectiveManagerSkuTier` -> `resolveEffectiveManagerSkuTier`),
 * with only the Postgres driver replaced by an in-memory double that answers
 * the same PostgREST calls. Nothing about the cap, the count, the message or
 * the status codes is stubbed.
 *
 * Set `PROPERTY_LIMIT_EVIDENCE_DIR` to also write the request/response
 * transcript to that directory, which is what a reviewer reads.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PRO_MAX_PROPERTIES } from "@/lib/manager-access";
import { jsonRequest, parseJsonResponse } from "../helpers/api-request";

type Row = Record<string, unknown>;

const DB: Record<string, Row[]> = {
  profiles: [],
  manager_purchases: [],
  manager_property_records: [],
  account_link_invites: [],
};

let SESSION: { id: string; email: string } | null = null;

function query(table: string, opts: { count?: string; head?: boolean } = {}) {
  const filters: Array<(r: Row) => boolean> = [];
  const rows = () => (DB[table] ?? []).filter((r) => filters.every((f) => f(r)));
  const api = {
    eq(col: string, val: unknown) {
      filters.push((r) => r[col] === val);
      return api;
    },
    neq(col: string, val: unknown) {
      filters.push((r) => r[col] !== val);
      return api;
    },
    in(col: string, vals: unknown[]) {
      filters.push((r) => vals.includes(r[col]));
      return api;
    },
    ilike(col: string, val: string) {
      const want = String(val).toLowerCase();
      filters.push((r) => String(r[col] ?? "").toLowerCase() === want);
      return api;
    },
    order() {
      return api;
    },
    async maybeSingle() {
      return { data: rows()[0] ?? null, error: null };
    },
    then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
      const found = rows();
      const payload = opts.count
        ? { data: opts.head ? null : found, count: found.length, error: null }
        : { data: found, error: null };
      return Promise.resolve(payload).then(resolve, reject);
    },
  };
  return api;
}

const serviceClient = {
  from(table: string) {
    return {
      select: (_cols: string, opts?: { count?: string; head?: boolean }) => query(table, opts ?? {}),
      async upsert(row: Row) {
        const list = (DB[table] ??= []);
        const idx = list.findIndex((r) => r.id === row.id);
        if (idx >= 0) list[idx] = { ...list[idx], ...row };
        else list.push({ created_at: new Date().toISOString(), ...row });
        return { error: null };
      },
      delete: () => ({
        async eq(col: string, val: unknown) {
          DB[table] = (DB[table] ?? []).filter((r) => r[col] !== val);
          return { error: null };
        },
      }),
    };
  },
};

vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => serviceClient }));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: SESSION }, error: null }) },
  }),
}));
let CALLER_IS_ADMIN = false;
vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: async () => CALLER_IS_ADMIN }));
vi.mock("@/lib/auth/co-manager-access", () => ({
  assertCoManagerModuleAccess: async () => ({ ok: false, error: "Forbidden.", status: 403 }),
}));
vi.mock("@/lib/auth/clear-property-housing-access", () => ({
  clearHousingAccessForDeletedProperty: async () => {},
}));
vi.mock("@/lib/analytics/posthog", () => ({ track: () => {} }));

const lines: string[] = [];
function say(text = "") {
  lines.push(text);
}

function seedManager(id: string, email: string, purchase: Row | null) {
  DB.profiles.push({ id, email });
  if (purchase) DB.manager_purchases.push({ id: `pur-${id}`, user_id: id, email, ...purchase });
}

function listing(id: string, owner: string, name: string, status = "live"): Row {
  return {
    action: "upsert",
    id,
    managerUserId: owner,
    status,
    rowData: { id, name, submittedByUserId: owner },
    propertyData: { id, name, managerUserId: owner },
  };
}

async function post(body: Row) {
  const { POST } = await import("@/app/api/property-records/route");
  const res = await POST(jsonRequest("http://localhost:3000/api/property-records", { method: "POST", body }));
  return parseJsonResponse<Record<string, unknown>>(res);
}

async function get() {
  const { GET } = await import("@/app/api/property-records/route");
  return parseJsonResponse<Record<string, unknown>>(await GET());
}

function record(label: string, req: string, out: { status: number; data: unknown }) {
  say(`  ${label}`);
  say(`    -> ${req}`);
  say(`    <- ${out.status} ${JSON.stringify(out.data)}`);
  say();
}

function liveIdsFor(owner: string) {
  return DB.manager_property_records
    .filter((r) => r.manager_user_id === owner && r.status === "live")
    .map((r) => String(r.id));
}

describe("free plan property limit — end to end over the real route", () => {
  it("refuses a free manager's second listing while keeping every existing record", async () => {
    say("=".repeat(78));
    say("POST/GET /api/property-records — real handlers, real plan resolver");
    say("=".repeat(78));
    say();

    // ---------------------------------------------------------------- free
    const free = "11111111-1111-4111-8111-111111111111";
    // A brand-new manager who signed up and never reached the pricing step:
    // `provisionPendingManagerAccount` inserts a purchase row with tier null.
    // That is the row that used to display "Free" and enforce nothing.
    seedManager(free, "free-manager@example.test", { tier: null, billing: null });

    say("SCENARIO 1 — new manager, manager_purchases.tier = null (never reached pricing)");
    say();
    SESSION = { id: free, email: "free-manager@example.test" };

    const first = await post(listing("mgr-maple-101", free, "Maple St 101"));
    record("publish 1st listing", 'POST {status:"live", id:"mgr-maple-101"}', first);
    expect(first.status).toBe(200);

    const second = await post(listing("mgr-birch-202", free, "Birch Ave 202"));
    record("publish 2nd listing", 'POST {status:"live", id:"mgr-birch-202"}', second);
    expect(second.status).toBe(403);
    expect(second.data.error).toBe("Free includes 1 property. Upgrade to Pro or Business to add more.");
    expect(second.data.code).toBe("property_limit_reached");

    // The body cannot argue its way past it: naming somebody else as the owner
    // is already refused by the route's ownership rule, and re-posting with a
    // fresh id changes nothing.
    const disguised = await post(listing("mgr-cedar-303", free, "Cedar Way 303"));
    record("retry with a different id", 'POST {status:"live", id:"mgr-cedar-303"}', disguised);
    expect(disguised.status).toBe(403);

    const draft = await post(listing("mgr-draft-404", free, "Unfinished draft", "draft"));
    record("save a draft (never a listing slot)", 'POST {status:"draft"}', draft);
    expect(draft.status).toBe(200);

    const edit = await post({
      ...listing("mgr-maple-101", free, "Maple St 101 — renamed"),
    });
    record("edit the listing they already have", 'POST {status:"live", id:"mgr-maple-101"}', edit);
    expect(edit.status).toBe(200);

    const afterFree = await get();
    say("  GET /api/property-records after the refusal");
    say(`    <- ${afterFree.status} listed ids: ${JSON.stringify(liveIdsFor(free))}`);
    say(`       nothing was deleted or hidden; the draft is stored as: ${JSON.stringify(
      DB.manager_property_records.filter((r) => r.manager_user_id === free).map((r) => [r.id, r.status]),
    )}`);
    say();
    expect(afterFree.status).toBe(200);
    expect(liveIdsFor(free)).toEqual(["mgr-maple-101"]);

    // ------------------------------------------------------- over the limit
    const over = "22222222-2222-4222-8222-222222222222";
    seedManager(over, "downgraded@example.test", { tier: "free", billing: "free" });
    for (const [id, name] of [
      ["mgr-oak-1", "Oak 1"],
      ["mgr-oak-2", "Oak 2"],
      ["mgr-oak-3", "Oak 3"],
    ] as const) {
      DB.manager_property_records.push({
        id,
        manager_user_id: over,
        status: "live",
        row_data: { id, name },
        property_data: { id, name },
        created_at: new Date().toISOString(),
      });
    }

    say("SCENARIO 2 — an account ALREADY over the cap (downgraded / seeded / let past)");
    say(`  starts with ${liveIdsFor(over).length} live listings on a Free plan`);
    say();
    SESSION = { id: over, email: "downgraded@example.test" };

    const resave = await post(listing("mgr-oak-2", over, "Oak 2 — price updated"));
    record("re-save one of the existing listings", 'POST {status:"live", id:"mgr-oak-2"}', resave);
    expect(resave.status).toBe(200);

    const unlist = await post(listing("mgr-oak-3", over, "Oak 3", "unlisted"));
    record("unlist one", 'POST {status:"unlisted", id:"mgr-oak-3"}', unlist);
    expect(unlist.status).toBe(200);

    const relist = await post(listing("mgr-oak-3", over, "Oak 3", "live"));
    record("relist it (still over cap → refused, row untouched)", 'POST {status:"live", id:"mgr-oak-3"}', relist);
    expect(relist.status).toBe(403);

    const fourth = await post(listing("mgr-oak-4", over, "Oak 4"));
    record("add a fourth", 'POST {status:"live", id:"mgr-oak-4"}', fourth);
    expect(fourth.status).toBe(403);

    const removed = await post({ action: "delete", id: "mgr-oak-1" });
    record("delete one of their own", 'POST {action:"delete", id:"mgr-oak-1"}', removed);
    expect(removed.status).toBe(200);

    say("  every record still accounted for after all of the above:");
    say(
      `    ${JSON.stringify(
        DB.manager_property_records.filter((r) => r.manager_user_id === over).map((r) => [r.id, r.status]),
      )}`,
    );
    say();
    expect(
      DB.manager_property_records.filter((r) => r.manager_user_id === over).map((r) => r.id).sort(),
    ).toEqual(["mgr-oak-2", "mgr-oak-3"]);

    // ---------------------------------------------------------------- paid
    const pro = "33333333-3333-4333-8333-333333333333";
    seedManager(pro, "pro-manager@example.test", {
      tier: "pro",
      billing: "monthly",
      stripe_subscription_id: "sub_live_123",
    });

    say("SCENARIO 3 — a paying Pro manager is unaffected inside their own cap");
    say();
    SESSION = { id: pro, email: "pro-manager@example.test" };
    for (let n = 1; n <= PRO_MAX_PROPERTIES; n += 1) {
      const res = await post(listing(`mgr-pro-${n}`, pro, `Pro listing ${n}`));
      say(`  publish listing ${n} of ${PRO_MAX_PROPERTIES} -> ${res.status}`);
      expect(res.status).toBe(200);
    }
    const proOverflow = await post(listing("mgr-pro-over", pro, "One past the Pro cap"));
    say(`  publish listing ${PRO_MAX_PROPERTIES + 1} -> ${proOverflow.status} ${JSON.stringify(proOverflow.data)}`);
    say();
    expect(proOverflow.status).toBe(403);
    expect(proOverflow.data.error).toBe(
      `Pro includes up to ${PRO_MAX_PROPERTIES} properties. Upgrade to Business to add more.`,
    );

    // ------------------------------------------- unrecognized tier + Stripe
    const legacy = "44444444-4444-4444-8444-444444444444";
    seedManager(legacy, "legacy-paid@example.test", {
      tier: "enterprise-2019",
      billing: "monthly",
      stripe_subscription_id: "sub_live_legacy",
    });
    say("SCENARIO 4 — unrecognized SKU behind a LIVE Stripe subscription stays uncapped");
    say("  (a billing-sync gap must never cap a paying account)");
    SESSION = { id: legacy, email: "legacy-paid@example.test" };
    for (const n of [1, 2, 3] as const) {
      const res = await post(listing(`mgr-legacy-${n}`, legacy, `Legacy ${n}`));
      say(`  publish listing ${n} -> ${res.status}`);
      expect(res.status).toBe(200);
    }
    say();

    // ------------------------------------------------- admins are not exempt
    const staff = "55555555-5555-4555-8555-555555555555";
    seedManager(staff, "staff@proplane.test", null);
    say("SCENARIO 5 — an ADMIN publishing on a Free manager's behalf spends THAT manager's plan");
    SESSION = { id: staff, email: "staff@proplane.test" };
    CALLER_IS_ADMIN = true;
    const onBehalf = await post(listing("mgr-admin-published", free, "Published by staff"));
    record("admin creates a listing owned by the free manager", 'POST {managerUserId: <free manager>}', onBehalf);
    expect(onBehalf.status).toBe(403);
    expect(onBehalf.data.error).toBe("Free includes 1 property. Upgrade to Pro or Business to add more.");
    CALLER_IS_ADMIN = false;

    say("=".repeat(78));

    const outDir = process.env.PROPERTY_LIMIT_EVIDENCE_DIR;
    if (outDir) {
      mkdirSync(outDir, { recursive: true });
      writeFileSync(path.join(outDir, "property-limit-api-transcript.txt"), `${lines.join("\n")}\n`);
    }
     
    console.log(lines.join("\n"));
  });
});
