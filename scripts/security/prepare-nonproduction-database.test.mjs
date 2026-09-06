import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { prepareLimiterDatabase } from "./prepare-nonproduction-database.mjs";

const sql = readFileSync(new URL("../../supabase/migrations/20260906020000_shared_rate_limits.sql", import.meta.url), "utf8");
const ref = "emstjswhotsnyksqhqyf";

function harness({ table = false, fn = false, history = null, badPrivilege = false, failProbe = false } = {}) {
  const events = [];
  const logs = [];
  let connections = 0;
  let completedProbes = 0;
  let consumed = 0;
  const connect = async () => {
    const id = connections++;
    return {
      async query(query, params = []) {
        events.push({ id, query, params, completedProbes });
        if (id > 0) {
          if (query.startsWith("select public.consume_rate_limit")) {
            if (failProbe && id === 1) throw new Error("simulated probe error");
            // Pending siblings must finish even when one caller rejects first.
            await new Promise((done) => setTimeout(done, 2));
            return { rows: [{ allowed: ++consumed <= 3 }] };
          }
          return { rows: [] };
        }
        if (query.startsWith("select\n    to_regclass")) {
          return { rows: [{ table_present: table, function_present: fn, history_table_present: true }] };
        }
        if (query.startsWith("select name, statements")) return { rows: history ? [history] : [] };
        if (query === sql) { table = true; fn = true; return { rows: [] }; }
        if (query.startsWith("insert into supabase_migrations")) {
          history = { name: params[1], statements: params[2] };
          return { rows: [] };
        }
        if (query.startsWith("select relrowsecurity")) return { rows: [{ rls: true, relkind: "r" }] };
        if (query.startsWith("select role_name")) return { rows: ["anon", "authenticated"].flatMap((role_name) =>
          ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"].map((privilege) =>
            ({ role_name, privilege, allowed: badPrivilege && role_name === "anon" && privilege === "UPDATE" }))) };
        if (query.startsWith("select privilege")) return { rows: Array.from({ length: 4 }, () => ({ allowed: true })) };
        if (query.startsWith("select\n    has_function_privilege")) return { rows: [{ anon_execute: false, user_execute: false, server_execute: true }] };
        return { rows: [] };
      },
      async end() { if (id > 0) completedProbes++; },
    };
  };
  return { events, logs, run: (apply) => prepareLimiterDatabase({ ref, apply, config: {}, connect, log: (message) => logs.push(JSON.parse(message)) }) };
}

test("production project is rejected before connecting", async () => {
  let connected = false;
  await assert.rejects(prepareLimiterDatabase({ ref: "qahnczmilgptcedaqype", apply: true,
    config: {}, connect: async () => { connected = true; } }), /Development or staging/);
  assert.equal(connected, false);
});

test("dry-run reports absent objects without executing object privilege queries or writes", async () => {
  const h = harness(); await h.run(false);
  assert.equal(h.logs[0].before.objectStatus, "absent");
  assert.equal(h.logs[0].before.canApply, true);
  assert.equal(h.logs[0].permissions, null);
  assert(h.events.some((e) => e.query === "begin read only"));
  assert(!h.events.some((e) => /^(insert|delete|create)|has_.*privilege/i.test(e.query)));
});

test("dry-run explicitly reports a partial table, apply refuses unknown existing objects", async () => {
  const h = harness({ table: true }); await h.run(false);
  assert.equal(h.logs[0].before.objectStatus, "table_only");
  assert.equal(h.logs[0].before.canApply, false);
  const applying = harness({ table: true });
  await assert.rejects(applying.run(true), /drift review/);
  assert(!applying.events.some((e) => e.query === sql));
});

test("existing signature without migration history is not trusted", async () => {
  const h = harness({ table: true, fn: true });
  await assert.rejects(h.run(true), /drift review/);
  assert(!h.events.some((e) => e.query === sql || e.query === "commit"));
});

test("different statements under the same migration version fail closed", async () => {
  const h = harness({ history: { name: "shared_rate_limits", statements: ["select 1"] } });
  await assert.rejects(h.run(true), /drift review/);
  assert(!h.events.some((e) => e.query === sql));
});

test("exact recorded migration is reapplied without swallowing or rewriting history", async () => {
  const h = harness({ table: true, fn: true, history: { name: "shared_rate_limits", statements: [sql] } });
  await h.run(true);
  assert.equal(h.events.filter((e) => e.query === sql).length, 1);
  assert(!h.events.some((e) => e.query.startsWith("insert into supabase_migrations")));
  assert.equal(h.logs[1].allowed, 3);
  assert.equal(h.logs[1].rejected, 9);
  const probes = h.events.filter((e) => e.query.startsWith("select public.consume_rate_limit"));
  assert.equal(probes.length, 12);
  assert(probes.every((e) => /^1[a-f0-9]{63}$/.test(e.params[0])));
  assert.equal(new Set(probes.map((e) => e.params[0])).size, 1);
  for (let id = 1; id <= 12; id++) {
    assert(h.events.some((e) => e.id === id && e.query.includes("statement_timeout")));
    assert(h.events.some((e) => e.id === id && e.query.includes("lock_timeout")));
  }
  assert.equal(h.events.find((e) => e.query.startsWith("delete from")).completedProbes, 12);
});

test("fresh install records exact SQL and rejects unintended anon UPDATE privileges before commit", async () => {
  const h = harness({ badPrivilege: true });
  await assert.rejects(h.run(true), /permissions/);
  const record = h.events.find((e) => e.query.startsWith("insert into supabase_migrations"));
  assert.deepEqual(record.params, ["20260906020000", "shared_rate_limits", [sql]]);
  assert(!record.query.includes("on conflict"));
  assert(!h.events.some((e) => e.query === "commit"));
});

test("probe failure waits for all other connections before deleting only the test bucket", async () => {
  const h = harness({ failProbe: true });
  await assert.rejects(h.run(true), /Concurrent quota test failed/);
  const cleanup = h.events.find((e) => e.query.startsWith("delete from"));
  assert.equal(cleanup.completedProbes, 12);
  assert.equal(cleanup.query, "delete from public.rate_limit_buckets where bucket_key=$1");
  assert.match(cleanup.params[0], /^1[a-f0-9]{63}$/);
  const cleanupIndex = h.events.indexOf(cleanup);
  assert(h.events.slice(cleanupIndex - 4, cleanupIndex).some((e) => e.query.includes("statement_timeout")));
  assert(h.events.slice(cleanupIndex - 4, cleanupIndex).some((e) => e.query.includes("lock_timeout")));
});
