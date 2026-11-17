/**
 * Resident Payments showed "No payments yet" over paid charges a manager had keyed (and recorded offline receipts for)
 * against the address on the resident's application: the rows carry no resident id and the sign-in address differs.
 * Ownership is the authenticated subject's bound application, never an address alone.
 */
import { describe, expect, it } from "vitest";
import {
  loadResidentChargeActionBinding,
  loadResidentChargeBinding,
  residentBoundChargeClause,
} from "@/lib/resident-charge-binding.server";

type Row = Record<string, unknown>;
const USER = "11111111-1111-4111-8111-111111111111";
const MANAGER = "22222222-2222-4222-8222-222222222222";

/**
 * `rows` answers the subject read; `sharedRows` (when given) answers the follow-up that looks for the same
 * (manager, address) pair on ANOTHER subject's application.
 */
type AuthUser = { email: string; email_confirmed_at: string | null; app_metadata?: Record<string, unknown> } | Error;
const MAILBOX_USER: AuthUser = { email: "fekadu.b@example.com", email_confirmed_at: "2026-11-01T00:00:00Z" };

function dbWith(rows: Row[] | Error, sharedRows?: Row[] | Error, authUser: AuthUser = MAILBOX_USER) {
  const calls: Array<[string, unknown]> = [];
  const counts = { reads: 0, authReads: 0 };
  let reads = 0;
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: (column: string, value: unknown) => {
      calls.push([column, value]);
      return chain;
    },
    in: () => chain,
    limit: async () => {
      const answer = reads === 0 ? rows : (sharedRows ?? []);
      reads += 1;
      counts.reads = reads;
      return answer instanceof Error ? { data: null, error: { message: answer.message } } : { data: answer, error: null };
    },
  };
  const auth = { admin: { getUserById: async () => {
    counts.authReads += 1;
    return authUser instanceof Error
      ? { data: { user: null }, error: { message: authUser.message } }
      : { data: { user: authUser }, error: null };
  } } };
  return { db: { from: () => chain, auth } as never, calls, counts };
}

describe("loadResidentChargeBinding", () => {
  it("binds on the application's own subject, never on an address", async () => {
    const { db, calls } = dbWith([{ id: "app-fekadu", manager_user_id: MANAGER, resident_email: "Fekadu.B@Example.com " }]);
    const binding = await loadResidentChargeBinding(db, USER);
    expect(calls).toEqual([["row_data->>residentUserId", USER]]);
    expect(binding).toEqual({ applicationIds: ["app-fekadu"], managerEmails: [{ managerUserId: MANAGER, email: "fekadu.b@example.com" }] });
  });

  it("drops the address shape when the same manager has that address on another subject's application", async () => {
    const other = "33333333-3333-4333-8333-333333333333";
    const { db } = dbWith(
      [{ id: "app-fekadu", manager_user_id: MANAGER, resident_email: "house@example.com" }],
      [
        { manager_user_id: MANAGER, resident_email: "house@example.com", subject: USER },
        { manager_user_id: MANAGER, resident_email: "house@example.com", subject: other },
      ],
    );
    // A reused address is never ownership: only the subject's own application id survives.
    expect(await loadResidentChargeBinding(db, USER)).toEqual({ applicationIds: ["app-fekadu"], managerEmails: [] });
  });

  it("keeps the application id when the shared-address check itself fails", async () => {
    const { db } = dbWith(
      [{ id: "app-fekadu", manager_user_id: MANAGER, resident_email: "house@example.com" }],
      new Error("boom"),
    );
    expect(await loadResidentChargeBinding(db, USER)).toEqual({ applicationIds: ["app-fekadu"], managerEmails: [] });
  });

  it("drops an id or address that could break out of a filter value", async () => {
    const { db } = dbWith([
      { id: "a),resident_user_id.is.null,(b", manager_user_id: MANAGER, resident_email: "x@y.com,resident_user_id.is.null" },
      { id: "ok-1", manager_user_id: "not-a-uuid", resident_email: "good@example.com" },
    ]);
    expect(await loadResidentChargeBinding(db, USER)).toEqual({ applicationIds: ["ok-1"], managerEmails: [] });
  });

  it("narrows to nothing when the read fails or there is no subject", async () => {
    expect(await loadResidentChargeBinding(dbWith(new Error("boom")).db, USER)).toEqual({ applicationIds: [], managerEmails: [] });
    expect(await loadResidentChargeBinding(dbWith([]).db, "")).toEqual({ applicationIds: [], managerEmails: [] });
  });
});

