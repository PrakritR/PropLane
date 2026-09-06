import test from "node:test";
import assert from "node:assert/strict";
import { installProductionSchema, parseProductionSchemaArgs, reviewedProductionMigrations } from "./production-schema.mjs";

const ref = "qahnczmilgptcedaqype";
const url = `https://${ref}.supabase.co`;
const migrations = reviewedProductionMigrations();
const limiter = "public.rate_limit_buckets";
const aliases = "public.application_document_storage_aliases";
const profiles = ["public.profiles", "public.profile_roles"];
const baseColumns = {
  "public.manager_application_records": { id: "text", manager_user_id: "uuid", resident_email: "text", property_id: "text", assigned_property_id: "text", row_data: "jsonb", created_at: "timestamp with time zone", updated_at: "timestamp with time zone" },
  "public.cosigner_submission_records": { signer_app_id: "text", row_data: "jsonb", updated_at: "timestamp with time zone" },
  "public.screening_orders": { application_id: "text" }, "public.application_fee_waiver_redemptions": { application_id: "text" },
  [limiter]: { bucket_key: "text", request_count: "integer", reset_at: "timestamp with time zone" },
  [aliases]: { source_path: "text", application_id: "text", encrypted_path: "text", created_at: "timestamp with time zone", source_removed_at: "timestamp with time zone" },
};
const mime = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "application/pdf", "application/octet-stream"];

