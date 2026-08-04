/**
 * Reply grants for the emailed-SMS-reply leg. The allowance is a COUNTER
 * because notifications are: two texts from one person send two emails, and
 * answering both is ordinary behaviour that a single-use flag would silently
 * drop on the very leg the product requires to work.
 */
import { describe, expect, it } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";
import {
  SMS_REPLY_GRANT_MAX_ALLOWANCE,
  SMS_REPLY_GRANT_TTL_MS,
  consumeSmsEmailReplyGrant,
  grantSmsEmailReply,
  smsReplyGrantRecordId,
} from "@/lib/inbound-email/sms-reply-grant.server";

const MGR = "mgr-1";
const MGR_EMAIL = "manager@example.com";
const PHONE = "+14255550123";

function seed(rows: Array<Record<string, unknown>> = []) {
  return createMemoryDb({ portal_outbound_mail_records: rows });
}

function grantRowOf(db: unknown): Record<string, unknown> | undefined {
  const tables = (db as { __tables: Record<string, Array<Record<string, unknown>>> }).__tables;
  return tables.portal_outbound_mail_records.find((r) => r.id === smsReplyGrantRecordId(MGR, PHONE));
}

function notify(db: unknown) {
  return grantSmsEmailReply(db as never, {
    managerUserId: MGR,
    counterpartyPhone: PHONE,
    managerEmail: MGR_EMAIL,
  });
}

function consume(db: unknown, nowMs?: number) {
  return consumeSmsEmailReplyGrant(db as never, { managerUserId: MGR, counterpartyPhone: PHONE }, nowMs);
}

describe("sms email-reply grants", () => {
  it("banks one reply per notification, so answering two texts sends twice", async () => {
    const db = seed();
    await notify(db);
    await notify(db);
    expect(await consume(db)).toMatchObject({ ok: true, remaining: 1 });
    expect(await consume(db)).toMatchObject({ ok: true, remaining: 0 });
    expect(await consume(db)).toEqual({ ok: false, reason: "consumed" });
  });

  it("spends exactly one allowance per reply", async () => {
    const db = seed();
    await notify(db);
    expect(await consume(db)).toMatchObject({ ok: true });
    expect(await consume(db)).toEqual({ ok: false, reason: "consumed" });
  });

  it("caps banked replies so an unread backlog is not a licence to text", async () => {
    const db = seed();
    for (let i = 0; i < SMS_REPLY_GRANT_MAX_ALLOWANCE + 4; i += 1) await notify(db);
    expect(grantRowOf(db)?.row_data).toMatchObject({ allowance: SMS_REPLY_GRANT_MAX_ALLOWANCE });
  });

  it("refuses when no notification ever opened a window", async () => {
    expect(await consume(seed())).toEqual({ ok: false, reason: "missing" });
  });

  it("expires stale allowances instead of reviving them on the next notification", async () => {
    const db = seed();
    await notify(db);
    const stale = Date.now() + SMS_REPLY_GRANT_TTL_MS + 1;
    expect(await consume(db, stale)).toEqual({ ok: false, reason: "expired" });

    // A fresh notification starts over at one rather than carrying the expired
    // allowance forward.
    const row = grantRowOf(db)!;
    (row.row_data as Record<string, unknown>).grantedAt = new Date(
      Date.now() - SMS_REPLY_GRANT_TTL_MS - 1,
    ).toISOString();
    (row.row_data as Record<string, unknown>).allowance = 3;
    await notify(db);
    expect(grantRowOf(db)?.row_data).toMatchObject({ allowance: 1 });
  });

  it("fails CLOSED when the row cannot be read — this gate is authorization", async () => {
    const failing = {
      from: () => {
        const chain: Record<string, unknown> = {};
        chain.select = () => chain;
        chain.eq = () => chain;
        chain.is = () => chain;
        chain.update = () => chain;
        chain.maybeSingle = async () => ({ data: null, error: { message: "connection reset" } });
        return chain;
      },
    };
    expect(await consume(failing)).toEqual({ ok: false, reason: "unreadable" });
  });

  it("still BANKS when the row cannot be read — the token is already in the manager's inbox", async () => {
    // The caller only banks after the notification email went out, so refusing
    // to open the window on an infra blip hands the manager an invitation whose
    // reply bounces. Under-banking to one is the acceptable degradation.
    const inserted: Array<Record<string, unknown>> = [];
    const flaky = {
      from: () => {
        const chain: Record<string, unknown> = {};
        chain.select = () => chain;
        chain.eq = () => chain;
        chain.is = () => chain;
        chain.update = () => chain;
        chain.insert = async (row: Record<string, unknown>) => {
          inserted.push(row);
          return { error: null };
        };
        chain.maybeSingle = async () => ({ data: null, error: { message: "connection reset" } });
        return chain;
      },
    };
    expect(await notify(flaky)).toBe(true);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]!.row_data).toMatchObject({ allowance: 1 });
  });

  it("never resurrects an allowance a concurrent reply just spent", async () => {
    // The bank write compare-and-sets on the allowance it READ, so a spend that
    // commits in between makes it lose and re-read instead of overwriting.
    // Without the guard this would write 1 + 1 = 2 and hand back the spent one.
    const db = seed();
    await notify(db);
    const row = grantRowOf(db)!;
    let spendOnce = true;
    const racing = {
      from: (table: string) => {
        const chain = (db as unknown as { from: (t: string) => Record<string, unknown> }).from(table);
        const update = chain.update as (patch: Record<string, unknown>) => Record<string, unknown>;
        chain.update = (patch: Record<string, unknown>) => {
          if (spendOnce) {
            spendOnce = false;
            (row.row_data as Record<string, unknown>).allowance = 0;
          }
          return update.call(chain, patch);
        };
        return chain;
      },
    };
    await notify(racing);
    expect((row.row_data as Record<string, unknown>).allowance).toBe(1);
  });

  it("still spends a row written before the counter existed", async () => {
    const id = smsReplyGrantRecordId(MGR, PHONE)!;
    const db = seed([
      {
        id,
        recipient_email: MGR_EMAIL,
        row_data: { id, kind: "sms_reply_grant", grantedAt: new Date().toISOString(), consumedAt: null },
      },
    ]);
    expect(await consume(db)).toMatchObject({ ok: true });
    expect(await consume(db)).toEqual({ ok: false, reason: "consumed" });
  });
});