describe("residentBoundChargeClause", () => {
  it("is null with nothing bound", () => {
    expect(residentBoundChargeClause({ applicationIds: [], managerEmails: [] })).toBeNull();
  });

  it("only ever claims a row that has no resident id of its own", () => {
    const clause = residentBoundChargeClause({
      applicationIds: ["app-1", "app-2"],
      managerEmails: [{ managerUserId: MANAGER, email: "fekadu@example.com" }],
    });
    expect(clause).toBe(
      `and(resident_user_id.is.null,or(row_data->>applicationId.in.(app-1,app-2),and(manager_user_id.eq.${MANAGER},resident_email.eq.fekadu@example.com)))`,
    );
  });
});

describe("a phone sign-up account's typed address", () => {
  const rows = [{ id: "app-phone", manager_user_id: MANAGER, resident_email: "someone.else@example.com" }];

  it("never binds by address: only the application id the server wrote", async () => {
    for (const user of [
      { email: "4b1c@phone.proplane.invalid", email_confirmed_at: "2026-11-16T00:00:00Z" },
      { email: "real@example.com", email_confirmed_at: null },
      new Error("auth down"),
    ] as AuthUser[]) {
      expect(await loadResidentChargeBinding(dbWith(rows, [], user).db, USER)).toEqual({ applicationIds: ["app-phone"], managerEmails: [] });
    }
  });

  it("keeps the address shape for a confirmed mailbox account", async () => {
    expect((await loadResidentChargeBinding(dbWith(rows).db, USER)).managerEmails).toEqual([
      { managerUserId: MANAGER, email: "someone.else@example.com" },
    ]);
  });

  it("keeps the address shape once that account proves a real mailbox", async () => {
    // `app_metadata.phone_only` is stamped at creation and never cleared, so it is account history. The proof is the
    // mailbox the account signs in with today, which `verifyEmailProof` replaced the placeholder with.
    const proven: AuthUser = {
      email: "real@example.com",
      email_confirmed_at: "2026-11-16T00:00:00Z",
      app_metadata: { phone_only: true },
    };
    expect((await loadResidentChargeBinding(dbWith(rows, [], proven).db, USER)).managerEmails).toEqual([
      { managerUserId: MANAGER, email: "someone.else@example.com" },
    ]);
  });
});

describe("loadResidentChargeActionBinding", () => {
  const rows = [{ id: "app-phone", manager_user_id: MANAGER, resident_email: "someone.else@example.com" }];

  it("is the application ids alone, on ONE read: no mailbox check, no shared-address drop", async () => {
    const { db, calls, counts } = dbWith(rows);
    expect(await loadResidentChargeActionBinding(db, USER)).toEqual({ applicationIds: ["app-phone"], managerEmails: [] });
    expect(calls).toEqual([["row_data->>residentUserId", USER]]);
    expect(counts).toEqual({ reads: 1, authReads: 0 });
  });

  it("narrows to nothing when the read fails or there is no subject", async () => {
    expect(await loadResidentChargeActionBinding(dbWith(new Error("boom")).db, USER)).toEqual({ applicationIds: [], managerEmails: [] });
    expect(await loadResidentChargeActionBinding(dbWith(rows).db, "")).toEqual({ applicationIds: [], managerEmails: [] });
  });
});
