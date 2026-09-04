import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ParsedInboundEmail } from "@/lib/inbound-email/inbound-email.server";
import { INBOUND_EMAIL_BODY_PLACEHOLDER } from "@/lib/inbound-email/inbound-email.server";

vi.mock("@/lib/push-notifications.server", () => ({
  sendPushToUser: vi.fn(async () => ({ sent: 0, skipped: true })),
}));

import { sendPushToUser } from "@/lib/push-notifications.server";
import {
  backfillInboundEmailReplyBody,
  ingestInboundEmailReply,
  inboundReplyMessageId,
  stripEmailReplyQuote,
} from "@/lib/inbound-email/inbound-email-reply.server";

const MANAGER_SCOPE = "axis_portal_inbox_manager_v1";
const RESIDENT_SCOPE = "axis_portal_inbox_resident_v1";
const OWNER_ID = "3f9a1b2c-4d5e-6f70-8192-a3b4c5d6e7f8";

type StoredRow = Record<string, unknown>;

/**
 * Fake of the two tables the reply path touches. Thread selects replay the
 * eq-chain filters findExistingPortalMessageThread applies (including the
 * JSON-path folder/email pair) against a real row map, so append-vs-create and
 * dedupe are exercised for real.
 */
function fakeDb(profiles: Array<{ id: string; email: string; role: string }>) {
  const threads = new Map<string, StoredRow>();

  function profileTable() {
    const filters: Array<[string, unknown]> = [];
    const chain = {
      select: () => chain,
      eq(column: string, value: unknown) {
        filters.push([column, value]);
        return chain;
      },
      maybeSingle: async () => {
        const row = profiles.find((p) =>
          filters.every(([column, value]) =>
            column === "id" ? p.id === value : column === "email" ? p.email === value : true,
          ),
        );
        return { data: row ?? null, error: null };
      },
    };
    return chain;
  }

  function threadTable() {
    const filters: Array<[string, unknown]> = [];
    const rowsMatching = () =>
      [...threads.values()].filter((row) =>
        filters.every(([column, value]) => {
          const rowData = (row.row_data ?? {}) as StoredRow;
          if (column === "row_data->>folder") return String(rowData.folder ?? "") === value;
          if (column === "row_data->>email") return String(rowData.email ?? "") === value;
          return row[column] === value;
        }),
      );
    const chain = {
      select: () => chain,
      eq(column: string, value: unknown) {
        filters.push([column, value]);
        return chain;
      },
      order: () => chain,
      limit: async () => ({ data: rowsMatching(), error: null }),
      upsert: async (record: StoredRow) => {
        threads.set(String(record.id), record);
        return { error: null };
      },
      update(patch: StoredRow) {
        const updateFilters: Array<[string, unknown]> = [];
        const run = async () => {
          const id = String(updateFilters.find(([c]) => c === "id")?.[1] ?? "");
          const existing = threads.get(id);
          if (existing) threads.set(id, { ...existing, ...patch });
          return { error: null };
        };
        const updateChain = {
          eq(column: string, value: unknown) {
            updateFilters.push([column, value]);
            return updateChain;
          },
          then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
            run().then(resolve, reject),
        };
        return updateChain;
      },
    };
    return chain;
  }

  return {
    threads,
    from: (table: string) => (table === "profiles" ? profileTable() : threadTable()),
  };
}

const PROFILES = [
  { id: OWNER_ID, email: "manager@example.com", role: "manager" },
  { id: "res-user-1", email: "jane@example.com", role: "resident" },
];

const REPLY: ParsedInboundEmail = {
  emailId: "reply-abc-1",
  fromEmail: "jane@example.com",
  fromName: "Jane Resident",
  toEmails: ["reply+token@in.prop-lane.space"],
  subject: "Re: Rent question",
  receivedAt: "2026-07-24T10:00:00.000Z",
  text: "Sounds good, thanks!\n\nOn Jul 23, 2026 PropLane wrote:\n> original message",
};

const REPLY_NO_BODY: ParsedInboundEmail = { ...REPLY, text: undefined, html: undefined };

