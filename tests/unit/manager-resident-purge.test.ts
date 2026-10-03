import { describe, expect, it, vi } from "vitest";
import {
  MANAGER_RESIDENT_PURGE_TARGETS,
  previewManagerResidentPurge,
  purgeManagerResidentData,
} from "@/lib/auth/purge-manager-resident";

type Row = Record<string, unknown>;

/**
 * Stateful PostgREST + RPC fixture. The RPC stands in for
 * `purge_manager_resident_rows`: it deletes the ids it is handed, enforces the
 * manager scope the SQL function enforces, and can be made to fail so the
 * all-or-nothing claim is testable.
 */
function database(seed: Record<string, Row[]>, options: { rpcFails?: string } = {}) {
  const rows: Record<string, Row[]> = structuredClone(seed);
  const managerColumns: Record<string, string> = {
    resident_autopay_runs: "manager_id",
    resident_autopay_settings: "manager_id",
    portal_inbox_thread_records: "owner_user_id",
  };
  const rpcCalls: {
    p_manager: string;
    p_targets: { table: string; ids: string[] }[];
    p_anonymize: { table: string; ids: string[] }[];
  }[] = [];
  const removedStoragePaths: string[] = [];

  const db = {
    rpcCalls,
    removedStoragePaths,
    async rpc(
      name: string,
      args: {
        p_manager: string;
        p_targets: { table: string; ids: string[] }[];
        p_anonymize: { table: string; ids: string[] }[];
      },
    ) {
      if (name !== "purge_manager_resident_rows_v2") throw new Error(`Unexpected RPC ${name}`);
      rpcCalls.push(args);
      if (options.rpcFails) return { data: null, error: { message: options.rpcFails } };
      const counts: Record<string, number> = {};
      const anonymized: Record<string, number> = {};
      // One transaction: resolve every write against a copy, then commit it.
      const staged: Record<string, Row[]> = structuredClone(rows);
      for (const target of args.p_anonymize) {
        const ownerColumn = managerColumns[target.table] ?? "manager_user_id";
        const hit = (staged[target.table] ?? []).filter((row) => target.ids.includes(String(row.id)));
        if (hit.some((row) => row[ownerColumn] !== args.p_manager)) {
          return { data: null, error: { message: `rows in ${target.table} are outside this portfolio` } };
        }
        for (const row of hit) {
          row.resident_user_id = null;
          row.resident_email = target.table === "security_deposit_ledger" ? "" : null;
          if (row.row_data) {
            row.row_data = { ...(row.row_data as Row), residentEmail: "", residentName: "", anonymized: true };
          }
        }
        anonymized[target.table] = (anonymized[target.table] ?? 0) + hit.length;
      }
      for (const target of args.p_targets) {
        const ownerColumn = managerColumns[target.table] ?? "manager_user_id";
        const doomed = (staged[target.table] ?? []).filter((row) => target.ids.includes(String(row.id)));
        const foreign = doomed.filter((row) => row[ownerColumn] !== args.p_manager);
        if (foreign.length > 0) {
          return { data: null, error: { message: `${foreign.length} row(s) in ${target.table} are outside this portfolio` } };
        }
        staged[target.table] = (staged[target.table] ?? []).filter((row) => !doomed.includes(row));
        counts[target.table] = (counts[target.table] ?? 0) + doomed.length;
      }
      for (const [table, value] of Object.entries(staged)) rows[table] = value;
      return { data: { deleted: counts, anonymized }, error: null };
    },
    from(table: string) {
      const predicates: ((row: Row) => boolean)[] = [];
      let offset = 0;
      let end = Infinity;
      const read = (row: Row, column: string) => {
        const [key, nested] = column.split("->>");
        return nested ? (row[key] as Row | undefined)?.[nested] : row[key];
      };
      const query = {
        select() { return query; },
        order() { return query; },
        range(from: number, to: number) { offset = from; end = to + 1; return query; },
        eq(column: string, value: unknown) { predicates.push((row) => read(row, column) === value); return query; },
        neq(column: string, value: unknown) { predicates.push((row) => read(row, column) !== value); return query; },
        in(column: string, values: unknown[]) { predicates.push((row) => values.includes(read(row, column))); return query; },
        ilike(column: string, value: string) {
          // A resident's address must be matched literally; wildcards are escaped.
          const literal = value.replace(/\\([\\%_])/g, "$1").toLowerCase();
          predicates.push((row) => String(read(row, column) ?? "").toLowerCase() === literal);
          return query;
        },
        filter(column: string, op: string, value: string) {
          return op === "ilike" ? query.ilike(column, value) : query.eq(column, value);
        },
        async maybeSingle() {
          return { data: (rows[table] ?? []).find((row) => predicates.every((p) => p(row))) ?? null, error: null };
        },
        then(resolve: (result: { data: Row[]; error: null }) => void) {
          resolve({ data: (rows[table] ?? []).filter((row) => predicates.every((p) => p(row))).slice(offset, end), error: null });
        },
      };
      return query;
    },
    storage: {
      from: () => ({
        list: async () => ({ data: [], error: null }),
        remove: async (paths: string[]) => { removedStoragePaths.push(...paths); return { error: null }; },
      }),
    },
  };
  return { db, rows };
}

