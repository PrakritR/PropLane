import { describe, expect, it, vi } from "vitest";
import {
  findPendingVendorInviteByEmail,
  findPendingVendorInviteByToken,
  lookupVendorInviteByEmail,
  provisionVendorAccountByEmail,
  vendorUnlinkedNotice,
} from "@/lib/auth/provision-vendor-account";

/**
 * `vendor_invites` was directly INSERT-able by any authenticated user (the
 * `FOR ALL` policy's `WITH CHECK (manager_user_id = auth.uid())` is satisfied
 * by naming yourself as the manager). Redemption turns an invite into a
 * **pre-confirmed** account on the invite's email, so a forged row meant an
 * account on an email the attacker does not control.
 *
 * The grant is revoked in 20260722123000_lock_role_grant_surface.sql. This
 * covers the second half: the TTL check was `if (invite.expires_at && …)`, so a
 * NULL expiry skipped it entirely. Redemption must fail closed regardless of
 * how a row got there.
 */

function dbWithInvite(invite: Record<string, unknown> | null) {
  const maybeSingle = vi.fn().mockResolvedValue({ data: invite, error: null });
  const eqToken = vi.fn(() => ({ maybeSingle }));
  const eqStatus = vi.fn(() => ({ eq: eqToken }));
  const select = vi.fn(() => ({ eq: eqStatus }));
  return { from: vi.fn(() => ({ select })) } as never;
}

const HOUR = 60 * 60 * 1000;

describe("findPendingVendorInviteByToken — TTL is fail-closed", () => {
  it("rejects an invite with a NULL expiry instead of treating it as eternal", async () => {
    const db = dbWithInvite({ id: "inv-1", vendor_email: "victim@example.com", expires_at: null });
    await expect(findPendingVendorInviteByToken(db, "attacker-chosen")).resolves.toBeNull();
  });

  it("rejects an invite with an unparseable expiry", async () => {
    const db = dbWithInvite({ id: "inv-1", vendor_email: "victim@example.com", expires_at: "not-a-date" });
    await expect(findPendingVendorInviteByToken(db, "attacker-chosen")).resolves.toBeNull();
  });

  it("rejects an expired invite", async () => {
    const db = dbWithInvite({
      id: "inv-1",
      vendor_email: "vendor@example.com",
      expires_at: new Date(Date.now() - HOUR).toISOString(),
    });
    await expect(findPendingVendorInviteByToken(db, "tok")).resolves.toBeNull();
  });

  it("still accepts a genuine, unexpired invite", async () => {
    const db = dbWithInvite({
      id: "inv-1",
      vendor_email: "vendor@example.com",
      expires_at: new Date(Date.now() + HOUR).toISOString(),
    });
    const invite = await findPendingVendorInviteByToken(db, "tok");
    expect(invite).toMatchObject({ id: "inv-1" });
  });

  it("returns null for an unknown token", async () => {
    const db = dbWithInvite(null);
    await expect(findPendingVendorInviteByToken(db, "nope")).resolves.toBeNull();
  });
});

/**
 * The self-serve fallback (`provisionVendorAccountByEmail` with no resolved
 * invite) reaches the same redemption, so expiry — a revocation signal — has to
 * hold identically here. Email ownership is proven on this path, so a stale
 * invite is not escalation, but it must not still link the account to the
 * manager's directory row and scope.
 */
function dbWithEmailInvite(invite: Record<string, unknown> | null) {
  const maybeSingle = vi.fn().mockResolvedValue({ data: invite, error: null });
  const limit = vi.fn(() => ({ maybeSingle }));
  const order = vi.fn(() => ({ limit }));
  const gt = vi.fn(() => ({ order }));
  const eqEmail = vi.fn(() => ({ gt }));
  const eqStatus = vi.fn(() => ({ eq: eqEmail }));
  const select = vi.fn(() => ({ eq: eqStatus }));
  return { db: { from: vi.fn(() => ({ select })) } as never, gt };
}

describe("findPendingVendorInviteByEmail — TTL is fail-closed too", () => {
  it("filters expired rows out in the query rather than redeeming them", async () => {
    const { db, gt } = dbWithEmailInvite(null);
    await findPendingVendorInviteByEmail(db, "vendor@example.com");
    expect(gt).toHaveBeenCalledWith("expires_at", expect.any(String));
  });

  it("rejects an invite with a NULL expiry instead of treating it as eternal", async () => {
    const { db } = dbWithEmailInvite({ id: "inv-1", vendor_email: "victim@example.com", expires_at: null });
    await expect(findPendingVendorInviteByEmail(db, "victim@example.com")).resolves.toBeNull();
  });

  it("rejects an expired invite", async () => {
    const { db } = dbWithEmailInvite({
      id: "inv-1",
      vendor_email: "vendor@example.com",
      expires_at: new Date(Date.now() - HOUR).toISOString(),
    });
    await expect(findPendingVendorInviteByEmail(db, "vendor@example.com")).resolves.toBeNull();
  });

  it("still accepts a genuine, unexpired invite", async () => {
    const { db } = dbWithEmailInvite({
      id: "inv-1",
      vendor_email: "vendor@example.com",
      expires_at: new Date(Date.now() + HOUR).toISOString(),
    });
    await expect(findPendingVendorInviteByEmail(db, "vendor@example.com")).resolves.toMatchObject({ id: "inv-1" });
  });
});

