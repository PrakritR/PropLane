import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * `sendBookingResidentInvite` (src/lib/booking-resident-invite.server.ts) is
 * the server half of "Add booking" with a new resident: mint/attach an
 * identity, send the account-setup + move-in link by SMS from the work
 * number, fall back to email, and never duplicate an existing account.
 */

const { ensureResidentSetupTokenForApplication, deliverResidentWelcome, enqueueOwnerSms } = vi.hoisted(() => ({
  ensureResidentSetupTokenForApplication: vi.fn(),
  deliverResidentWelcome: vi.fn(),
  enqueueOwnerSms: vi.fn(),
}));

vi.mock("@/lib/auth/resident-setup-token", () => ({
  ensureResidentSetupTokenForApplication,
}));
vi.mock("@/lib/resident-welcome.server", () => ({
  RESIDENT_WELCOME_EMAIL_RE: /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/,
  deliverResidentWelcome,
}));
vi.mock("@/lib/sms/owner-sms-dispatcher.server", () => ({
  enqueueOwnerSms,
}));

import { sendBookingResidentInvite } from "@/lib/booking-resident-invite.server";

type Row = { id: string; manager_user_id: string; resident_email: string | null; row_data: Record<string, unknown> };

function mockDb(seed: Row[] = []) {
  const rows: Row[] = [...seed];
  const upsertCalls: unknown[] = [];
  const updateCalls: { table: string; payload: unknown; filters: Array<[string, unknown]> }[] = [];

  function applyFilters(source: Row[], filters: Array<[string, unknown]>): Row[] {
    return source.filter((row) => filters.every(([col, val]) => (row as unknown as Record<string, unknown>)[col] === val));
  }

  return {
    from: vi.fn((table: string) => {
      const filters: Array<[string, unknown]> = [];
      const builder = {
        select: vi.fn(() => builder),
        eq: vi.fn((col: string, val: unknown) => {
          filters.push([col, val]);
          return builder;
        }),
        limit: vi.fn(() => {
          const matched = applyFilters(rows, filters);
          return Promise.resolve({ data: matched, error: null });
        }),
        maybeSingle: vi.fn(() => {
          const matched = applyFilters(rows, filters);
          return Promise.resolve({ data: matched[0] ?? null, error: null });
        }),
        upsert: vi.fn((payload: Row & { row_data: Record<string, unknown> }) => {
          upsertCalls.push(payload);
          const existingIndex = rows.findIndex((r) => r.id === payload.id);
          if (existingIndex >= 0) rows[existingIndex] = payload;
          else rows.push(payload);
          return Promise.resolve({ error: null });
        }),
        update: vi.fn((payload: unknown) => {
          const updateBuilder = {
            eq: vi.fn((col: string, val: unknown) => {
              filters.push([col, val]);
              return updateBuilder;
            }),
            then: (resolve: (v: unknown) => unknown) => {
              updateCalls.push({ table, payload, filters: [...filters] });
              const matched = applyFilters(rows, filters);
              for (const row of matched) Object.assign(row, payload as Record<string, unknown>);
              return Promise.resolve({ error: null }).then(resolve);
            },
          };
          return updateBuilder;
        }),
      };
      return builder;
    }),
    _rows: rows,
    _upsertCalls: upsertCalls,
    _updateCalls: updateCalls,
  };
}

const actor = { userId: "mgr-1", email: "manager@test.proplane.local", managerName: "Alex Manager" };

