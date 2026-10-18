/* eslint-disable @typescript-eslint/no-explicit-any -- a small in-memory PostgREST stand-in */
import { describe, expect, it, vi } from "vitest";
import type { SharedLineConfig } from "@/lib/one-number/contracts";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/twilio", () => ({ sendSms: vi.fn() }));

import { MOVED_REPLY_WINDOW_MS, isOldNumberOnSharedLine, movedNoticeText, runMovedNoticeQueue, sendMovedAutoReply } from "@/lib/one-number/old-number.server";

const WS = "11111111-1111-4111-8111-111111111111";
const WS_DED = "22222222-2222-4222-8222-222222222222";
const config: SharedLineConfig = { mode: "shared", sharedNumber: "+12065550100", messagingServiceSid: "MGx", pilotWorkspaceIds: [], dedicatedWorkspaceIds: [WS_DED] };
const NOW = new Date("2026-10-20T20:00:00Z"); // 1pm Pacific

// Just the verbs old-number.server.ts uses, on the one table it uses.
function notices(seed: Record<string, unknown>[] = []) {
  const rows = seed.map((r) => ({ ...r }));
  const db = {
    rows,
    from() {
      const filters: Array<(r: any) => boolean> = [];
      let mode: "select" | "insert" | "update" | "delete" = "select";
      let payload: any = null;
      let limitN = Infinity;
      const b: any = {
        insert(p: any) { mode = "insert"; payload = p; return b; },
        update(p: any) { mode = "update"; payload = p; return b; },
        delete() { mode = "delete"; return b; },
        select() { return b; },
        eq(c: string, v: unknown) { filters.push((r) => r[c] === v); return b; },
        lt(c: string, v: string) { filters.push((r) => r[c] != null && String(r[c]) < v); return b; },
        lte(c: string, v: string) { filters.push((r) => r[c] != null && String(r[c]) <= v); return b; },
        order() { return b; },
        limit(n: number) { limitN = n; return b; },
        maybeSingle: async () => { const hit = rows.find((r) => filters.every((f) => f(r))); return { data: hit ? { ...hit } : null, error: null }; },
        then(resolve: any, reject: any) {
          return Promise.resolve().then(() => {
            if (mode === "insert") {
              if (rows.some((r) => r.phone_key === payload.phone_key)) return { data: null, error: { code: "23505" } };
              rows.push({ ...payload });
              return { data: null, error: null };
            }
            const hit = rows.filter((r) => filters.every((f) => f(r))).slice(0, limitN);
            if (mode === "update") { for (const r of hit) Object.assign(r, payload); return { data: hit.map((r) => ({ phone_key: r.phone_key })), error: null }; }
            if (mode === "delete") { for (const r of hit) rows.splice(rows.indexOf(r), 1); return { data: null, error: null }; }
            return { data: hit.map((r) => ({ ...r })), error: null };
          }).then(resolve, reject);
        },
      };
      return b;
    },
  };
  return db;
}

const okSend = () => vi.fn(async () => ({ ok: true as const, sid: "SMx" }));
const args = (send: any, extra: Record<string, unknown> = {}) => ({ config, phoneKey: "2065550142", fromPhone: "+12065550142", workspaceId: WS, messageSid: "SM1", now: NOW, send, ...extra });

describe("which texts count as an old number that moved", () => {
  const owned = (workspaceId: string | null) => ({ workspaceId });
  it("only a non-shared number of a workspace on the shared line, in shared mode", () => {
    expect(isOldNumberOnSharedLine(config, "+12065550111", owned(WS))).toBe(true);
    expect(isOldNumberOnSharedLine(config, "+12065550111", owned(WS_DED))).toBe(false); // dedicated: behaves as today
    expect(isOldNumberOnSharedLine(config, "+12065550100", owned(WS))).toBe(false); // the shared number itself
    expect(isOldNumberOnSharedLine(config, "+12065550111", owned(null))).toBe(false);
    expect(isOldNumberOnSharedLine(config, "+12065550111", null)).toBe(false);
    expect(isOldNumberOnSharedLine({ ...config, mode: "per_workspace" }, "+12065550111", owned(WS))).toBe(false);
    expect(isOldNumberOnSharedLine({ ...config, mode: "shadow" }, "+12065550111", owned(WS))).toBe(false);
    expect(isOldNumberOnSharedLine({ ...config, pilotWorkspaceIds: ["someone-else"] }, "+12065550111", owned(WS))).toBe(false);
  });
  it("the text is one GSM-7 segment naming the shared number", () => {
    const text = movedNoticeText("+12065550100");
    expect(text).toBe("We've moved to (206) 555-0100. Save this number.");
    expect(/^[\x20-\x7e]+$/.test(text)).toBe(true);
  });
});

