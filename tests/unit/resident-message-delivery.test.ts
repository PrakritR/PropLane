import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Every message PropLane sends a resident: portal inbox always, a text where the existing gates allow it, an email
 * only to a real mailbox, and — for a resident with no PropLane account yet — ONE account-setup line at the end.
 * `src/lib/resident-message-delivery.ts` is the one place that decides; the senders below call it.
 */

vi.mock("@/lib/push-notifications.server", () => ({ sendPushToUser: vi.fn().mockResolvedValue({ sent: 0 }) }));
vi.mock("@/lib/manager-outbound-identity.server", () => ({ resolveManagerOutboundFrom: vi.fn().mockResolvedValue(null) }));
const { sendPortalConversationEmails } = vi.hoisted(() => ({
  sendPortalConversationEmails: vi.fn(async (opts: { toEmails: string[]; text: string }) => new Map(opts.toEmails.map((e) => [e, { sent: true, resendId: `r-${e}` }]))),
}));
vi.mock("@/lib/portal-email-send.server", () => ({ sendPortalConversationEmails }));

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ACCOUNT_SETUP_REMINDER_LEAD,
  accountSetupReminderLine,
  hasAccountSetupReminder,
  residentAccountSetupUrl,
  residentEmailDeliverable,
  residentMessageChannels,
  withAccountSetupReminder,
} from "@/lib/resident-message-delivery";
import { hasRealEmailAddress } from "@/lib/recipient-channels";
import { isPlaceholderResidentEmail } from "@/lib/resident-welcome.server";
import { deliverPortalInboxMessage } from "@/lib/portal-inbox-delivery";
import { validateQuickAdd, type QuickAddCatalog } from "@/lib/resident-quick-add/model";

const PLACEHOLDERS = [
  "",
  "   ",
  "maya-chen-ab12cd34@import.proplane.local",
  "deleted-7f3c@deleted.invalid",
  "5b1c0f2e-0000-4000-8000-000000000000@phone.proplane.invalid",
  "lead-1@facebook.proplane.local",
  "seed@axis.local",
  "unkown-email(input)@gmail.com",
  "not-an-email",
];

describe("no email on file = no email", () => {
  it.each(PLACEHOLDERS)("%j is never mailed, by every sender's rule", (email) => {
    expect(residentEmailDeliverable(email)).toBe(false);
    expect(hasRealEmailAddress(email)).toBe(false);
    expect(isPlaceholderResidentEmail(email)).toBe(true);
  });

  it("a real address is mailed", () => {
    expect(residentEmailDeliverable("maya.chen@proton.me")).toBe(true);
    expect(hasRealEmailAddress("maya.chen@proton.me")).toBe(true);
    expect(isPlaceholderResidentEmail("maya.chen@proton.me")).toBe(false);
  });

  it("portal always, email only to a real mailbox, text passed through untouched", () => {
    expect(residentMessageChannels({ email: "", emailWanted: true, smsAllowed: true })).toEqual({ portal: true, email: false, sms: true });
    expect(residentMessageChannels({ email: "x@import.proplane.local", emailWanted: true, smsAllowed: false })).toEqual({ portal: true, email: false, sms: false });
    expect(residentMessageChannels({ email: "maya@proton.me", emailWanted: true, smsAllowed: false })).toEqual({ portal: true, email: true, sms: false });
    expect(residentMessageChannels({ email: "maya@proton.me", emailWanted: false, smsAllowed: true })).toEqual({ portal: true, email: false, sms: true });
  });
});