function harness(options = {}) {
  let installed = new Set(options.installed ?? []);
  let history = new Map([...installed].map((version) => {
    const m = migrations.find((item) => item.version === version);
    return [version, { version, name: m.name, statements: [m.sql] }];
  }));
  if (options.historyDrift) history.set(migrations[0].version, { version: migrations[0].version, name: "shared_rate_limits", statements: ["unexpected SQL"] });
  const events = [];
  const logs = [];
  let snapshot;
  let connected = false;
  let committed = false;
  const present = (name) => name === options.missingTable ? false : name === limiter ? installed.has(migrations[0].version) || options.untrackedLimiter : name === aliases ? installed.has(migrations[2].version) : true;
  const connect = async () => {
    connected = true;
    return { async query(sql, params = []) {
      events.push({ sql, params });
      if (sql === "begin" || sql === "begin read only") snapshot = { installed: new Set(installed), history: new Map(history) };
      if (sql === "rollback" && !committed && snapshot) { installed = new Set(snapshot.installed); history = new Map(snapshot.history); }
      if (sql === "commit") { if (options.commitLost) throw new Error("ambiguous commit"); committed = true; }
      if (sql.includes("production-schema:tables")) return { rows: params[0].map((name) => ({ name, present: Boolean(present(name)), relkind: present(name) ? "r" : null, rls: name === options.badRlsTable ? false : true, policy_count: 0 })) };
      if (sql.includes("production-schema:history")) return { rows: [...history.values()] };
      if (sql.includes("production-schema:functions")) return { rows: params[0].map((signature, index) => {
        const m = migrations[index === 0 ? 0 : 4];
        return { signature, present: installed.has(m.version), definer: index === 1, returns: index === 0 ? "boolean" : "void", owner: "postgres",
          body: options.badFunctionBody ? "unreviewed body" : m.sql.split("as $$\n")[1].split("\n$$;")[0], config: ['search_path=""'],
          anon_execute: Boolean(options.badRpcGrant), user_execute: false, server_execute: true };
      }).reverse() };
      if (sql.includes("production-schema:bucket")) return { rows: options.missingBucket ? [] : [{ public: Boolean(options.publicBucket), file_size_limit: installed.has(migrations[1].version) ? 15732736 : 15728640, allowed_mime_types: installed.has(migrations[1].version) ? mime : mime.slice(0,-1) }] };
      if (sql.includes("production-schema:grants")) return { rows: params[0].flatMap((table_name) => ["anon", "authenticated", "service_role"].flatMap((role_name) => params[1].map((privilege) => ({ table_name,role_name,privilege,
        allowed: role_name === "service_role" ? true : profiles.includes(table_name) ?
          ["SELECT", "INSERT", "UPDATE", "DELETE"].includes(privilege) ? !(options.profileAccessChanged && installed.size === 5 && privilege === "SELECT") : !installed.has(migrations[3].version) :
          Boolean(options.badBrowserGrant) || (!installed.has(migrations[3].version) && ![limiter,aliases].includes(table_name)),
      })))) };
      if (sql.includes("production-schema:columns")) return { rows: params[0].flatMap((table_name) => Object.entries(baseColumns[table_name] ?? {}).map(([name,type]) => ({ table_name,name,type: name === options.badColumn ? "integer" : type,required:true }))) };
      if (sql.includes("production-schema:constraints")) return { rows: params[0].flatMap((table_name) => table_name === limiter ? [
        { table_name,kind:"p",columns:["bucket_key"] },
        { table_name,kind:"c",definition:"CHECK ((bucket_key ~ '^[a-f0-9]{64}$'::text))" },
        { table_name,kind:"c",definition:"CHECK ((request_count > 0))" },
      ] : [
        { table_name,kind:"p",columns:["source_path"] }, { table_name,kind:"u",columns:["encrypted_path"] },
        { table_name,kind:"f",columns:["application_id"], referenced_table:"public.manager_application_records", delete_action: options.badForeignKey ? "a" : "c",definition:"FOREIGN KEY (application_id) REFERENCES public.manager_application_records(id) ON DELETE CASCADE" },
        { table_name,kind:"c",definition:"CHECK ((source_path <> encrypted_path))" },
        { table_name,kind:"c",definition:"CHECK (((source_path ~~ 'application/%'::text) AND (source_path !~~ '%.penc'::text)))" },
        { table_name,kind:"c",definition:"CHECK ((encrypted_path ~~ 'application/%.penc'::text))" },
      ]) };
      const migration = migrations.find((item) => item.sql === sql);
      if (migration) {
        if (options.failVersion === migration.version) throw new Error("synthetic migration failure");
        installed.add(migration.version);
      }
      if (sql.startsWith("insert into supabase_migrations")) {
        if (history.has(params[0])) throw new Error("history conflict");
        history.set(params[0], { version:params[0],name:params[1],statements:params[2] });
      }
      return { rows: [] };
    }, async end() { events.push({ sql:"end" }); } };
  };
  return { events,logs, get connected() { return connected; }, get installed() { return [...installed]; },
    run: (apply = false, overrides = {}) => installProductionSchema({ url, config:{}, connect, apply,
      confirmProject: apply ? ref : undefined, log:(line) => logs.push(JSON.parse(line)), ...overrides }) };
}