function threadRows(db: ReturnType<typeof fakeDb>) {
  return [...db.threads.values()].map((row) => ({
    scope: row.scope,
    owner: row.owner_user_id,
    participant: row.participant_email,
    rowData: (row.row_data ?? {}) as StoredRow,
  }));
}

describe("stripEmailReplyQuote", () => {
  it("drops quoted history and the attribution line", () => {
    expect(stripEmailReplyQuote(REPLY.text!)).toBe("Sounds good, thanks!");
  });

  it("drops Outlook-style original-message blocks and > lines", () => {
    const body = "New text\n-----Original Message-----\nFrom: a@b.com\nold";
    expect(stripEmailReplyQuote(body)).toBe("New text");
    expect(stripEmailReplyQuote("keep\n> quoted\nalso keep")).toBe("keep\nalso keep");
  });

  it("keeps the full body when stripping would empty it", () => {
    const onlyQuote = "> everything quoted\n> all of it";
    expect(stripEmailReplyQuote(onlyQuote)).toBe(onlyQuote);
  });
});

describe("ingestInboundEmailReply", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("writes both sides: owner unread inbound copy, replier outbound copy", async () => {
    const db = fakeDb(PROFILES);
    const result = await ingestInboundEmailReply(REPLY, OWNER_ID, db as never);
    expect(result).toMatchObject({ handled: true, appended: true });
    // The appended body is part of the contract (PRP-109): the webhook files a
    // work order from exactly these bytes rather than re-deriving them, so a
    // caller must never have to reach back into `parsed` for them.
    // Quoted history stripped, exactly as the thread copies store it.
    expect(result.body).toBe("Sounds good, thanks!");

    const rows = threadRows(db);
    expect(rows).toHaveLength(2);
    const ownerSide = rows.find((r) => r.scope === MANAGER_SCOPE)!;
    expect(ownerSide.owner).toBe(OWNER_ID);
    expect(ownerSide.participant).toBe("manager@example.com");
    expect(ownerSide.rowData.email).toBe("jane@example.com");
    expect(ownerSide.rowData.unread).toBe(true);
    expect(ownerSide.rowData.body).toBe("Sounds good, thanks!"); // quote stripped
    expect(ownerSide.rowData.rootMessageId).toBe(inboundReplyMessageId("reply-abc-1"));

    const replierSide = rows.find((r) => r.scope === RESIDENT_SCOPE)!;
    expect(replierSide.owner).toBe("res-user-1");
    expect(replierSide.participant).toBe("jane@example.com");
    expect(replierSide.rowData.email).toBe("manager@example.com");
    expect(replierSide.rowData.unread).toBe(false);

    expect(sendPushToUser).toHaveBeenCalledWith(
      OWNER_ID,
      expect.objectContaining({
        title: expect.stringContaining("Jane Resident"),
        // Owner is a manager → manager inbox deep link, not a hardcoded portal.
        url: "/portal/communication/active",
      }),
    );
  });

  it("appends into an existing conversation instead of minting a new row", async () => {
    const db = fakeDb(PROFILES);
    db.threads.set("msg_inbox_seed", {
      id: "msg_inbox_seed",
      scope: MANAGER_SCOPE,
      owner_user_id: OWNER_ID,
      participant_email: "manager@example.com",
      thread_type: "portal_message",
      row_data: {
        id: "msg_inbox_seed",
        folder: "inbox",
        email: "jane@example.com",
        body: "earlier in-portal message",
        messages: [],
      },
    });

    await ingestInboundEmailReply(REPLY, OWNER_ID, db as never);
    const seeded = db.threads.get("msg_inbox_seed")!;
    const messages = ((seeded.row_data as StoredRow).messages ?? []) as Array<StoredRow>;
    expect(messages).toHaveLength(1);
    expect(messages[0]!.id).toBe(inboundReplyMessageId("reply-abc-1"));
    expect(messages[0]!.outbound).toBe(false);
    expect(db.threads.size).toBe(2); // seed + replier side only
  });

  it("is idempotent across redeliveries — no duplicate messages, no second push", async () => {
    const db = fakeDb(PROFILES);
    expect((await ingestInboundEmailReply(REPLY, OWNER_ID, db as never)).appended).toBe(true);
    expect((await ingestInboundEmailReply(REPLY, OWNER_ID, db as never)).appended).toBe(false);

    expect(db.threads.size).toBe(2);
    for (const row of threadRows(db)) {
      expect(((row.rowData.messages ?? []) as unknown[]).length).toBe(0); // still root-only
    }
    expect(sendPushToUser).toHaveBeenCalledTimes(1);
  });

  it("falls back (handled: false) when the token owner has no profile", async () => {
    const db = fakeDb([]);
    expect(await ingestInboundEmailReply(REPLY, OWNER_ID, db as never)).toEqual({
      handled: false,
      appended: false,
      body: "",
    });
    expect(db.threads.size).toBe(0);
  });

  it("stores the placeholder when the webhook was metadata-only", async () => {
    const db = fakeDb(PROFILES);
    await ingestInboundEmailReply(REPLY_NO_BODY, OWNER_ID, db as never);
    for (const row of threadRows(db)) {
      expect(row.rowData.body).toBe(INBOUND_EMAIL_BODY_PLACEHOLDER);
    }
  });
});