describe("account-setup reminder", () => {
  const url = residentAccountSetupUrl();

  it("links the open resident sign-up, not the token-only setup page", () => {
    expect(url).toMatch(/^https:\/\/[^/]+\/auth\/create-account\?role=resident$/);
    expect(accountSetupReminderLine()).toBe(`${ACCOUNT_SETUP_REMINDER_LEAD}: ${url}`);
  });

  it("is appended for a resident with no account", () => {
    expect(withAccountSetupReminder("Rent is due Friday.", { hasAccount: false })).toBe(`Rent is due Friday.\n\n${ACCOUNT_SETUP_REMINDER_LEAD}: ${url}`);
  });

  it("is never appended for a resident with an account", () => {
    expect(withAccountSetupReminder("Rent is due Friday.", { hasAccount: true })).toBe("Rent is due Friday.");
  });

  it("is added only once per message, however many senders pass it", () => {
    const once = withAccountSetupReminder("Rent is due Friday.", { hasAccount: false });
    const twice = withAccountSetupReminder(once, { hasAccount: false });
    expect(twice).toBe(once);
    expect(twice.split(ACCOUNT_SETUP_REMINDER_LEAD).length - 1).toBe(1);
  });

  it("leaves a message that is itself the setup invitation alone", () => {
    const invite = "Create your resident portal account here:\nhttps://prop-lane.space/auth/resident-setup?token=abc&proplane_id=PL-1";
    expect(hasAccountSetupReminder(invite)).toBe(true);
    expect(withAccountSetupReminder(invite, { hasAccount: false })).toBe(invite);
    expect(withAccountSetupReminder("", { hasAccount: false })).toBe("");
  });
});

type StoredRow = Record<string, unknown> & { id: string };

/** Minimal chainable Supabase stand-in (same shape as portal-inbox-delivery-push.test.ts). */
function makeFakeDb(seedProfiles: StoredRow[]) {
  const tables: Record<string, StoredRow[]> = { profiles: [...seedProfiles], portal_inbox_thread_records: [], portal_outbound_mail_records: [] };
  function makeQuery(table: string) {
    const rows = () => (tables[table] ??= []);
    const eqFilters: [string, unknown][] = [];
    const inFilters: [string, unknown[]][] = [];
    const match = (r: StoredRow) =>
      eqFilters.every(([c, v]) => (r as Record<string, unknown>)[c] === v) && inFilters.every(([c, vals]) => vals.includes((r as Record<string, unknown>)[c]));
    const builder = {
      select: () => builder,
      order: () => builder,
      limit: () => builder,
      eq(col: string, val: unknown) {
        eqFilters.push([col, val]);
        return builder;
      },
      in(col: string, vals: unknown[]) {
        inFilters.push([col, vals]);
        return builder;
      },
      maybeSingle: () => Promise.resolve({ data: rows().find(match) ?? null, error: null }),
      insert(row: StoredRow) {
        if (rows().some((r) => r.id === row.id)) return Promise.resolve({ error: { code: "23505", message: "duplicate key value violates unique constraint" } });
        rows().push({ ...row });
        return Promise.resolve({ error: null });
      },
      update(patch: Partial<StoredRow>) {
        const conds: [string, unknown][] = [];
        const updater = {
          eq(col: string, val: unknown) {
            conds.push([col, val]);
            return updater;
          },
          select() {
            const hit = rows().filter((r) => conds.every(([c, v]) => (r as unknown as Record<string, unknown>)[c] === v));
            for (const r of hit) Object.assign(r, patch);
            return Promise.resolve({ data: hit.map((r) => ({ id: r.id })), error: null });
          },
        };
        return updater;
      },
      upsert(row: StoredRow) {
        const idx = rows().findIndex((r) => r.id === row.id);
        if (idx >= 0) rows()[idx] = { ...rows()[idx], ...row };
        else rows().push({ ...row });
        return Promise.resolve({ error: null });
      },
      then<T>(resolve: (v: { data: StoredRow[]; error: null }) => T) {
        return Promise.resolve({ data: rows().filter(match), error: null }).then(resolve);
      },
    };
    return builder;
  }
  return { db: { from: (table: string) => makeQuery(table) } as unknown as SupabaseClient, tables };
}

const SENDER_ID = "mgr_admin_1";
const SENDER_EMAIL = "manager@axis.test";
const PROFILES: StoredRow[] = [
  { id: SENDER_ID, email: SENDER_EMAIL, role: "admin" },
  { id: "user-res-1", email: "has-account@proton.me", role: "resident" },
];

function inboxThreadsFor(tables: Record<string, StoredRow[]>, participant: string): string {
  return JSON.stringify(tables.portal_inbox_thread_records.filter((r) => JSON.stringify(r).includes(participant)));
}