/** One resident of manager A who also rents from manager B. */
function seattleHomes(): Record<string, Row[]> {
  return {
    manager_application_records: [
      { id: "app-a", manager_user_id: "mgr-a", resident_email: "heesu@example.com" },
      { id: "app-b", manager_user_id: "mgr-b", resident_email: "heesu@example.com" },
      { id: "app-other", manager_user_id: "mgr-a", resident_email: "precious@example.com" },
    ],
    portal_lease_pipeline_records: [
      { id: "lease-a", manager_user_id: "mgr-a", resident_email: "Heesu@Example.com", status: "signed" },
      { id: "lease-b", manager_user_id: "mgr-b", resident_email: "heesu@example.com", status: "signed" },
    ],
    portal_household_charge_records: [
      { id: "charge-1", manager_user_id: "mgr-a", resident_email: "heesu@example.com" },
      { id: "charge-2", manager_user_id: "mgr-a", resident_user_id: "resident-1" },
      { id: "charge-other", manager_user_id: "mgr-a", resident_email: "precious@example.com" },
    ],
    portal_service_request_records: [{ id: "svc-1", manager_user_id: "mgr-a", resident_email: "heesu@example.com" }],
    portal_work_order_records: [{ id: "maint-1", manager_user_id: "mgr-a", resident_email: "heesu@example.com" }],
    resident_inspections: [
      { id: "insp-1", manager_user_id: "mgr-a", resident_email: "heesu@example.com", application_id: "app-a" },
    ],
    manager_documents: [
      { id: "doc-1", manager_user_id: "mgr-a", resident_email: "heesu@example.com", storage_path: "manager/mgr-a/lease.pdf" },
    ],
    portal_inbox_thread_records: [
      { id: "thread-1", owner_user_id: "mgr-a", participant_email: "heesu@example.com", scope: "axis_portal_inbox_manager_v1" },
      { id: "support", owner_user_id: "mgr-a", participant_email: "heesu@example.com", scope: "admin" },
    ],
    portal_reminder_records: [
      { id: "rem-resident", manager_user_id: "mgr-a", recipient_email: "heesu@example.com", recipient_role: "resident" },
      { id: "rem-manager", manager_user_id: "mgr-a", recipient_email: "heesu@example.com", recipient_role: "manager" },
    ],
    portal_scheduled_inbox_message_records: [
      { id: "sched-1", manager_user_id: "mgr-a", row_data: { recipientEmail: "heesu@example.com" } },
    ],
    resident_autopay_settings: [{ id: "autopay-1", manager_id: "mgr-a", resident_user_id: "resident-1" }],
    // Money really received stays in Financials, the same stance the orphan purge takes.
    ledger_entries: [{ id: "ledger-1", manager_user_id: "mgr-a", resident_email: "heesu@example.com" }],
  };
}

const identity = {
  managerUserId: "mgr-a",
  email: "heesu@example.com",
  residentUserId: "resident-1",
  applicationId: "app-a",
};

