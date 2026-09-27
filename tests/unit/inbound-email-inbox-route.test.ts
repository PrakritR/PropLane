/**
 * End-to-end (route level) cover for inbound support email → admin portal inbox.
 *
 * The sibling `inbound-email-webhook.test.ts` exercises the library functions in
 * isolation. This file drives the two REAL route handlers a support email
 * actually travels through, against one shared in-memory
 * `portal_inbox_thread_records` table:
 *
 *   POST /api/webhooks/email/inbound      (Svix-signed Resend `email.received`)
 *     → row stored under scope "admin"
 *     → body backfilled from a stand-in Resend received-email API over real HTTP
 *   GET  /api/portal-inbox-threads?scope=admin   (what the admin inbox fetches)
 *     → the founder/admin sees the support thread
 *
 * It also pins the route-level security posture the lib tests cannot see:
 * unsigned + VERCEL set is a 403, and a re-delivered webhook is an idempotent
 * no-op that does not clobber an admin's read state.
 *
 * Set INBOUND_EMAIL_EVIDENCE_DIR to also dump the request/response transcript,
 * the persisted row and the admin GET payload as JSON for review.
 */
import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

/** Shared store both routes see, exactly as they would share one Postgres table. */
const store = new Map<string, Row>();
const profiles = new Map<string, { email: string; role: string }>();

const FOUNDER_ID = "00000000-0000-4000-8000-000000000001";
const FOUNDER_EMAIL = "founders@axis-seattle-housing.com";

let authUser: { id: string; email: string } | null = { id: FOUNDER_ID, email: FOUNDER_EMAIL };
let adminFlag = true;

/** Minimal PostgREST-shaped fake: enough of the builder for both routes. */
function fakeTable(name: string) {
  const rowsFor = (): Map<string, Row> => (name === "profiles" ? (profiles as never) : store);

  const insert = async (record: Row) => {
    const id = String(record.id);
    if (store.has(id)) return { error: { code: "23505", message: "duplicate key value" } };
    store.set(id, record);
    return { error: null };
  };

  const select = (_columns?: string) => {
    const filters: Array<[string, unknown]> = [];
    /** PostgREST `or=(a.eq.x,b.eq.y)` — the real row-visibility gate. */
    const orClauses: Array<[string, string]> = [];
    /** PostgREST `in=(col,(a,b))` — used by the vendor work-identity lookup. */
    const inClauses: Array<[string, unknown[]]> = [];
    const collect = () => {
      let list = [...rowsFor().entries()].map(([id, value]) =>
        name === "profiles" ? { id, ...(value as Row) } : (value as Row),
      );
      for (const [column, value] of filters) {
        list = list.filter((row) => String((row as Row)[column] ?? "") === String(value));
      }
      for (const [column, values] of inClauses) {
        const wanted = new Set(values.map((v) => String(v)));
        list = list.filter((row) => wanted.has(String((row as Row)[column] ?? "")));
      }
      if (orClauses.length > 0) {
        list = list.filter((row) =>
          orClauses.some(([column, value]) => String((row as Row)[column] ?? "") === value),
        );
      }
      return list;
    };
    const chain: Record<string, unknown> = {
      eq(column: string, value: unknown) {
        filters.push([column, value]);
        return chain;
      },
      in(column: string, values: unknown[]) {
        inClauses.push([column, values]);
        return chain;
      },
      or(expr: string) {
        for (const clause of String(expr).split(",")) {
          const [column, op, ...rest] = clause.split(".");
          if (op !== "eq" || !column) continue;
          orClauses.push([column, rest.join(".")]);
        }
        return chain;
      },
      order() {
        return chain;
      },
      limit() {
        return chain;
      },
      maybeSingle: async () => ({ data: collect()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve({ data: collect(), error: null }).then(resolve, reject),
    };
    return chain;
  };

  const update = (patch: Row) => {
    const filters: Array<[string, unknown]> = [];
    const run = async () => {
      const id = String(filters.find(([c]) => c === "id")?.[1] ?? "");
      const existing = store.get(id);
      if (!existing) return { error: null };
      const guard = filters.find(([c]) => c === "row_data->>body");
      const storedBody = (existing.row_data as Row | undefined)?.body;
      if (guard && storedBody !== guard[1]) return { error: null };
      store.set(id, { ...existing, ...patch });
      return { error: null };
    };
    const chain: Record<string, unknown> = {
      eq(column: string, value: unknown) {
        filters.push([column, value]);
        return chain;
      },
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => run().then(resolve, reject),
    };
    return chain;
  };

  return { insert, select, update };
}

const fakeDb = { from: (table: string) => fakeTable(table) };

vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => fakeDb,
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: authUser } }) },
  }),
}));
vi.mock("@/lib/auth/admin-preview", () => ({
  isAdminUser: async () => adminFlag,
}));