describe("the once-per-30-days auto-reply", () => {
  it("replies on the first text as a platform send from the shared line, then stays quiet", async () => {
    const db = notices();
    const send = okSend();
    expect(await sendMovedAutoReply(db as any, args(send))).toBe("sent");
    expect(send).toHaveBeenCalledWith(db, expect.objectContaining({ to: "+12065550142", body: "We've moved to (206) 555-0100. Save this number.", inboundReply: true }));
    expect(db.rows).toEqual([expect.objectContaining({ phone_key: "2065550142", source: "auto_reply", status: "sent", workspace_id: WS })]);
    expect(await sendMovedAutoReply(db as any, args(send, { messageSid: "SM2", now: new Date(NOW.getTime() + 86_400_000) }))).toBe("already_told");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("tells the sender again once 30 days have passed", async () => {
    const db = notices([{ phone_key: "2065550142", source: "auto_reply", status: "sent", notified_at: new Date(NOW.getTime() - MOVED_REPLY_WINDOW_MS - 1000).toISOString() }]);
    const send = okSend();
    expect(await sendMovedAutoReply(db as any, args(send))).toBe("sent");
    expect(send).toHaveBeenCalledTimes(1);
    expect(db.rows[0]!.notified_at).toBe(NOW.toISOString());
  });

  it("a queued cutover notice is replaced by the reply (the person is told once, not twice)", async () => {
    const db = notices([{ phone_key: "2065550142", source: "cutover", status: "queued", notified_at: null }]);
    const send = okSend();
    expect(await sendMovedAutoReply(db as any, args(send))).toBe("sent");
    expect(db.rows[0]).toMatchObject({ status: "sent", source: "auto_reply" });
    const queue = await runMovedNoticeQueue(db as any, { now: () => NOW, send, loadConfig: async () => config });
    expect(queue.due).toBe(0);
  });

  it("hands the marker back when the text did not go out, so the next text can try again", async () => {
    const db = notices();
    const failing = vi.fn(async () => ({ ok: false as const, reason: "provider_error" as const }));
    expect(await sendMovedAutoReply(db as any, args(failing))).toBe("send_failed");
    expect(db.rows).toEqual([]);
    const queued = notices([{ phone_key: "2065550142", source: "cutover", status: "queued", notified_at: null, available_at: "2026-10-19T00:00:00Z", message_sid: null }]);
    expect(await sendMovedAutoReply(queued as any, args(failing))).toBe("send_failed");
    expect(queued.rows[0]).toMatchObject({ source: "cutover", status: "queued" });
  });

  it("an opted-out sender keeps the marker (no retry storm)", async () => {
    const db = notices();
    const optedOut = vi.fn(async () => ({ ok: false as const, reason: "opted_out" as const }));
    expect(await sendMovedAutoReply(db as any, args(optedOut))).toBe("send_failed");
    expect(db.rows).toHaveLength(1);
  });

  it("sends nothing when the table is missing (code ahead of the migration)", async () => {
    const send = okSend();
    const missing: any = { from: () => ({ insert: async () => ({ error: { code: "42P01" } }) }) };
    expect(await sendMovedAutoReply(missing, args(send))).toBe("unavailable");
    expect(send).not.toHaveBeenCalled();
  });
});

describe("the cutover notice dispatcher", () => {
  const queued = (phone: string, at = "2026-10-20T10:00:00Z") => ({ phone_key: phone, source: "cutover", status: "queued", available_at: at, notified_at: null });

  it("sends each due notice once, from the shared number, as a platform send", async () => {
    const db = notices([queued("2065550142"), queued("2065550143"), queued("2065550144", "2026-10-21T10:00:00Z")]);
    const send = okSend();
    const out = await runMovedNoticeQueue(db as any, { now: () => NOW, send, loadConfig: async () => config });
    expect(out).toMatchObject({ due: 2, sent: 2, retry: 0 });
    expect(send).toHaveBeenCalledWith(db, expect.objectContaining({ to: "+12065550142", body: "We've moved to (206) 555-0100. Save this number." }));
    expect(db.rows.map((r) => r.status)).toEqual(["sent", "sent", "queued"]);
    const again = await runMovedNoticeQueue(db as any, { now: () => NOW, send, loadConfig: async () => config });
    expect(again.due).toBe(0);
  });

  it("puts a notice back when the provider failed, and leaves everything alone off the shared line or in quiet hours", async () => {
    const db = notices([queued("2065550142")]);
    const failing = vi.fn(async () => ({ ok: false as const, reason: "provider_error" as const }));
    expect(await runMovedNoticeQueue(db as any, { now: () => NOW, send: failing, loadConfig: async () => config })).toMatchObject({ retry: 1 });
    expect(db.rows[0]!.status).toBe("queued");
    const send = okSend();
    expect(await runMovedNoticeQueue(db as any, { now: () => NOW, send, loadConfig: async () => ({ ...config, mode: "per_workspace" }) })).toMatchObject({ skipped: "not_shared_mode" });
    expect(await runMovedNoticeQueue(db as any, { now: () => new Date("2026-10-21T08:00:00Z"), send, loadConfig: async () => config })).toMatchObject({ skipped: "quiet_hours" });
    expect(send).not.toHaveBeenCalled();
  });
});