describe("previewManagerResidentPurge", () => {
  it("counts every linked record in this portfolio and nothing outside it", async () => {
    const { db, rows } = database(seattleHomes());
    const preview = await previewManagerResidentPurge(db as never, identity);

    expect(preview.counts).toEqual({
      leases: 1,
      charges: 3, // charge by email + charge by user id + autopay settings
      services: 2, // add-on request + maintenance, never called "work orders"
      inspections: 1,
      documents: 1,
      conversations: 3, // thread + resident reminder + scheduled message
      bookings: 0,
      texts: 0,
      applications: 1,
    });
    expect(preview.total).toBe(12);
    expect(preview.applicationIds).toEqual(["app-a"]);

    // A preview writes nothing.
    expect(rows.portal_lease_pipeline_records).toHaveLength(2);
    expect(rows.manager_application_records).toHaveLength(3);
  });

  it("leaves the other manager's tenancy, the shared support inbox and the ledger out", async () => {
    const { db } = database(seattleHomes());
    const preview = await previewManagerResidentPurge(db as never, identity);
    const targeted = new Map(preview.targets.map((target) => [target.table, target.ids]));

    expect(targeted.get("portal_lease_pipeline_records")).toEqual(["lease-a"]);
    expect(targeted.get("manager_application_records")).toEqual(["app-a"]);
    expect(targeted.get("portal_inbox_thread_records")).toEqual(["thread-1"]);
    expect(targeted.get("portal_reminder_records")).toEqual(["rem-resident"]);
    expect(targeted.has("ledger_entries")).toBe(false);
    for (const ids of targeted.values()) {
      expect(ids).not.toContain("charge-other");
      expect(ids).not.toContain("app-other");
    }
  });

  it("refuses to guess: no identity means no targets", async () => {
    const { db } = database(seattleHomes());
    const preview = await previewManagerResidentPurge(db as never, { managerUserId: "mgr-a" });
    expect(preview.total).toBe(0);
    expect(preview.targets).toEqual([]);
  });

  it("deletes children before the application they hang off", async () => {
    const order = MANAGER_RESIDENT_PURGE_TARGETS.map((target) => target.table);
    expect(order.indexOf("screening_orders")).toBeLessThan(order.indexOf("manager_application_records"));
    expect(order.indexOf("cosigner_submission_records")).toBeLessThan(order.indexOf("manager_application_records"));
    expect(order.indexOf("resident_autopay_runs")).toBeLessThan(order.indexOf("resident_autopay_settings"));
  });
});

describe("purgeManagerResidentData", () => {
  it("removes every linked row in one call and reports what went", async () => {
    const { db, rows } = database(seattleHomes());
    const result = await purgeManagerResidentData(db as never, identity);

    expect(db.rpcCalls).toHaveLength(1);
    expect(result.total).toBe(12);
    expect(result.counts.leases).toBe(1);
    expect(result.counts.services).toBe(2);

    expect(rows.portal_lease_pipeline_records.map((row) => row.id)).toEqual(["lease-b"]);
    expect(rows.portal_household_charge_records.map((row) => row.id)).toEqual(["charge-other"]);
    expect(rows.portal_service_request_records).toEqual([]);
    expect(rows.portal_work_order_records).toEqual([]);
    expect(rows.resident_inspections).toEqual([]);
    expect(rows.manager_application_records.map((row) => row.id)).toEqual(["app-b", "app-other"]);
    expect(rows.portal_inbox_thread_records.map((row) => row.id)).toEqual(["support"]);
    expect(rows.portal_reminder_records.map((row) => row.id)).toEqual(["rem-manager"]);
    expect(rows.ledger_entries).toHaveLength(1);
  });

  it("reclaims the private bytes only after the rows are gone", async () => {
    const { db } = database(seattleHomes());
    await purgeManagerResidentData(db as never, identity);
    expect(db.removedStoragePaths).toContain("manager/mgr-a/lease.pdf");
  });

  it("removes nothing when the transaction fails", async () => {
    const { db, rows } = database(seattleHomes(), { rpcFails: "deadlock detected" });
    await expect(purgeManagerResidentData(db as never, identity)).rejects.toThrow("Nothing was deleted");

    expect(rows.portal_lease_pipeline_records).toHaveLength(2);
    expect(rows.portal_household_charge_records).toHaveLength(3);
    expect(rows.manager_application_records).toHaveLength(3);
    expect(db.removedStoragePaths).toEqual([]);
  });

  it("points at the missing migration rather than deleting row by row", async () => {
    const { db, rows } = database(seattleHomes());
    vi.spyOn(db, "rpc").mockResolvedValue({
      data: null,
      error: { code: "PGRST202", message: "Could not find the function" },
    } as never);
    await expect(purgeManagerResidentData(db as never, identity)).rejects.toThrow("npm run db:push");
    expect(rows.portal_lease_pipeline_records).toHaveLength(2);
  });

  it("a resident with nothing linked needs no transaction", async () => {
    const { db } = database({
      manager_application_records: [{ id: "app-z", manager_user_id: "mgr-a", resident_email: "nobody@example.com" }],
    });
    const result = await purgeManagerResidentData(db as never, {
      managerUserId: "mgr-a",
      email: "ghost@example.com",
      applicationId: "app-missing",
    });
    expect(result.total).toBe(0);
    expect(db.rpcCalls).toHaveLength(0);
  });
});

