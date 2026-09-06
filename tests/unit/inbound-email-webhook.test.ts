import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyResendWebhookSignature } from "@/lib/inbound-email/verify-signature";
import {
  backfillInboundEmailBody,
  buildInboundEmailInboxRow,
  ingestInboundEmail,
  inboundEmailThreadId,
  parseEmailAddress,
  parseInboundEmailWebhook,
  htmlToText,
  INBOUND_EMAIL_BODY_PLACEHOLDER,
  type ParsedInboundEmail,
} from "@/lib/inbound-email/inbound-email.server";
import { ADMIN_INBOX_SCOPE } from "@/lib/portal-inbox-thread-scope";

// whsec_ + base64 body — the shape Resend/Svix issues.
const SECRET = `whsec_${Buffer.from("inbound-email-test-signing-key").toString("base64")}`;

function svixSign(rawBody: string, secret: string, id: string, timestamp: number): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const sig = createHmac("sha256", key).update(`${id}.${timestamp}.${rawBody}`, "utf8").digest("base64");
  return `v1,${sig}`;
}

const RECEIVED_PAYLOAD = {
  type: "email.received",
  created_at: "2026-07-23T10:00:00.000Z",
  data: {
    email_id: "56761188-7520-42d8-8898-ff6fc54ce618",
    created_at: "2026-07-23T10:00:00.000Z",
    from: "Jane Prospect <jane@example.com>",
    to: ["support@prop-lane.space"],
    subject: "Question about a listing",
    text: "Hi, is the downtown unit still available?",
  },
};

describe("verifyResendWebhookSignature", () => {
  const now = 1_770_000_000; // fixed seconds

  it("accepts a correctly signed payload", () => {
    const body = JSON.stringify(RECEIVED_PAYLOAD);
    const id = "msg_1";
    expect(
      verifyResendWebhookSignature({
        rawBody: body,
        headers: { id, timestamp: String(now), signature: svixSign(body, SECRET, id, now) },
        secret: SECRET,
        nowSeconds: now,
      }),
    ).toBe(true);
  });

  it("accepts when one of several signature entries matches", () => {
    const body = JSON.stringify(RECEIVED_PAYLOAD);
    const id = "msg_1";
    const good = svixSign(body, SECRET, id, now);
    const header = `v1,AAAAdeadbeef ${good}`;
    expect(
      verifyResendWebhookSignature({
        rawBody: body,
        headers: { id, timestamp: String(now), signature: header },
        secret: SECRET,
        nowSeconds: now,
      }),
    ).toBe(true);
  });

  it("rejects a tampered body", () => {
    const id = "msg_1";
    const signature = svixSign("{}", SECRET, id, now);
    expect(
      verifyResendWebhookSignature({
        rawBody: JSON.stringify(RECEIVED_PAYLOAD),
        headers: { id, timestamp: String(now), signature },
        secret: SECRET,
        nowSeconds: now,
      }),
    ).toBe(false);
  });

  it("rejects the wrong secret", () => {
    const body = JSON.stringify(RECEIVED_PAYLOAD);
    const id = "msg_1";
    const signature = svixSign(body, `whsec_${Buffer.from("other").toString("base64")}`, id, now);
    expect(
      verifyResendWebhookSignature({
        rawBody: body,
        headers: { id, timestamp: String(now), signature },
        secret: SECRET,
        nowSeconds: now,
      }),
    ).toBe(false);
  });

  it("rejects a stale timestamp (replay guard)", () => {
    const body = JSON.stringify(RECEIVED_PAYLOAD);
    const id = "msg_1";
    const signature = svixSign(body, SECRET, id, now);
    expect(
      verifyResendWebhookSignature({
        rawBody: body,
        headers: { id, timestamp: String(now), signature },
        secret: SECRET,
        nowSeconds: now + 3600,
      }),
    ).toBe(false);
  });

  it("rejects missing headers", () => {
    expect(
      verifyResendWebhookSignature({
        rawBody: "{}",
        headers: { id: null, timestamp: null, signature: null },
        secret: SECRET,
      }),
    ).toBe(false);
  });
});

