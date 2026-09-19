import { createHash, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { expect, type Page, type Route } from "@playwright/test";

type Row = Record<string, unknown> & { id: string };
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value) ?? "undefined").digest("hex");

/** Own the whole fixture lifetime, including failed setup and partial UI writes. */
export async function withOwnedAdminInbox(page: Page, run: (fixture: {
  targetId: string; controlId: string; targetTopic: string;
  readRows: () => Promise<Row[]>; assertControl: () => Promise<void>;
}) => Promise<void>) {
  const url = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (url.protocol !== "https:" || url.hostname !== "emstjswhotsnyksqhqyf.supabase.co" || url.port || url.username || url.password || !serviceKey) throw new Error("Admin inbox fixture requires the exact dev/test database");
  const db = createClient(url.toString(), serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const marker = `e2e-admin-${randomUUID()}`;
  const targetId = `${marker}-archive`, controlId = `${marker}-control`;
  const targetTopic = `Archive fixture ${randomUUID()}`;
  const originals = new Map<string, Row>([
    [targetId, { id: targetId, scope: "admin", name: "Owned archive fixture", email: `${marker}@example.test`, topic: targetTopic, body: "Owned archive test body", createdAt: new Date().toISOString(), read: false, folder: "inbox", senderRole: "partner", thread: [], testRunId: marker }],
    [controlId, { id: controlId, scope: "admin", name: "Owned control fixture", email: `${marker}-control@example.test`, topic: `Control fixture ${randomUUID()}`, body: "Preserve this control", createdAt: new Date().toISOString(), read: false, folder: "inbox", senderRole: "partner", thread: [], testRunId: marker }],
  ]);
  const readRows = async (): Promise<Row[]> => {
    const response = await page.request.get("/api/portal-inbox-threads?scope=admin");
    expect(response.ok(), "real authenticated admin inbox read succeeds").toBe(true);
    const body = await response.json();
    expect(Array.isArray(body.rows)).toBe(true);
    return body.rows;
  };
  const assertControl = async () => {
    const control = (await readRows()).find(row => row.id === controlId);
    expect(control).toMatchObject(originals.get(controlId)!);
  };
  const baseline = new Map((await readRows()).map(row => [row.id, digest(row)]));
  const violations: string[] = [];
  const pending = new Set<Promise<void>>();
  const validateRow = (row: Row) => {
    const original = originals.get(row?.id);
    if (!original || row.scope !== "admin") throw new Error("Non-fixture or wrong-scope row");
    const mutable = new Set(["read", "folder", "trashedFrom"]);
    const derived = new Set(["readSources", "readSourcesComplete", "ownerUserId", "threadType"]);
    for (const key of Object.keys(original)) if (!mutable.has(key) && digest(row[key]) !== digest(original[key])) throw new Error(`Fixture identity/content changed: ${key}`);
    for (const key of Object.keys(row)) if (!(key in original) && !mutable.has(key) && !derived.has(key)) throw new Error(`Unexpected fixture field: ${key}`);
    if (typeof row.read !== "boolean" || !["inbox", "trash"].includes(String(row.folder)) || (row.trashedFrom !== undefined && row.trashedFrom !== "inbox")) throw new Error("Unexpected fixture mailbox state");
    if ((row.ownerUserId !== undefined && row.ownerUserId !== null) || (row.threadType !== undefined && row.threadType !== null)) throw new Error("Fixture ownership/type changed");
    if (row.id === controlId && (row.read !== false || row.folder !== "inbox" || row.trashedFrom !== undefined)) throw new Error("Control fixture mutation refused");
  };
  const handle = async (route: Route) => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() === "GET" && path === "/api/portal-inbox-threads") {
      const response = await route.fetch();
      if (!response.ok()) throw new Error(`Filtered real inbox read failed: ${response.status()}`);
      const body = await response.json();
      if (!Array.isArray(body.rows)) throw new Error("Malformed real inbox read");
      await route.fulfill({ response, json: { ...body, rows: body.rows.filter((row: Row) => originals.has(row.id)) } });
      return;
    }
    if (["GET", "HEAD", "OPTIONS"].includes(request.method())) { await route.fallback(); return; }
    if (path !== "/api/portal-inbox-threads" || request.method() !== "POST") throw new Error(`Unexpected admin test write: ${request.method()} ${path}`);
    const body = request.postDataJSON();
    if (body?.action === "replace") {
      // Actual route semantics are per-row upserts, not a scope-wide delete.
      if (!Array.isArray(body.rows) || !body.rows.length || body.rows.length > originals.size || new Set(body.rows.map((row: Row) => row.id)).size !== body.rows.length) throw new Error("Invalid fixture replace inventory");
      body.rows.forEach(validateRow);
    } else if (body?.action === "upsert") validateRow(body.row);
    else if (body?.action === "deleteIds") {
      if (!Array.isArray(body.ids) || body.ids.length !== 1 || body.ids[0] !== targetId) throw new Error("Non-target delete refused");
    } else throw new Error("Unexpected inbox mutation action");
    const response = await route.fetch();
    if (!response.ok()) throw new Error(`Real fixture mutation failed: ${response.status()}`);
    await route.fulfill({ response });
  };
  const fence = async (route: Route) => {
    const task = handle(route).catch(async error => {
      violations.push(error instanceof Error ? error.message : String(error));
      await route.abort("blockedbyclient").catch(() => {});
    });
    pending.add(task);
    try { await task; } finally { pending.delete(task); }
  };
  await page.route("**/api/**", fence);
  try {
    await page.goto("about:blank");
    // INSERT is intentional: a collision can never overwrite an existing row.
    const { error } = await db.from("portal_inbox_thread_records").insert([...originals.values()].map(row => ({ id: row.id, scope: "admin", owner_user_id: null, participant_email: row.email, thread_type: null, row_data: row })));
    if (error) throw new Error(`Owned admin fixture insert failed: ${error.message}`);
    for (const original of originals.values()) expect((await readRows()).find(row => row.id === original.id)).toMatchObject(original);
    await run({ targetId, controlId, targetTopic, readRows, assertControl });
    expect(violations).toEqual([]);
  } finally {
    try {
      const cleanupErrors: string[] = [];
      await page.goto("about:blank").catch(() => { cleanupErrors.push("Could not stop admin test document"); });
      await Promise.allSettled([...pending]);
      // Cleanup never depends on the active UI or disables the browser fence.
      const { data: leftovers, error: lookupError } = await db.from("portal_inbox_thread_records").select("id,scope,row_data").in("id", [...originals.keys()]);
      if (lookupError) throw new Error(`Admin fixture cleanup lookup failed: ${lookupError.message}`);
      for (const row of leftovers ?? []) {
        if (row.scope !== "admin" || row.row_data?.testRunId !== marker || !originals.has(row.id)) { cleanupErrors.push("Admin fixture cleanup ownership changed"); continue; }
        const response = await page.request.post("/api/portal-inbox-threads", { data: { action: "deleteIds", ids: [row.id] } }).catch(() => null);
        if (!response?.ok()) {
          // Preserve the failure while removing only our marked test row if auth
          // was lost; no shared admin record can match these predicates.
          const { error } = await db.from("portal_inbox_thread_records").delete().eq("id", row.id).eq("scope", "admin").contains("row_data", { testRunId: marker });
          if (error) cleanupErrors.push(`Admin fixture fallback cleanup failed: ${error.message}`);
          cleanupErrors.push(`Authenticated admin fixture cleanup failed: ${response?.status() ?? "transport"}`);
        }
      }
      const { data: remaining, error: verificationError } = await db.from("portal_inbox_thread_records").select("id").in("id", [...originals.keys()]);
      if (verificationError) throw new Error(`Admin fixture cleanup verification failed: ${verificationError.message}`);
      expect(remaining).toEqual([]);
      const final = new Map((await readRows()).map(row => [row.id, digest(row)]));
      for (const [id, hash] of baseline) expect(final.get(id), `non-fixture admin row ${id} unchanged`).toBe(hash);
      expect(violations).toEqual([]);
      expect(cleanupErrors).toEqual([]);
    } finally {
      await page.unroute("**/api/**", fence);
    }
  }
}