/**
 * C2-DT2. One resident of manager A who has a signed lease, a hand-entered
 * booking block, a thread, texts on the work number, one paid and one unpaid
 * charge, the ledger lines of both, and a held deposit. A second resident and a
 * second manager share the phone / email shape so a leak would show.
 */
function noorHalvorsen(): Record<string, Row[]> {
  const phone = "+12065550123";
  return {
    manager_application_records: [
      {
        id: "app-noor",
        manager_user_id: "mgr-a",
        resident_email: "noor@example.com",
        row_data: { application: { phone: "(206) 555-0123" } },
      },
      { id: "app-other", manager_user_id: "mgr-a", resident_email: "other@example.com", row_data: {} },
    ],
    portal_lease_pipeline_records: [
      { id: "lease-noor", manager_user_id: "mgr-a", resident_email: "noor@example.com" },
      { id: "lease-other", manager_user_id: "mgr-a", resident_email: "other@example.com" },
    ],
    portal_schedule_records: [
      {
        id: "block-noor",
        manager_user_id: "mgr-a",
        record_type: "room_date_block",
        row_data: { residentEmail: "noor@example.com" },
      },
      {
        id: "tour-noor",
        manager_user_id: "mgr-a",
        record_type: "tour_slot",
        row_data: { residentEmail: "noor@example.com" },
      },
      {
        id: "block-other",
        manager_user_id: "mgr-a",
        record_type: "room_date_block",
        row_data: { residentEmail: "other@example.com" },
      },
    ],
    portal_inbox_thread_records: [
      { id: "thread-noor", owner_user_id: "mgr-a", participant_email: "noor@example.com", scope: "manager" },
      { id: "thread-other", owner_user_id: "mgr-a", participant_email: "other@example.com", scope: "manager" },
    ],
    manager_sms_messages: [
      { id: "sms-in", manager_user_id: "mgr-a", resident_phone: phone, direction: "inbound" },
      { id: "sms-out", manager_user_id: "mgr-a", resident_phone: phone, direction: "outbound" },
      { id: "sms-other", manager_user_id: "mgr-a", resident_phone: "+12065550999", direction: "inbound" },
      { id: "sms-other-mgr", manager_user_id: "mgr-b", resident_phone: phone, direction: "inbound" },
    ],
    inbound_sms_log: [
      { id: "log-noor", manager_user_id: "mgr-a", from_phone: phone },
      { id: "log-other", manager_user_id: "mgr-a", from_phone: "+12065550999" },
    ],
    manager_sms_contacts: [{ id: "contact-noor", manager_user_id: "mgr-a", phone_e164: phone }],
    portal_household_charge_records: [
      {
        id: "charge-paid",
        manager_user_id: "mgr-a",
        resident_email: "noor@example.com",
        status: "paid",
        row_data: { status: "paid", amountCents: 97500, residentEmail: "noor@example.com", residentName: "Noor Halvorsen" },
      },
      {
        id: "charge-due",
        manager_user_id: "mgr-a",
        resident_email: "noor@example.com",
        status: "pending",
        row_data: { status: "pending", amountCents: 97500, residentEmail: "noor@example.com" },
      },
      {
        id: "charge-other",
        manager_user_id: "mgr-a",
        resident_email: "other@example.com",
        status: "pending",
        row_data: { status: "pending" },
      },
    ],
    ledger_entries: [
      { id: "ledger-paid-charge", manager_user_id: "mgr-a", resident_email: "noor@example.com", entry_type: "charge", source_charge_id: "charge-paid" },
      { id: "ledger-paid-payment", manager_user_id: "mgr-a", resident_email: "noor@example.com", entry_type: "payment", source_charge_id: "charge-paid" },
      { id: "ledger-due-charge", manager_user_id: "mgr-a", resident_email: "noor@example.com", entry_type: "charge", source_charge_id: "charge-due" },
      { id: "ledger-other", manager_user_id: "mgr-a", resident_email: "other@example.com", entry_type: "charge", source_charge_id: "charge-other" },
    ],
    security_deposit_ledger: [
      { id: "deposit-noor", manager_user_id: "mgr-a", resident_email: "noor@example.com", amount_cents: 25000 },
    ],
  };
}