describe("backfillInboundEmailReplyBody", () => {
  const ENV_KEY = "RESEND_API_KEY";
  let previousKey: string | undefined;

  beforeEach(() => {
    previousKey = process.env[ENV_KEY];
    process.env[ENV_KEY] = "re_test_key";
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    if (previousKey === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = previousKey;
    vi.restoreAllMocks();
  });

  it("replaces the placeholder in both rows (root and appended message)", async () => {
    const db = fakeDb(PROFILES);
    // Owner side has an existing conversation → reply appends as a message;
    // replier side has none → reply becomes the root body.
    db.threads.set("msg_inbox_seed", {
      id: "msg_inbox_seed",
      scope: MANAGER_SCOPE,
      owner_user_id: OWNER_ID,
      participant_email: "manager@example.com",
      thread_type: "portal_message",
      row_data: { id: "msg_inbox_seed", folder: "inbox", email: "jane@example.com", body: "earlier", messages: [] },
    });
    await ingestInboundEmailReply(REPLY_NO_BODY, OWNER_ID, db as never);

    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ data: { text: "The real reply\n> quoted history" } }),
    );
    const result = await backfillInboundEmailReplyBody(REPLY_NO_BODY, OWNER_ID, db as never);
    expect(result.updated).toBe(true);

    const seeded = db.threads.get("msg_inbox_seed")!;
    const messages = ((seeded.row_data as StoredRow).messages ?? []) as Array<StoredRow>;
    expect(messages[0]!.body).toBe("The real reply");
    const replierSide = threadRows(db).find((r) => r.scope === RESIDENT_SCOPE)!;
    expect(replierSide.rowData.body).toBe("The real reply");
    expect(replierSide.rowData.preview).toBe("The real reply");
  });

  it("never clobbers a body that is no longer the placeholder", async () => {
    const db = fakeDb(PROFILES);
    await ingestInboundEmailReply(REPLY, OWNER_ID, db as never); // inline body, no placeholder

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect((await backfillInboundEmailReplyBody(REPLY, OWNER_ID, db as never)).updated).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled(); // inline body → no lookup at all
  });

  it("leaves rows untouched when the lookup keeps failing", async () => {
    const db = fakeDb(PROFILES);
    await ingestInboundEmailReply(REPLY_NO_BODY, OWNER_ID, db as never);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("nope", { status: 502 }));

    expect((await backfillInboundEmailReplyBody(REPLY_NO_BODY, OWNER_ID, db as never)).updated).toBe(false);
    for (const row of threadRows(db)) {
      expect(row.rowData.body).toBe(INBOUND_EMAIL_BODY_PLACEHOLDER);
    }
  });
});