const { POST: inboundWebhookPost } = await import("@/app/api/webhooks/email/inbound/route");
const { GET: inboxThreadsGet } = await import("@/app/api/portal-inbox-threads/route");
const { inboundEmailThreadId, INBOUND_EMAIL_BODY_PLACEHOLDER } = await import(
  "@/lib/inbound-email/inbound-email.server"
);

const SECRET = `whsec_${Buffer.from("inbound-email-route-test-key").toString("base64")}`;
const EMAIL_ID = "56761188-7520-42d8-8898-ff6fc54ce618";

/** Metadata-only `email.received`, the shape Resend actually delivers. */
function receivedPayload(overrides: Record<string, unknown> = {}) {
  return {
    type: "email.received",
    created_at: "2026-07-23T17:41:09.000Z",
    data: {
      email_id: EMAIL_ID,
      created_at: "2026-07-23T17:41:09.000Z",
      from: "Jane Prospect <jane@example.com>",
      to: ["support@proplane.ai"],
      subject: "Question about the Ravenna listing",
      ...overrides,
    },
  };
}

function signedRequest(payload: unknown, opts: { secret?: string; signed?: boolean } = {}) {
  const raw = JSON.stringify(payload);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.signed !== false) {
    const id = "msg_2iVYzSAqYQaSHYc1CFrqzO3vLcT";
    const timestamp = Math.floor(Date.now() / 1000);
    const key = Buffer.from((opts.secret ?? SECRET).replace(/^whsec_/, ""), "base64");
    const sig = createHmac("sha256", key).update(`${id}.${timestamp}.${raw}`, "utf8").digest("base64");
    headers["svix-id"] = id;
    headers["svix-timestamp"] = String(timestamp);
    headers["svix-signature"] = `v1,${sig}`;
  }
  return new Request("https://www.prop-lane.space/api/webhooks/email/inbound", {
    method: "POST",
    headers,
    body: raw,
  });
}

/** Stand-in for Resend's received-email API, reached over real HTTP. */
let resendServer: Server;
let resendRequests: string[] = [];
const RESEND_HTML = "<p>Hi — is the Ravenna unit still available for September?</p><p>Thanks, Jane</p>";

beforeAll(async () => {
  resendServer = createServer((req, res) => {
    resendRequests.push(`${req.method} ${req.url} auth=${req.headers.authorization ?? ""}`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: { id: EMAIL_ID, html: RESEND_HTML } }));
  });
  await new Promise<void>((resolve) => resendServer.listen(0, "127.0.0.1", resolve));
  const port = (resendServer.address() as { port: number }).port;
  process.env.RESEND_INBOUND_API_BASE = `http://127.0.0.1:${port}`;
  process.env.RESEND_API_KEY = "re_test_key";
});

afterAll(async () => {
  await new Promise<void>((resolve) => resendServer.close(() => resolve()));
});

beforeEach(() => {
  store.clear();
  profiles.clear();
  profiles.set(FOUNDER_ID, { email: FOUNDER_EMAIL, role: "admin" });
  resendRequests = [];
  authUser = { id: FOUNDER_ID, email: FOUNDER_EMAIL };
  adminFlag = true;
  process.env.RESEND_INBOUND_WEBHOOK_SECRET = SECRET;
  delete process.env.VERCEL;
});

afterEach(() => {
  delete process.env.VERCEL;
});

async function waitForBody(id: string, timeoutMs = 4_000): Promise<string> {
  const started = Date.now();
  for (;;) {
    const body = String(((store.get(id)?.row_data ?? {}) as Row).body ?? "");
    if (body && body !== INBOUND_EMAIL_BODY_PLACEHOLDER) return body;
    if (Date.now() - started > timeoutMs) return body;
    await new Promise((r) => setTimeout(r, 25));
  }
}

const evidenceDir = process.env.INBOUND_EMAIL_EVIDENCE_DIR;
const transcript: unknown[] = [];
function record(step: string, detail: unknown) {
  if (evidenceDir) transcript.push({ step, ...(detail as object) });
}

afterAll(() => {
  if (!evidenceDir || transcript.length === 0) return;
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(path.join(evidenceDir, "inbound-email-route-transcript.json"), JSON.stringify(transcript, null, 2));
});