describe("deliverPortalInboxMessage: three ways, one setup line", () => {
  beforeEach(() => {
    sendPortalConversationEmails.mockClear();
  });

  const base = {
    senderUserId: SENDER_ID,
    senderEmail: SENDER_EMAIL,
    fromName: "Property manager",
    senderRole: "admin" as const,
    subject: "Rent reminder",
    text: "Your rent is due.",
    deliverToPortalInbox: true,
    deliverViaEmail: true,
  };

  it("writes the portal inbox row for a resident with only a placeholder address, and mails nothing", async () => {
    const { db, tables } = makeFakeDb(PROFILES);
    const result = await deliverPortalInboxMessage(db, { ...base, toEmails: ["maya-chen-ab12cd34@import.proplane.local"] });
    expect(result.ok).toBe(true);
    const threads = inboxThreadsFor(tables, "maya-chen-ab12cd34@import.proplane.local");
    expect(threads).toContain("Your rent is due.");
    expect(sendPortalConversationEmails).not.toHaveBeenCalled();
    if (result.ok) expect(result.emailOutcomes).toEqual([{ recipientEmail: "maya-chen-ab12cd34@import.proplane.local", status: "skipped" }]);
  });

  it("ends the message with the setup line for a resident with no account (inbox and email), once", async () => {
    const { db, tables } = makeFakeDb(PROFILES);
    await deliverPortalInboxMessage(db, { ...base, toEmails: ["no-account@proton.me"] });
    expect(sendPortalConversationEmails).toHaveBeenCalledTimes(1);
    const mailed = sendPortalConversationEmails.mock.calls[0]![0] as { toEmails: string[]; text: string };
    expect(mailed.toEmails).toEqual(["no-account@proton.me"]);
    expect(mailed.text.split(ACCOUNT_SETUP_REMINDER_LEAD).length - 1).toBe(1);
    expect(mailed.text.endsWith(accountSetupReminderLine())).toBe(true);
    expect(inboxThreadsFor(tables, "no-account@proton.me")).toContain(ACCOUNT_SETUP_REMINDER_LEAD);
  });

  it("sends a resident with an account the message as written", async () => {
    const { db, tables } = makeFakeDb(PROFILES);
    await deliverPortalInboxMessage(db, { ...base, toEmails: ["has-account@proton.me"] });
    const mailed = sendPortalConversationEmails.mock.calls[0]![0] as { text: string };
    expect(mailed.text).toBe("Your rent is due.");
    expect(inboxThreadsFor(tables, "has-account@proton.me")).not.toContain(ACCOUNT_SETUP_REMINDER_LEAD);
  });

  it("splits one send: only the account-less recipient's copy carries the line", async () => {
    const { db } = makeFakeDb(PROFILES);
    await deliverPortalInboxMessage(db, { ...base, toEmails: ["has-account@proton.me", "no-account@proton.me"] });
    const calls = sendPortalConversationEmails.mock.calls.map((c) => c[0] as { toEmails: string[]; text: string });
    expect(calls.find((c) => c.toEmails.includes("has-account@proton.me"))?.text).toBe("Your rent is due.");
    expect(calls.find((c) => c.toEmails.includes("no-account@proton.me"))?.text).toContain(ACCOUNT_SETUP_REMINDER_LEAD);
  });

  it("a caller can turn the line off", async () => {
    const { db } = makeFakeDb(PROFILES);
    await deliverPortalInboxMessage(db, { ...base, toEmails: ["no-account@proton.me"], accountSetupReminder: false });
    expect((sendPortalConversationEmails.mock.calls[0]![0] as { text: string }).text).toBe("Your rent is due.");
  });
});

describe("quick add: a resident with only a phone", () => {
  const catalog: QuickAddCatalog = { houses: [{ id: "prop-1", label: "Alder Row", rooms: [] }] } as unknown as QuickAddCatalog;
  const raw = { name: "Maya Chen", email: "", phone: "(206) 555-0142", house: "prop-1", room: "", moveIn: "2026-12-01", leaseEnd: "", rent: "875" };

  it("is valid with a blank email", () => {
    const checked = validateQuickAdd(raw, catalog);
    expect(checked.ok).toBe(true);
    if (checked.ok) expect(checked.value.email).toBe("");
  });

  it("still refuses a malformed email", () => {
    const checked = validateQuickAdd({ ...raw, email: "maya@" }, catalog);
    expect(checked.ok).toBe(false);
  });
});