describe("parseInboundEmailWebhook", () => {
  it("parses a valid email.received event", () => {
    const parsed = parseInboundEmailWebhook(RECEIVED_PAYLOAD);
    expect(parsed).toMatchObject({
      emailId: "56761188-7520-42d8-8898-ff6fc54ce618",
      fromEmail: "jane@example.com",
      fromName: "Jane Prospect",
      toEmails: ["support@prop-lane.space"],
      subject: "Question about a listing",
    });
  });

  it("returns null for non-received event types", () => {
    expect(parseInboundEmailWebhook({ type: "email.delivered", data: {} })).toBeNull();
  });

  it("returns null when required fields are missing", () => {
    expect(parseInboundEmailWebhook({ type: "email.received", data: { subject: "x" } })).toBeNull();
    expect(parseInboundEmailWebhook("nonsense")).toBeNull();
    expect(parseInboundEmailWebhook(null)).toBeNull();
  });

  it("parseEmailAddress handles bare and angled forms", () => {
    expect(parseEmailAddress("Acme <hi@acme.com>")).toEqual({ name: "Acme", email: "hi@acme.com" });
    expect(parseEmailAddress("HI@ACME.COM")).toEqual({ name: "", email: "hi@acme.com" });
  });

  it("htmlToText strips markup but keeps line breaks", () => {
    expect(htmlToText("<p>Hello</p><p>World</p><script>bad()</script>")).toBe("Hello\nWorld");
  });

  it("htmlToText decodes each entity exactly once", () => {
    // &amp;lt; is a literally escaped "&lt;" — decoding &amp; first would
    // double-decode it into "<" and corrupt quoted markup.
    expect(htmlToText("<p>&amp;lt;div&amp;gt; &amp; &lt;b&gt;</p>")).toBe("&lt;div&gt; & <b>");
  });
});

describe("buildInboundEmailInboxRow", () => {
  it("builds an admin-scoped row keyed off the provider id", () => {
    const parsed = parseInboundEmailWebhook(RECEIVED_PAYLOAD)!;
    const row = buildInboundEmailInboxRow({ parsed, bodyText: "hello" });
    expect(row.id).toBe(inboundEmailThreadId(parsed.emailId));
    expect(row.scope).toBe(ADMIN_INBOX_SCOPE); // pins to "admin" — catches drift
    expect(row.participantEmail).toBe("jane@example.com");
    expect(row.folder).toBe("inbox");
    expect(row.senderRole).toBe("partner");
    expect(row.read).toBe(false);
  });
});

type StoredRow = Record<string, unknown>;

/**
 * Fake of the Supabase query builder used by ingest + backfill. Backs a real row
 * map so the unique-violation and "only overwrite the placeholder" paths are
 * exercised rather than stubbed.
 */
function fakeDb(opts: { insertError?: { code?: string; message: string } } = {}) {
  const rows = new Map<string, StoredRow>();
  const inserts: Array<{ record: StoredRow }> = [];
  const updates: Array<{ patch: StoredRow; filters: Array<[string, unknown]> }> = [];

  function table() {
    return {
      insert: async (record: StoredRow) => {
        inserts.push({ record });
        if (opts.insertError) return { error: opts.insertError };
        const id = String(record.id);
        if (rows.has(id)) return { error: { code: "23505", message: "duplicate key value" } };
        rows.set(id, record);
        return { error: null };
      },
      select() {
        let id = "";
        const chain = {
          eq(column: string, value: unknown) {
            if (column === "id") id = String(value);
            return chain;
          },
          maybeSingle: async () => ({ data: rows.get(id) ?? null, error: null }),
        };
        return chain;
      },
      update(patch: StoredRow) {
        const filters: Array<[string, unknown]> = [];
        const run = async () => {
          updates.push({ patch, filters });
          const id = String(filters.find(([column]) => column === "id")?.[1] ?? "");
          const existing = rows.get(id);
          if (!existing) return { error: null };
          const guard = filters.find(([column]) => column === "row_data->>body");
          const storedBody = (existing.row_data as StoredRow | undefined)?.body;
          if (guard && storedBody !== guard[1]) return { error: null };
          rows.set(id, { ...existing, ...patch });
          return { error: null };
        };
        const chain = {
          eq(column: string, value: unknown) {
            filters.push([column, value]);
            return chain;
          },
          then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
            run().then(resolve, reject),
        };
        return chain;
      },
    };
  }

  return { rows, inserts, updates, from: table };
}