/**
 * Failing closed on the TTL is right; failing SILENTLY is not. Dropping the
 * expired invite left the vendor with an account whose `linkedManagerId` is
 * null, no message explaining why, and a manager who sees nothing to resend.
 * The token path already answers "invalid or has expired"; the email path has
 * to signal it too — without ever redeeming the stale invite.
 */
function dbForEmailLookup(opts: {
  redeemable: Record<string, unknown> | null;
  anyPending: Record<string, unknown> | null;
}) {
  const afterEmail = (row: Record<string, unknown> | null) => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: row, error: null });
    const limit = vi.fn(() => ({ maybeSingle }));
    const order = vi.fn(() => ({ limit }));
    return { order, gt: vi.fn(() => ({ order })) };
  };
  const select = vi.fn((columns: string) => ({
    eq: vi.fn(() => ({
      eq: vi.fn(() => afterEmail(columns.trim() === "id" ? opts.anyPending : opts.redeemable)),
    })),
  }));
  return { from: vi.fn(() => ({ select })) } as never;
}

const UNEXPIRED = {
  id: "inv-1",
  manager_user_id: "mgr-1",
  vendor_email: "vendor@example.com",
  expires_at: new Date(Date.now() + HOUR).toISOString(),
};

describe("lookupVendorInviteByEmail — expired and never-invited are different answers", () => {
  it("reports an expired invite as expired rather than as no invite", async () => {
    const db = dbForEmailLookup({ redeemable: null, anyPending: { id: "inv-1" } });
    await expect(lookupVendorInviteByEmail(db, "vendor@example.com")).resolves.toEqual({ kind: "expired" });
  });

  it("reports a genuine absence as none", async () => {
    const db = dbForEmailLookup({ redeemable: null, anyPending: null });
    await expect(lookupVendorInviteByEmail(db, "vendor@example.com")).resolves.toEqual({ kind: "none" });
  });

  it("returns the redeemable invite without the second query", async () => {
    const db = dbForEmailLookup({ redeemable: UNEXPIRED, anyPending: null });
    await expect(lookupVendorInviteByEmail(db, "vendor@example.com")).resolves.toEqual({
      kind: "redeemable",
      invite: UNEXPIRED,
    });
  });
});

/**
 * Signalling a stale invite must not become a wall. The caller creates the auth
 * user BEFORE provisioning, so failing here deletes the account and — because
 * the stale row stays `pending` — every retry fails identically. Signup
 * succeeds unlinked and reports WHY, so the state self-heals and the vendor is
 * not left guessing. There is more than one way to finish unlinked, so the
 * reason is discriminated rather than a single expiry boolean.
 */
function provisioningDb(opts: {
  anyPending?: Record<string, unknown> | null;
  /** Owner of the invite's `vendor_directory_id` row, when one is named. */
  directoryOwner?: string | null;
} = {}) {
  const writes: { table: string; op: "upsert" | "update" }[] = [];

  const vendorInviteSelect = (columns: string) => {
    const maybeSingle = vi.fn().mockResolvedValue({
      data: columns.trim() === "id" ? (opts.anyPending ?? null) : null,
      error: null,
    });
    const order = vi.fn(() => ({ limit: vi.fn(() => ({ maybeSingle })) }));
    return { eq: vi.fn(() => ({ eq: vi.fn(() => ({ order, gt: vi.fn(() => ({ order })) })) })) };
  };

  const plainSelect = (table: string) => ({
    eq: vi.fn(() => ({
      maybeSingle: vi.fn().mockResolvedValue({
        data:
          table === "manager_vendor_records" && opts.directoryOwner !== undefined
            ? { manager_user_id: opts.directoryOwner }
            : null,
        error: null,
      }),
    })),
  });

  const from = vi.fn((table: string) => ({
    select: vi.fn((columns = "*") =>
      table === "vendor_invites" ? vendorInviteSelect(columns) : plainSelect(table),
    ),
    upsert: vi.fn(async () => {
      writes.push({ table, op: "upsert" });
      return { error: null };
    }),
    update: vi.fn(() => {
      const record = async () => {
        writes.push({ table, op: "update" });
        return { error: null };
      };
      // `eq` returns the terminal itself so a chained compare-and-swap
      // (`.eq("id", …).eq("status", "accepted")`) is modelled, not rejected.
      const terminal: Record<string, unknown> = {
        is: vi.fn(record),
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
          record().then(resolve, reject),
      };
      terminal.eq = vi.fn(() => terminal);
      return { eq: vi.fn(() => terminal) };
    }),
  }));

  const client = {
    from,
    auth: {
      admin: {
        getUserById: vi.fn().mockResolvedValue({ data: { user: { user_metadata: {} } } }),
        updateUserById: vi.fn().mockResolvedValue({ data: null, error: null }),
        listUsers: vi.fn().mockResolvedValue({ data: { users: [] }, error: null }),
      },
    },
  };
  return { db: client as never, writes };
}