describe("purgeManagerResidentData (C2-DT2: delete Noor Halvorsen)", () => {
  const noor = { managerUserId: "mgr-a", email: "noor@example.com", applicationId: "app-noor" };

  it("removes the booking, messages, texts and unpaid charges in one transaction", async () => {
    const { db, rows } = database(noorHalvorsen());
    const result = await purgeManagerResidentData(db as never, noor);

    expect(db.rpcCalls).toHaveLength(1);
    // The booking bar leaves the calendar: the lease and the hand-entered block go.
    expect(rows.portal_lease_pipeline_records.map((row) => row.id)).toEqual(["lease-other"]);
    expect(rows.portal_schedule_records.map((row) => row.id)).toEqual(["tour-noor", "block-other"]);
    // Communication: the thread and every text, found by the phone on the application.
    expect(rows.portal_inbox_thread_records.map((row) => row.id)).toEqual(["thread-other"]);
    expect(rows.manager_sms_messages.map((row) => row.id)).toEqual(["sms-other", "sms-other-mgr"]);
    expect(rows.inbound_sms_log.map((row) => row.id)).toEqual(["log-other"]);
    expect(rows.manager_sms_contacts).toEqual([]);
    // Unpaid charge and its accrual line are gone; someone else's are not.
    expect(rows.portal_household_charge_records.map((row) => row.id)).toEqual(["charge-paid", "charge-other"]);
    expect(rows.ledger_entries.map((row) => row.id)).not.toContain("ledger-due-charge");
    expect(rows.ledger_entries.map((row) => row.id)).toContain("ledger-other");

    expect(result.counts.bookings).toBe(1);
    expect(result.counts.texts).toBe(4); // two messages + the log row + the contact
    expect(result.counts.charges).toBe(1);
    expect(result.counts.leases).toBe(1);
    expect(result.counts.applications).toBe(1);
  });

  it("keeps the paid money, anonymised, so income and deposit totals still add up", async () => {
    const { db, rows } = database(noorHalvorsen());
    const result = await purgeManagerResidentData(db as never, noor);

    const paid = rows.portal_household_charge_records.find((row) => row.id === "charge-paid");
    expect(paid).toMatchObject({ resident_email: null, resident_user_id: null });
    expect(paid?.row_data).toMatchObject({ amountCents: 97500, residentEmail: "", residentName: "", anonymized: true });

    // Ledger: both lines of the paid charge stay, with no name attached.
    for (const id of ["ledger-paid-charge", "ledger-paid-payment"]) {
      expect(rows.ledger_entries.find((row) => row.id === id)).toMatchObject({ resident_email: null });
    }
    expect(rows.security_deposit_ledger).toEqual([
      expect.objectContaining({ id: "deposit-noor", resident_email: "", amount_cents: 25000 }),
    ]);
    expect(result.anonymized).toMatchObject({
      portal_household_charge_records: 1,
      ledger_entries: 2,
      security_deposit_ledger: 1,
    });
    // The other resident is untouched.
    expect(rows.ledger_entries.find((row) => row.id === "ledger-other")).toMatchObject({
      resident_email: "other@example.com",
    });
  });

  it("deletes a charge's accrual line before the charge so the foreign key never orphans it", async () => {
    const { db } = database(noorHalvorsen());
    await purgeManagerResidentData(db as never, noor);
    const order = db.rpcCalls[0].p_targets.map((target) => target.table);
    expect(order.indexOf("ledger_entries")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("ledger_entries")).toBeLessThan(order.indexOf("portal_household_charge_records"));
  });

  it("never touches texts when the resident has no phone on file", async () => {
    const seed = noorHalvorsen();
    seed.manager_application_records[0].row_data = {};
    const { db, rows } = database(seed);
    await purgeManagerResidentData(db as never, noor);
    expect(rows.manager_sms_messages).toHaveLength(4);
    expect(rows.inbound_sms_log).toHaveLength(2);
  });

  it("matches the phone the resident signed up with", async () => {
    const seed = noorHalvorsen();
    seed.manager_application_records[0].row_data = {};
    const { db, rows } = database(seed);
    await purgeManagerResidentData(db as never, { ...noor, phones: ["(206) 555-0123"] });
    expect(rows.manager_sms_messages.map((row) => row.id)).toEqual(["sms-other", "sms-other-mgr"]);
  });
});