const PARSED: ParsedInboundEmail = {
  emailId: "abc-123",
  fromEmail: "jane@example.com",
  fromName: "Jane Prospect",
  toEmails: ["support@prop-lane.space"],
  subject: "Hello",
  receivedAt: "2026-07-23T10:00:00.000Z",
  text: "inline body so no network fetch is attempted",
};

/** Metadata-only delivery — the shape Resend actually sends. */
const PARSED_NO_BODY: ParsedInboundEmail = { ...PARSED, text: undefined, html: undefined };

function storedRowData(db: ReturnType<typeof fakeDb>, emailId: string): StoredRow {
  return (db.rows.get(inboundEmailThreadId(emailId))!.row_data as StoredRow) ?? {};
}

describe("ingestInboundEmail", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("creates an admin-scope, owner-agnostic inbox thread for a new email", async () => {
    const db = fakeDb();
    const result = await ingestInboundEmail(PARSED, db as never);
    expect(result.created).toBe(true);
    expect(db.inserts).toHaveLength(1);
    const record = db.inserts[0]!.record;
    expect(record.id).toBe(inboundEmailThreadId("abc-123"));
    expect(record.scope).toBe(ADMIN_INBOX_SCOPE);
    expect(record.owner_user_id).toBeNull(); // admin scope is owner-agnostic
    expect(record.participant_email).toBe("jane@example.com");
  });

  it("writes the row from metadata alone, never waiting on the body", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const db = fakeDb();
    const result = await ingestInboundEmail(PARSED_NO_BODY, db as never);
    expect(result.created).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(storedRowData(db, "abc-123").body).toBe(INBOUND_EMAIL_BODY_PLACEHOLDER);
    expect(storedRowData(db, "abc-123").topic).toBe("Hello");
  });

  it("is idempotent — a unique violation from re-delivery is a no-op, not a throw", async () => {
    const db = fakeDb();
    expect((await ingestInboundEmail(PARSED, db as never)).created).toBe(true);
    expect((await ingestInboundEmail(PARSED, db as never)).created).toBe(false);
    expect(db.rows.size).toBe(1);
  });

  it("throws on any other database error so the route can 5xx and force a retry", async () => {
    const db = fakeDb({ insertError: { code: "08006", message: "connection failure" } });
    await expect(ingestInboundEmail(PARSED, db as never)).rejects.toThrow("connection failure");
  });

  it("does not treat a non-23505 error as already-ingested even if it mentions duplicates", async () => {
    const db = fakeDb({ insertError: { code: "42501", message: "row already exists in another schema" } });
    await expect(ingestInboundEmail(PARSED, db as never)).rejects.toThrow("row already exists");
  });
});

