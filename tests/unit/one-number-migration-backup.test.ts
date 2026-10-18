import { describe, expect, it } from "vitest";
import { run } from "../../scripts/one-number/backup.mjs";
import { DEV_ENV, PROD_ENV, PROD_REF, harness, world } from "./one-number-migration-fixtures";

describe("backup.mjs", () => {
  it("writes one complete file with the rows each later script mutates, and writes nothing to the database", async () => {
    const { db, writes } = world();
    const h = harness();
    let saved: { path: string; value: any } | null = null;
    const code = await run(["--target", "dev"], { env: DEV_ENV, db, log: h.log, now: Date.parse("2026-10-19T12:00:00Z"), writeFile: (path: string, value: any) => { saved = { path, value }; } });
    expect(code).toBe(0);
    expect(writes).toEqual([]);
    expect(saved!.path).toMatch(/one-number-dev-2026-10-19T12-00-00-000Z\.json$/);
    const { meta, tables, unstamped } = saved!.value;
    expect(meta).toMatchObject({ kind: "one-number-backup", target: "dev", complete: true, ref: "emstjswhotsnyksqhqyf" });
    expect(tables.sms_runtime_config).toHaveLength(1);
    expect(tables.manager_sms_numbers).toHaveLength(2);
    expect(tables.sms_projection_conversations[0]).toHaveProperty("legacy_conversation_key");
    expect(tables.sms_projection_conversations[0]).not.toHaveProperty("last_body");
    expect(unstamped.sms_projection_turns.sort()).toEqual(["t1", "t2"]);
    expect(unstamped.sms_inbound_receipts.sort()).toEqual(["SM1", "SM2", "SM3"]);
    expect(meta.counts["sms_outbox.unstamped"]).toBe(3);
  });

  it("pages past the server's row cap", async () => {
    const many = Array.from({ length: 2500 }, (_, i) => ({ id: `t${String(i).padStart(5, "0")}`, owner_manager_user_id: "o", conversation_id: "c", workspace_id: null }));
    const { db } = world({ sms_projection_turns: many }, { maxRows: 1000 });
    let saved: any = null;
    await run(["--target", "dev"], { env: DEV_ENV, db, log: () => {}, writeFile: (_p: string, v: any) => { saved = v; } });
    expect(saved.unstamped.sms_projection_turns).toHaveLength(2500);
  });

  it("notes tables that are not migrated here instead of failing", async () => {
    const { db } = world({}, { missingTables: ["sms_phone_contacts", "platform_service_settings"] });
    let saved: any = null;
    await run(["--target", "dev"], { env: DEV_ENV, db, log: () => {}, writeFile: (_p: string, v: any) => { saved = v; } });
    expect(saved.meta.missingTables).toEqual(expect.arrayContaining(["sms_phone_contacts", "platform_service_settings"]));
    expect(saved.meta.complete).toBe(true);
  });

  it("is a read on production, but still needs --confirm-ref", async () => {
    const { db } = world();
    await expect(run(["--target", "production"], { env: PROD_ENV, db, log: () => {}, writeFile: () => {} })).rejects.toThrow(/confirm-ref/);
    let saved: any = null;
    await run(["--target", "production", "--confirm-ref", PROD_REF], { env: PROD_ENV, db, log: () => {}, writeFile: (_p: string, v: any) => { saved = v; } });
    expect(saved.meta.ref).toBe(PROD_REF);
  });

  it("refuses when the environment points at a different project than --target", async () => {
    const { db } = world();
    await expect(run(["--target", "production", "--confirm-ref", PROD_REF], { env: DEV_ENV, db, log: () => {}, writeFile: () => {} })).rejects.toThrow(/expects project/);
  });
});