describe("sendBookingResidentInvite", () => {
  beforeEach(() => {
    ensureResidentSetupTokenForApplication.mockReset();
    ensureResidentSetupTokenForApplication.mockResolvedValue({ ok: true, token: "tok-1" });
    deliverResidentWelcome.mockReset();
    deliverResidentWelcome.mockResolvedValue({ ok: true, id: "email-1", skipped: false });
    enqueueOwnerSms.mockReset();
  });

  it("mints a new identity and texts the invite from the work number when a phone is given", async () => {
    enqueueOwnerSms.mockResolvedValue({ ok: true, outboxId: "ob-1", status: "queued", deduplicated: false });
    const db = mockDb();

    const result = await sendBookingResidentInvite(db as never, actor, {
      blockId: "axis_room_block_mgr-1_uid1",
      propertyId: "h1",
      propertyLabel: "4709A 8th Ave NE",
      residentName: "Alex Rivera",
      residentEmail: "alex@example.com",
      residentPhone: "+12065550123",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.channel).toBe("sms");
    expect(result.attachedExisting).toBe(false);
    expect(db._upsertCalls).toHaveLength(1);
    const upserted = db._upsertCalls[0] as { row_data: Record<string, unknown> };
    expect(upserted.row_data.bookingResidency).toBe(true);
    expect(upserted.row_data.manuallyAdded).toBe(true);
    expect(enqueueOwnerSms).toHaveBeenCalledTimes(1);
    const smsArgs = enqueueOwnerSms.mock.calls[0]![0] as { recipientPhone?: string; managerUserId?: string };
    expect(smsArgs.recipientPhone).toBe("+12065550123");
    expect(smsArgs.managerUserId).toBe("mgr-1");
    expect(deliverResidentWelcome).not.toHaveBeenCalled();
  });

  it("falls back to email and says so when there is no usable work number", async () => {
    enqueueOwnerSms.mockResolvedValue({ ok: false, error: "number_not_sendable" });
    const db = mockDb();

    const result = await sendBookingResidentInvite(db as never, actor, {
      blockId: "axis_room_block_mgr-1_uid2",
      propertyId: "h1",
      propertyLabel: "4709A 8th Ave NE",
      residentName: "Alex Rivera",
      residentEmail: "alex@example.com",
      residentPhone: "+12065550123",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.channel).toBe("email");
    expect(result.message).toMatch(/no work number/i);
    expect(deliverResidentWelcome).toHaveBeenCalledTimes(1);
  });

  it("a phone-only new resident still mints a working setup token (synthetic login email)", async () => {
    enqueueOwnerSms.mockResolvedValue({ ok: true, outboxId: "ob-4", status: "queued", deduplicated: false });
    const db = mockDb();

    const result = await sendBookingResidentInvite(db as never, actor, {
      blockId: "axis_room_block_mgr-1_uid6",
      propertyId: "h1",
      propertyLabel: "4709A 8th Ave NE",
      residentName: "Jordan Kim",
      residentEmail: "",
      residentPhone: "+12065550188",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.channel).toBe("sms");
    const upserted = db._upsertCalls[0] as { resident_email?: string; row_data: Record<string, unknown> };
    // `ensureResidentSetupTokenForApplication` (and the setup page itself)
    // hard-require an "@"-shaped email on the row — a phone-only resident
    // gets the same import.proplane.local placeholder family every
    // no-real-inbox resident already uses, never a blank column.
    expect(upserted.resident_email).toMatch(/@import\.proplane\.local$/);
    expect(upserted.row_data.email).toBe(upserted.resident_email);
    // The token mint call must have been reachable at all (never skipped
    // for lack of an "@").
    expect(ensureResidentSetupTokenForApplication).toHaveBeenCalledWith(db, result.axisId, {
      managerUserId: "mgr-1",
    });
  });

  it("sends by email straight away when the resident has no phone", async () => {
    const db = mockDb();
    const result = await sendBookingResidentInvite(db as never, actor, {
      blockId: "axis_room_block_mgr-1_uid3",
      propertyId: "h1",
      propertyLabel: "4709A 8th Ave NE",
      residentName: "Casey Park",
      residentEmail: "casey@example.com",
      residentPhone: "",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.channel).toBe("email");
    expect(enqueueOwnerSms).not.toHaveBeenCalled();
    expect(deliverResidentWelcome).toHaveBeenCalledTimes(1);
  });

  it("attaches to an existing identity by email instead of creating a duplicate", async () => {
    const db = mockDb([
      {
        id: "PROPLANE-EXIST1",
        manager_user_id: "mgr-1",
        resident_email: "alex@example.com",
        row_data: { id: "PROPLANE-EXIST1", name: "Alex Rivera", bucket: "approved" },
      },
    ]);
    enqueueOwnerSms.mockResolvedValue({ ok: true, outboxId: "ob-2", status: "queued", deduplicated: false });

    const result = await sendBookingResidentInvite(db as never, actor, {
      blockId: "axis_room_block_mgr-1_uid4",
      propertyId: "h1",
      propertyLabel: "4709A 8th Ave NE",
      residentName: "Alex Rivera",
      residentEmail: "alex@example.com",
      residentPhone: "+12065550123",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attachedExisting).toBe(true);
    expect(result.axisId).toBe("PROPLANE-EXIST1");
    // Never a second manager_application_records row for the same person.
    expect(db._upsertCalls).toHaveLength(0);
    expect(db._rows).toHaveLength(1);
    // The real application's own bucket is left alone — attaching a booking
    // never overwrites an existing resident's actual application state.
    expect(db._rows[0]!.row_data.bucket).toBe("approved");
  });

  it("attaches to an existing identity by phone when the email is blank", async () => {
    const db = mockDb([
      {
        id: "PROPLANE-EXIST2",
        manager_user_id: "mgr-1",
        resident_email: "jamie@example.com",
        row_data: { id: "PROPLANE-EXIST2", name: "Jamie Lee", phone: "+12065550199" },
      },
    ]);
    enqueueOwnerSms.mockResolvedValue({ ok: true, outboxId: "ob-3", status: "queued", deduplicated: false });

    const result = await sendBookingResidentInvite(db as never, actor, {
      blockId: "axis_room_block_mgr-1_uid5",
      propertyId: "h1",
      propertyLabel: "4709A 8th Ave NE",
      residentName: "Jamie Lee",
      residentEmail: "",
      residentPhone: "+12065550199",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attachedExisting).toBe(true);
    expect(result.axisId).toBe("PROPLANE-EXIST2");
    expect(db._upsertCalls).toHaveLength(0);
  });

  it("refuses without a name, and without either an email or a phone", async () => {
    const db = mockDb();
    const noName = await sendBookingResidentInvite(db as never, actor, {
      blockId: "b1",
      propertyId: "h1",
      propertyLabel: "House",
      residentName: "",
      residentEmail: "a@example.com",
      residentPhone: "",
    });
    expect(noName.ok).toBe(false);

    const noContact = await sendBookingResidentInvite(db as never, actor, {
      blockId: "b1",
      propertyId: "h1",
      propertyLabel: "House",
      residentName: "Alex Rivera",
      residentEmail: "",
      residentPhone: "",
    });
    expect(noContact.ok).toBe(false);
  });
});