describe("backfillInboundEmailBody", () => {
  const ENV_KEY = "RESEND_API_KEY";
  let previousKey: string | undefined;

  function mockBodyFetch(body: string | null) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      body === null
        ? new Response("nope", { status: 502 })
        : Response.json({ data: { text: body } }),
    );
  }

  beforeEach(() => {
    previousKey = process.env[ENV_KEY];
    process.env[ENV_KEY] = "re_test_key";
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    if (previousKey === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = previousKey;
    vi.restoreAllMocks();
  });

  it("backfills the real body over the placeholder", async () => {
    const db = fakeDb();
    await ingestInboundEmail(PARSED_NO_BODY, db as never);
    mockBodyFetch("The actual support question");

    const result = await backfillInboundEmailBody(PARSED_NO_BODY, db as never);
    expect(result.updated).toBe(true);
    expect(storedRowData(db, "abc-123").body).toBe("The actual support question");
  });

  it("rides out a transient blip within one pass — no redelivery needed", async () => {
    const db = fakeDb();
    await ingestInboundEmail(PARSED_NO_BODY, db as never);

    let call = 0;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      call += 1;
      return call < 3 ? new Response("nope", { status: 502 }) : Response.json({ data: { text: "healed" } });
    });

    expect((await backfillInboundEmailBody(PARSED_NO_BODY, db as never)).updated).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(storedRowData(db, "abc-123").body).toBe("healed");
  });

  it("leaves the placeholder in place once the bounded retry is exhausted", async () => {
    const db = fakeDb();
    await ingestInboundEmail(PARSED_NO_BODY, db as never);

    const fetchSpy = mockBodyFetch(null);
    expect((await backfillInboundEmailBody(PARSED_NO_BODY, db as never)).updated).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(3); // bounded, not indefinite
    expect(storedRowData(db, "abc-123").body).toBe(INBOUND_EMAIL_BODY_PLACEHOLDER);
  });

  it("does not retry — or sleep — for an email that genuinely has no body", async () => {
    const db = fakeDb();
    await ingestInboundEmail(PARSED_NO_BODY, db as never);

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => Response.json({ data: { text: "", html: "" } }));
    const started = performance.now();
    expect((await backfillInboundEmailBody(PARSED_NO_BODY, db as never)).updated).toBe(false);
    expect(fetchSpy).toHaveBeenCalledOnce(); // an empty body will not change on a retry
    expect(performance.now() - started).toBeLessThan(400); // no backoff sleeps
    expect(storedRowData(db, "abc-123").body).toBe(INBOUND_EMAIL_BODY_PLACEHOLDER);
  });

  it("issues no request — and no sleep — when RESEND_API_KEY is unset", async () => {
    delete process.env[ENV_KEY];
    const db = fakeDb();
    await ingestInboundEmail(PARSED_NO_BODY, db as never);

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const started = performance.now();
    expect((await backfillInboundEmailBody(PARSED_NO_BODY, db as never)).updated).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(performance.now() - started).toBeLessThan(400);
  });

  it("re-reads the row after the lookup, so state that changed mid-fetch survives", async () => {
    const db = fakeDb();
    await ingestInboundEmail(PARSED_NO_BODY, db as never);
    const id = inboundEmailThreadId("abc-123");

    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      // The admin opens and answers the thread while the lookup is in flight —
      // the body is still the placeholder, so the UPDATE's guard alone would
      // happily write this state back out.
      const stored = db.rows.get(id)!;
      db.rows.set(id, {
        ...stored,
        row_data: { ...(stored.row_data as StoredRow), read: true, thread: [{ from: "admin", body: "on it" }] },
      });
      return Response.json({ data: { text: "the real body" } });
    });

    expect((await backfillInboundEmailBody(PARSED_NO_BODY, db as never)).updated).toBe(true);
    const rowData = storedRowData(db, "abc-123");
    expect(rowData.body).toBe("the real body");
    expect(rowData.read).toBe(true);
    expect(rowData.thread).toHaveLength(1);
  });

  it("never clobbers a body that already landed, nor the admin's read/thread state", async () => {
    const db = fakeDb();
    await ingestInboundEmail(PARSED_NO_BODY, db as never);
    mockBodyFetch("first body");
    await backfillInboundEmailBody(PARSED_NO_BODY, db as never);

    // The admin reads and replies in-app.
    const id = inboundEmailThreadId("abc-123");
    const stored = db.rows.get(id)!;
    db.rows.set(id, {
      ...stored,
      row_data: { ...(stored.row_data as StoredRow), read: true, thread: [{ from: "admin", body: "on it" }] },
    });

    mockBodyFetch("a later, different body");
    expect((await backfillInboundEmailBody(PARSED_NO_BODY, db as never)).updated).toBe(false);
    const rowData = storedRowData(db, "abc-123");
    expect(rowData.body).toBe("first body");
    expect(rowData.read).toBe(true);
    expect(rowData.thread).toHaveLength(1);
  });

  it("skips the fetch entirely when the webhook already carried the body", async () => {
    const db = fakeDb();
    await ingestInboundEmail(PARSED, db as never);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect((await backfillInboundEmailBody(PARSED, db as never)).updated).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("checks the stored row before spending a Resend round trip on an enriched thread", async () => {
    const db = fakeDb();
    await ingestInboundEmail(PARSED_NO_BODY, db as never);
    const fetchSpy = mockBodyFetch("already here");
    await backfillInboundEmailBody(PARSED_NO_BODY, db as never);

    fetchSpy.mockClear();
    expect((await backfillInboundEmailBody(PARSED_NO_BODY, db as never)).updated).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not fetch for a thread that was never inserted", async () => {
    const db = fakeDb();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect((await backfillInboundEmailBody(PARSED_NO_BODY, db as never)).updated).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("POST /api/webhooks/email/inbound", () => {
  const ENV = ["VERCEL", "RESEND_INBOUND_WEBHOOK_SECRET", "RESEND_REPLY_DOMAIN"] as const;
  const ingestSpy = vi.fn(async () => ({ created: true }));
  const backfillSpy = vi.fn(async () => ({ updated: true }));
  const replyIngestSpy = vi.fn(async () => ({ handled: true, appended: true }));
  const replyBackfillSpy = vi.fn(async () => ({ updated: true }));

  beforeEach(() => {
    for (const k of ENV) delete process.env[k];
    vi.resetModules();
    vi.doUnmock("@/lib/rate-limit");
    ingestSpy.mockClear();
    backfillSpy.mockClear();
    replyIngestSpy.mockClear();
    replyIngestSpy.mockImplementation(async () => ({ handled: true, appended: true }));
    replyBackfillSpy.mockClear();
    vi.doMock("@/lib/inbound-email/inbound-email.server", async () => {
      const actual = await vi.importActual<typeof import("@/lib/inbound-email/inbound-email.server")>(
        "@/lib/inbound-email/inbound-email.server",
      );
      return { ...actual, ingestInboundEmail: ingestSpy, backfillInboundEmailBody: backfillSpy };
    });
    vi.doMock("@/lib/inbound-email/inbound-email-reply.server", () => ({
      ingestInboundEmailReply: replyIngestSpy,
      backfillInboundEmailReplyBody: replyBackfillSpy,
    }));
  });
  afterEach(() => {
    for (const k of ENV) delete process.env[k];
    vi.doUnmock("@/lib/rate-limit");
    vi.restoreAllMocks();
  });

  async function post(body: string, headers: Record<string, string>) {
    const { POST } = await import("@/app/api/webhooks/email/inbound/route");
    return POST(new Request("https://www.prop-lane.space/api/webhooks/email/inbound", { method: "POST", body, headers }));
  }

  it("rejects unsigned requests on Vercel (fail closed)", async () => {
    process.env.VERCEL = "1";
    const res = await post(JSON.stringify(RECEIVED_PAYLOAD), { "Content-Type": "application/json" });
    expect(res.status).toBe(403);
    expect(ingestSpy).not.toHaveBeenCalled();
  });

  it("rejects a bad signature on Vercel", async () => {
    process.env.VERCEL = "1";
    process.env.RESEND_INBOUND_WEBHOOK_SECRET = SECRET;
    const res = await post(JSON.stringify(RECEIVED_PAYLOAD), {
      "Content-Type": "application/json",
      "svix-id": "msg_1",
      "svix-timestamp": String(Math.floor(Date.now() / 1000)),
      "svix-signature": "v1,not-a-real-signature",
    });
    expect(res.status).toBe(403);
    expect(ingestSpy).not.toHaveBeenCalled();
  });

  it("accepts a correctly signed inbound email and ingests it inline", async () => {
    process.env.VERCEL = "1";
    process.env.RESEND_INBOUND_WEBHOOK_SECRET = SECRET;
    const body = JSON.stringify(RECEIVED_PAYLOAD);
    const id = "msg_1";
    const ts = Math.floor(Date.now() / 1000);
    const res = await post(body, {
      "Content-Type": "application/json",
      "svix-id": id,
      "svix-timestamp": String(ts),
      "svix-signature": svixSign(body, SECRET, id, ts),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(ingestSpy).toHaveBeenCalledOnce();
    expect(ingestSpy.mock.calls[0]![0]).toMatchObject({ emailId: RECEIVED_PAYLOAD.data.email_id });
    expect(backfillSpy).toHaveBeenCalledOnce();
  });

  it.each([
    ["global", 0, true, 503],
    ["sender", 1, true, 503],
    ["global", 0, false, 200],
    ["sender", 1, false, 200],
  ] as const)("handles %s limit after %i allowed calls, unavailable=%s, status=%i", async (_, priorAllowed, unavailable, expectedStatus) => {
    const limiter = vi.fn().mockResolvedValue(unavailable ? { ok: false, unavailable: true } : { ok: false });
    if (priorAllowed) limiter.mockResolvedValueOnce({ ok: true });
    vi.doMock("@/lib/rate-limit", () => ({ rateLimit: limiter }));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    process.env.VERCEL = "1";
    process.env.RESEND_INBOUND_WEBHOOK_SECRET = SECRET;
    const body = JSON.stringify(RECEIVED_PAYLOAD);
    const id = "msg_limiter";
    const ts = Math.floor(Date.now() / 1000);

    const res = await post(body, {
      "Content-Type": "application/json",
      "svix-id": id,
      "svix-timestamp": String(ts),
      "svix-signature": svixSign(body, SECRET, id, ts),
    });

    expect(res.status).toBe(expectedStatus);
    expect(limiter).toHaveBeenCalledTimes(priorAllowed + 1);
    expect(ingestSpy).not.toHaveBeenCalled();
    expect(replyIngestSpy).not.toHaveBeenCalled();
    expect(backfillSpy).not.toHaveBeenCalled();
  });

  it("sheds a flood that rotates its From via the coarse instance cap", async () => {
    process.env.VERCEL = "1";
    process.env.RESEND_INBOUND_WEBHOOK_SECRET = SECRET;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const ts = Math.floor(Date.now() / 1000);

    const send = async (n: number) => {
      const body = JSON.stringify({
        ...RECEIVED_PAYLOAD,
        data: { ...RECEIVED_PAYLOAD.data, email_id: `flood-${n}`, from: `sender${n}@example.com` },
      });
      const id = `flood_${n}`;
      return post(body, {
        "Content-Type": "application/json",
        "svix-id": id,
        "svix-timestamp": String(ts),
        "svix-signature": svixSign(body, SECRET, id, ts),
      });
    };

    for (let n = 0; n < 300; n += 1) await send(n);
    expect(ingestSpy).toHaveBeenCalledTimes(300); // per-sender bucket never trips

    const shed = await send(300);
    expect(shed.status).toBe(200); // still 200 — a 5xx would make Resend retry the flood
    expect(await shed.json()).toEqual({ ok: true, rateLimited: "instance" });
    expect(ingestSpy).toHaveBeenCalledTimes(300);
  });

  it("returns 500 when the ingest write fails so Resend retries", async () => {
    process.env.VERCEL = "1";
    process.env.RESEND_INBOUND_WEBHOOK_SECRET = SECRET;
    ingestSpy.mockImplementationOnce(async () => {
      throw new Error("db down");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const body = JSON.stringify(RECEIVED_PAYLOAD);
    const id = "msg_3";
    const ts = Math.floor(Date.now() / 1000);
    const res = await post(body, {
      "Content-Type": "application/json",
      "svix-id": id,
      "svix-timestamp": String(ts),
      "svix-signature": svixSign(body, SECRET, id, ts),
    });
    expect(res.status).toBe(500);
    expect(backfillSpy).not.toHaveBeenCalled();
  });

  async function postSigned(payload: unknown, svixId: string) {
    const body = JSON.stringify(payload);
    const ts = Math.floor(Date.now() / 1000);
    return post(body, {
      "Content-Type": "application/json",
      "svix-id": svixId,
      "svix-timestamp": String(ts),
      "svix-signature": svixSign(body, SECRET, svixId, ts),
    });
  }

  function withReplyAddress(from: string, to: string) {
    return {
      ...RECEIVED_PAYLOAD,
      data: { ...RECEIVED_PAYLOAD.data, from, to: [to] },
    };
  }

  const OWNER_ID = "3f9a1b2c-4d5e-6f70-8192-a3b4c5d6e7f8";

  async function buildTokenFor(from: string): Promise<string> {
    // Real token from the real module — the route's parseReplyAddress is unmocked.
    const { buildReplyAddress } = await import("@/lib/inbound-email/reply-address.server");
    return buildReplyAddress(OWNER_ID, from)!;
  }

  it("routes a verified reply token to the conversation ingest, not the support inbox", async () => {
    process.env.VERCEL = "1";
    process.env.RESEND_INBOUND_WEBHOOK_SECRET = SECRET;
    process.env.RESEND_REPLY_DOMAIN = "in.prop-lane.space";
    const token = await buildTokenFor("jane@example.com");

    const res = await postSigned(withReplyAddress("Jane Prospect <jane@example.com>", token), "msg_r1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, reply: true });
    expect(replyIngestSpy).toHaveBeenCalledOnce();
    expect(replyIngestSpy.mock.calls[0]![1]).toBe(OWNER_ID);
    expect(replyBackfillSpy).toHaveBeenCalledOnce();
    expect(ingestSpy).not.toHaveBeenCalled();
  });

  it("falls back to the support ingest when the From does not match the token's pair", async () => {
    process.env.VERCEL = "1";
    process.env.RESEND_INBOUND_WEBHOOK_SECRET = SECRET;
    process.env.RESEND_REPLY_DOMAIN = "in.prop-lane.space";
    const token = await buildTokenFor("jane@example.com");

    const res = await postSigned(withReplyAddress("Mallory <mallory@example.com>", token), "msg_r2");
    expect(res.status).toBe(200);
    expect(replyIngestSpy).not.toHaveBeenCalled();
    expect(ingestSpy).toHaveBeenCalledOnce();
  });

  it("falls back to the support ingest when the token owner no longer resolves", async () => {
    process.env.VERCEL = "1";
    process.env.RESEND_INBOUND_WEBHOOK_SECRET = SECRET;
    process.env.RESEND_REPLY_DOMAIN = "in.prop-lane.space";
    replyIngestSpy.mockImplementationOnce(async () => ({ handled: false, appended: false }));
    const token = await buildTokenFor("jane@example.com");

    const res = await postSigned(withReplyAddress("jane@example.com", token), "msg_r3");
    expect(res.status).toBe(200);
    expect(replyIngestSpy).toHaveBeenCalledOnce();
    expect(ingestSpy).toHaveBeenCalledOnce(); // support inbox still gets the mail
    expect(replyBackfillSpy).not.toHaveBeenCalled();
  });

  it("returns 500 when the reply ingest write fails so Resend redelivers", async () => {
    process.env.VERCEL = "1";
    process.env.RESEND_INBOUND_WEBHOOK_SECRET = SECRET;
    process.env.RESEND_REPLY_DOMAIN = "in.prop-lane.space";
    replyIngestSpy.mockImplementationOnce(async () => {
      throw new Error("db down");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const token = await buildTokenFor("jane@example.com");

    const res = await postSigned(withReplyAddress("jane@example.com", token), "msg_r4");
    expect(res.status).toBe(500);
    expect(ingestSpy).not.toHaveBeenCalled();
    expect(replyBackfillSpy).not.toHaveBeenCalled();
  });

  it("acks non-received events without ingesting", async () => {
    process.env.VERCEL = "1";
    process.env.RESEND_INBOUND_WEBHOOK_SECRET = SECRET;
    const body = JSON.stringify({ type: "email.delivered", data: {} });
    const id = "msg_2";
    const ts = Math.floor(Date.now() / 1000);
    const res = await post(body, {
      "Content-Type": "application/json",
      "svix-id": id,
      "svix-timestamp": String(ts),
      "svix-signature": svixSign(body, SECRET, id, ts),
    });
    expect(res.status).toBe(200);
    expect(ingestSpy).not.toHaveBeenCalled();
  });
});
