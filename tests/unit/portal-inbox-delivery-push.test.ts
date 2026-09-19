import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/push-notifications.server", () => ({
  sendPushToUser: vi.fn().mockResolvedValue({ sent: 1 }),
}));

import type { SupabaseClient } from "@supabase/supabase-js";
import { deliverPortalInboxMessage } from "@/lib/portal-inbox-delivery";
import { sendPushToUser } from "@/lib/push-notifications.server";

/**
 * Regression: the shared delivery helper must fire a mobile push for inbox
 * recipients, so automated sends (crons, scheduled sends, agent send_message)
 * notify the same way the interactive send route does. Before this, push only
 * fired in the route and every automated caller left residents un-notified.
 */

type StoredRow = Record<string, unknown> & { id: string };

/** Minimal chainable Supabase stand-in covering the admin send + push path. */
function makeFakeDb(seedProfiles: StoredRow[]) {
  const tables: Record<string, StoredRow[]> = {
    profiles: [...seedProfiles],
    portal_inbox_thread_records: [],
    portal_outbound_mail_records: [],
  };

  function makeQuery(table: string) {
    const rows = () => (tables[table] ??= []);
    const eqFilters: [string, unknown][] = [];
    const inFilters: [string, unknown[]][] = [];
    const match = (r: StoredRow) =>
      eqFilters.every(([c, v]) => (r as Record<string, unknown>)[c] === v) &&
      inFilters.every(([c, vals]) => vals.includes((r as Record<string, unknown>)[c]));
    const builder = {
      select() {
        return builder;
      },
      order() {
        return builder;
      },
      limit() {
        return builder;
      },
      eq(col: string, val: unknown) {
        eqFilters.push([col, val]);
        return builder;
      },
      in(col: string, vals: unknown[]) {
        inFilters.push([col, vals]);
        return builder;
      },
      maybeSingle() {
        return Promise.resolve({ data: rows().find(match) ?? null, error: null });
      },
      upsert(row: StoredRow) {
        const idx = rows().findIndex((r) => r.id === row.id);
        if (idx >= 0) rows()[idx] = { ...rows()[idx], ...row };
        else rows().push({ ...row });
        return Promise.resolve({ error: null });
      },
      insert(row: StoredRow) {
        if (rows().some((existing) => existing.id === row.id)) {
          return Promise.resolve({ error: { message: "duplicate key value violates unique constraint" } });
        }
        rows().push({ ...row });
        return Promise.resolve({ error: null });
      },
      then<T>(resolve: (v: { data: StoredRow[]; error: null }) => T) {
        return Promise.resolve({ data: rows().filter(match), error: null }).then(resolve);
      },
    };
    return builder;
  }

  return { from: (table: string) => makeQuery(table) } as unknown as SupabaseClient;
}

const SENDER_ID = "mgr_admin_1";
const SENDER_EMAIL = "manager@axis.test";

const PROFILES: StoredRow[] = [
  { id: SENDER_ID, email: SENDER_EMAIL, role: "admin" },
  { id: "user-res-1", email: "res1@axis.test", role: "resident" },
  { id: "user-res-2", email: "res2@axis.test", role: "resident" },
];

function baseOpts() {
  return {
    senderUserId: SENDER_ID,
    senderEmail: SENDER_EMAIL,
    fromName: "Property manager",
    senderRole: "admin" as const,
    subject: "Rent reminder",
    text: "Your rent is due.",
    deliverToPortalInbox: true,
    deliverViaEmail: false,
  };
}

describe("deliverPortalInboxMessage push notifications", () => {
  beforeEach(() => {
    vi.mocked(sendPushToUser).mockClear();
  });

  it("pushes to a userId recipient with the role's inbox deep link", async () => {
    const db = makeFakeDb(PROFILES);
    await deliverPortalInboxMessage(db, { ...baseOpts(), toUserIds: ["user-res-1"] });

    expect(sendPushToUser).toHaveBeenCalledTimes(1);
    expect(sendPushToUser).toHaveBeenCalledWith("user-res-1", {
      title: "New message from Property manager",
      body: "You have a new message in your PropLane inbox.",
      url: "/resident/communication/active",
    });
  });

  it("back-fills the user id for an email-only recipient, then pushes", async () => {
    const db = makeFakeDb(PROFILES);
    await deliverPortalInboxMessage(db, { ...baseOpts(), toEmails: ["res2@axis.test"] });

    expect(sendPushToUser).toHaveBeenCalledTimes(1);
    expect(sendPushToUser).toHaveBeenCalledWith(
      "user-res-2",
      expect.objectContaining({ url: "/resident/communication/active" }),
    );
  });

  it("does not push when the inbox copy is suppressed", async () => {
    const db = makeFakeDb(PROFILES);
    await deliverPortalInboxMessage(db, {
      ...baseOpts(),
      toEmails: ["res2@axis.test"],
      deliverToPortalInbox: false,
    });

    expect(sendPushToUser).not.toHaveBeenCalled();
  });
});