test("only five pinned migrations and explicit fixed production apply arguments are accepted", () => {
  assert.deepEqual(migrations.map((m) => m.version), ["20260906020000","20260906030000","20260906031000","20260906040000","20260906050000"]);
  assert.deepEqual(parseProductionSchemaArgs([]), { apply:false,confirmProject:undefined });
  assert.equal(parseProductionSchemaArgs(["--apply",`--confirm-project=${ref}`]).apply,true);
  for (const args of [["--apply"],["--apply","--dry-run"],["--apply","--apply"],["--migration=unrelated.sql"],["--confirm-project=emstjswhotsnyksqhqyf"]]) assert.throws(() => parseProductionSchemaArgs(args));
});
test("wrong URL or missing apply confirmation fails before connecting", async () => {
  const h = harness();
  await assert.rejects(h.run(true,{confirmProject:undefined}),/confirmation/);
  await assert.rejects(h.run(false,{url:"https://emstjswhotsnyksqhqyf.supabase.co"}),/production/);
  assert.equal(h.connected,false);
});
test("dry-run inspects only metadata and does not execute migrations, history writes, or quota probes", async () => {
  const h = harness(); const evidence = await h.run();
  assert.equal(evidence.before.pendingMigrations,5); assert.equal(evidence.before.canApply,true);
  assert(h.events.some((e) => e.sql === "begin read only"));
  assert(!h.events.some((e) => migrations.some((m) => m.sql === e.sql) || /^(insert|update|delete|create|alter|revoke|grant|lock)\b/i.test(e.sql)));
  assert(!JSON.stringify(h.logs).includes("statements"));
});
for (const options of [{missingTable:"public.screening_orders"},{missingBucket:true},{badColumn:"resident_email"},{historyDrift:true},{untrackedLimiter:true}]) {
  test(`pre-apply drift/prerequisite rejection ${JSON.stringify(options)}`, async () => {
    const h = harness(options); await assert.rejects(h.run(true),/prerequisites or drift/);
    assert(!h.events.some((e) => migrations.some((m) => m.sql === e.sql) || e.sql === "commit"));
  });
}
test("fresh apply executes exactly five pinned files and records exact SQL in one transaction", async () => {
  const h = harness(); const evidence = await h.run(true);
  assert.equal(evidence.applied,5); assert.equal(evidence.boundariesValid,true);
  assert.equal(h.events.filter((e) => e.sql === "commit").length,1);
  const executed = h.events.filter((e) => migrations.some((m) => m.sql === e.sql));
  assert.deepEqual(executed.map((e) => e.sql),migrations.map((m) => m.sql));
  const history = h.events.filter((e) => e.sql.startsWith("insert into supabase_migrations"));
  assert.deepEqual(history.map((e) => e.params), migrations.map((m) => [m.version,m.name,[m.sql]]));
  assert(history.every((e) => !e.sql.toLowerCase().includes("on conflict")));
  assert(h.events.some((e) => e.sql === "set local role postgres"));
  assert(h.events.some((e) => e.sql.includes("statement_timeout")));
  assert(h.events.some((e) => e.sql.includes("lock_timeout")));
});
test("an exact complete installation is checked without rewriting migrations or history", async () => {
  const h = harness({installed:migrations.map((m) => m.version)}); const evidence = await h.run(true);
  assert.equal(evidence.applied,0);
  assert(!h.events.some((e) => migrations.some((m) => m.sql === e.sql) || e.sql.startsWith("insert into supabase_migrations")));
});
test("partial exact installation applies only the remaining fixed files", async () => {
  const h = harness({installed:[migrations[0].version,migrations[1].version]}); const evidence = await h.run(true);
  assert.equal(evidence.applied,3);
  assert.deepEqual(h.events.filter((e) => migrations.some((m) => m.sql === e.sql)).map((e) => e.sql),migrations.slice(2).map((m) => m.sql));
});
for (const options of [{badBrowserGrant:true},{badRpcGrant:true},{badFunctionBody:true},{publicBucket:true},{badForeignKey:true},{badRlsTable:aliases},{profileAccessChanged:true}]) {
  test(`post-apply verification rolls back every migration ${JSON.stringify(options)}`, async () => {
    const h = harness(options); await assert.rejects(h.run(true),/post-apply verification/);
    assert(!h.events.some((e) => e.sql === "commit")); assert.deepEqual(h.installed,[]);
  });
}
test("late SQL failure rolls back bucket, permissions, objects and history together", async () => {
  const h = harness({failVersion:migrations[4].version}); await assert.rejects(h.run(true),/synthetic migration/);
  assert(!h.events.some((e) => e.sql === "commit")); assert.deepEqual(h.installed,[]);
  assert.equal(h.events.at(-1).sql,"end");
});
test("lost COMMIT acknowledgement produces no success evidence or compensating deletes", async () => {
  const h = harness({commitLost:true}); await assert.rejects(h.run(true),/ambiguous commit/);
  assert.equal(h.logs.length,0);
  assert(!h.events.some((e) => /^delete/i.test(e.sql)));
});