const REVOKED_DIRECTORY_INVITE = {
  id: "inv-9",
  manager_user_id: "mgr-1",
  vendor_directory_id: "dir-1",
  vendor_email: "vendor@example.com",
  vendor_name: null,
  expires_at: new Date(Date.now() + HOUR).toISOString(),
};

describe("provisionVendorAccountByEmail — every way of finishing unlinked reports why", () => {
  it("still creates the account, unlinked, when the invite has expired", async () => {
    const { db } = provisioningDb({ anyPending: { id: "inv-1" } });
    await expect(
      provisionVendorAccountByEmail(db, { userId: "user-1", email: "vendor@example.com" }),
    ).resolves.toMatchObject({ ok: true, linkedManagerId: null, unlinkedReason: "invite_expired" });
  });

  it("never redeems the stale invite", async () => {
    const { db, writes } = provisioningDb({ anyPending: { id: "inv-1" } });
    await provisionVendorAccountByEmail(db, { userId: "user-1", email: "vendor@example.com" });
    expect(writes.filter((w) => w.table === "vendor_invites")).toEqual([]);
  });

  it("reports no reason when there was simply never an invite", async () => {
    const { db } = provisioningDb();
    await expect(
      provisionVendorAccountByEmail(db, { userId: "user-1", email: "vendor@example.com" }),
    ).resolves.toMatchObject({ ok: true, linkedManagerId: null, unlinkedReason: null });
  });

  // The other way to end up unlinked: a redeemable invite naming a directory row
  // that no longer belongs to its manager. It used to report nothing at all.
  it("reports a revoked directory row rather than unlinking silently", async () => {
    const { db } = provisioningDb({ directoryOwner: "someone-else" });
    await expect(
      provisionVendorAccountByEmail(db, {
        userId: "user-1",
        email: "vendor@example.com",
        invite: REVOKED_DIRECTORY_INVITE,
      }),
    ).resolves.toMatchObject({ ok: true, linkedManagerId: null, unlinkedReason: "invite_revoked" });
  });

  it("still links when the directory row does belong to the inviting manager", async () => {
    const { db } = provisioningDb({ directoryOwner: "mgr-1" });
    await expect(
      provisionVendorAccountByEmail(db, {
        userId: "user-1",
        email: "vendor@example.com",
        invite: REVOKED_DIRECTORY_INVITE,
      }),
    ).resolves.toMatchObject({ ok: true, linkedManagerId: "mgr-1", unlinkedReason: null });
  });

  it("leaves the explicit-invite paths (token / OAuth) untouched", async () => {
    const { db } = provisioningDb({ anyPending: { id: "inv-1" } });
    const from = (db as unknown as { from: ReturnType<typeof vi.fn> }).from;
    await expect(
      provisionVendorAccountByEmail(db, { userId: "user-1", email: "vendor@example.com", invite: null }),
    ).resolves.toMatchObject({ ok: true, unlinkedReason: null });
    expect(from).not.toHaveBeenCalledWith("vendor_invites");
  });
});

/**
 * The awaiting-confirmation screen says "click the link to finish creating your
 * account", so copy claiming the account already exists contradicts it.
 */
describe("vendorUnlinkedNotice", () => {
  it("says nothing when the vendor was linked", () => {
    expect(vendorUnlinkedNotice(null, { confirmed: true })).toBeNull();
  });

  it("distinguishes an expired invite from a revoked one", () => {
    expect(vendorUnlinkedNotice("invite_expired", { confirmed: true })).toMatch(/expired/i);
    expect(vendorUnlinkedNotice("invite_revoked", { confirmed: true })).toMatch(/no longer valid/i);
  });

  it("always tells the vendor how to recover", () => {
    for (const reason of ["invite_expired", "invite_revoked"] as const) {
      for (const confirmed of [true, false]) {
        expect(vendorUnlinkedNotice(reason, { confirmed })).toMatch(/send a new one/i);
      }
    }
  });

  it("never claims the account is ready on the awaiting-confirmation screen", () => {
    for (const reason of ["invite_expired", "invite_revoked"] as const) {
      expect(vendorUnlinkedNotice(reason, { confirmed: false })).not.toMatch(/account is ready/i);
      expect(vendorUnlinkedNotice(reason, { confirmed: false })).toMatch(/confirm your email/i);
      expect(vendorUnlinkedNotice(reason, { confirmed: true })).toMatch(/account is ready/i);
    }
  });
});