describe("inbound support email → admin portal inbox (route level)", () => {
  it("a signed email.received creates an admin-scope thread the founder can read", async () => {
    const payload = receivedPayload();
    const res = await inboundWebhookPost(signedRequest(payload));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true });

    const id = inboundEmailThreadId(EMAIL_ID);
    const stored = store.get(id)!;
    expect(stored).toBeTruthy();
    expect(stored.scope).toBe("admin");
    expect(stored.owner_user_id).toBeNull();
    expect(stored.participant_email).toBe("jane@example.com");

    // Body arrives from the received-email API (metadata-only webhook).
    const body = await waitForBody(id);
    expect(body).toBe("Hi — is the Ravenna unit still available for September?\nThanks, Jane");
    expect(resendRequests.some((r) => r.includes(`/emails/receiving/${EMAIL_ID}`))).toBe(true);

    // …and the admin inbox's own fetch returns it.
    const listRes = await inboxThreadsGet(
      new Request("https://www.prop-lane.space/api/portal-inbox-threads?scope=admin"),
    );
    const listJson = (await listRes.json()) as { rows: Row[] };
    expect(listRes.status).toBe(200);
    const row = listJson.rows.find((r) => r.id === id)!;
    expect(row).toBeTruthy();
    expect(row.topic).toBe("Question about the Ravenna listing");
    expect(row.name).toBe("Jane Prospect");
    expect(row.email).toBe("jane@example.com");
    expect(row.folder).toBe("inbox");
    expect(row.read).toBe(false);
    expect(row.body).toBe(body);

    record("webhook-accepted", { request: payload, status: res.status, response: json });
    record("stored-row", { table: "portal_inbox_thread_records", row: store.get(id) });
    record("resend-body-fetch", { requests: resendRequests });
    record("admin-inbox-get", {
      request: "GET /api/portal-inbox-threads?scope=admin (as founders@axis-seattle-housing.com)",
      status: listRes.status,
      response: listJson,
    });
    if (evidenceDir) {
      mkdirSync(evidenceDir, { recursive: true });
      writeFileSync(
        path.join(evidenceDir, "admin-inbox-threads-response.json"),
        JSON.stringify(listJson, null, 2),
      );
    }
  });

  it("a re-delivered webhook is an idempotent no-op that keeps admin read state", async () => {
    await inboundWebhookPost(signedRequest(receivedPayload()));
    const id = inboundEmailThreadId(EMAIL_ID);
    await waitForBody(id);

    // Admin opens/marks the thread read, as the portal would persist it.
    const current = store.get(id)!;
    store.set(id, { ...current, row_data: { ...(current.row_data as Row), read: true } });

    const res = await inboundWebhookPost(signedRequest(receivedPayload()));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true, idempotent: true });
    expect(store.size).toBe(1);
    expect((store.get(id)!.row_data as Row).read).toBe(true);

    record("redelivery-idempotent", {
      status: res.status,
      response: json,
      threadCount: store.size,
      readStatePreserved: (store.get(id)!.row_data as Row).read,
    });
  });

  it("rejects an unsigned delivery on Vercel and stores nothing", async () => {
    process.env.VERCEL = "1";
    const res = await inboundWebhookPost(signedRequest(receivedPayload(), { signed: false }));
    expect(res.status).toBe(403);
    expect(store.size).toBe(0);

    record("unsigned-on-vercel-rejected", { status: res.status, threadCount: store.size });
  });

  it("rejects a delivery signed with the wrong secret", async () => {
    process.env.VERCEL = "1";
    const wrong = `whsec_${Buffer.from("attacker-key").toString("base64")}`;
    const res = await inboundWebhookPost(signedRequest(receivedPayload(), { secret: wrong }));
    expect(res.status).toBe(403);
    expect(store.size).toBe(0);

    record("wrong-secret-rejected", { status: res.status, threadCount: store.size });
  });

  it("acks and ignores a non-received event without creating a thread", async () => {
    const res = await inboundWebhookPost(signedRequest({ type: "email.delivered", data: { email_id: EMAIL_ID } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: "not-received" });
    expect(store.size).toBe(0);
  });

  it("does not expose the admin support thread to a non-admin user", async () => {
    await inboundWebhookPost(signedRequest(receivedPayload()));
    authUser = { id: "11111111-1111-4111-8111-111111111111", email: "resident@example.com" };
    adminFlag = false;
    profiles.set(authUser.id, { email: authUser.email, role: "resident" });

    const res = await inboxThreadsGet(
      new Request("https://www.prop-lane.space/api/portal-inbox-threads?scope=admin"),
    );
    const json = (await res.json()) as { rows: Row[] };
    expect(json.rows.some((r) => r.id === inboundEmailThreadId(EMAIL_ID))).toBe(false);
  });
});
