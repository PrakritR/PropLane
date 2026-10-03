import { describe, expect, it } from "vitest";
import {
  ensureVendorForOutboundText,
  routeUnrecognizedInboundText,
  smsLeadApplicationId,
} from "@/lib/sms/inbound-text-routing.server";

type Row = Record<string, unknown>;

/** Stateful PostgREST fixture: upsert honours `ignoreDuplicates`, so a repeat text proves idempotence. */
function database(seed: Record<string, Row[]> = {}) {
  const rows: Record<string, Row[]> = structuredClone(seed);
  const upserts: { table: string; row: Row }[] = [];
  const db = {
    from(table: string) {
      const predicates: ((row: Row) => boolean)[] = [];
      let maxRows = Infinity;
      const query = {
        select() { return query; },
        eq(column: string, value: unknown) { predicates.push((row) => row[column] === value); return query; },
        in(column: string, values: unknown[]) { predicates.push((row) => values.includes(row[column])); return query; },
        limit(n: number) { maxRows = n; return query; },
        async maybeSingle() {
          return { data: (rows[table] ?? []).find((row) => predicates.every((p) => p(row))) ?? null, error: null };
        },
        async upsert(value: Row, options?: { ignoreDuplicates?: boolean }) {
          upserts.push({ table, row: value });
          const list = (rows[table] ??= []);
          const at = list.findIndex((row) => row.id === value.id);
          if (at === -1) list.push(value);
          else if (!options?.ignoreDuplicates) list[at] = value;
          return { error: null };
        },
        then(resolve: (result: { data: Row[]; error: null }) => void) {
          resolve({ data: (rows[table] ?? []).filter((row) => predicates.every((p) => p(row))).slice(0, maxRows), error: null });
        },
      };
      return query;
    },
  };
  return { db: db as never, rows, upserts };
}

const OWNER = "mgr-seattle";
const TEXT = { managerUserId: OWNER, workspaceId: "ws-seattle", fromPhone: "(206) 555-0199" };

describe("routeUnrecognizedInboundText (C2-DT4)", () => {
  it("creates exactly one Potential resident named from 'this is <Name>'", async () => {
    const { db, rows } = database();
    const result = await routeUnrecognizedInboundText(db, { ...TEXT, body: "Hi, is Room 3 still available? This is Priya." });

    expect(result).toMatchObject({ kind: "potential", name: "Priya", created: true });
    expect(rows.manager_application_records).toHaveLength(1);
    expect(rows.manager_application_records[0]).toMatchObject({
      manager_user_id: OWNER,
      id: smsLeadApplicationId(OWNER, "+12065550199"),
    });
    const data = rows.manager_application_records[0].row_data as Row;
    expect(data).toMatchObject({
      name: "Priya",
      bucket: "pending",
      phone: "+12065550199",
      smsLead: true,
      smsLeadWorkspaceId: "ws-seattle",
    });
    expect(String(data.email)).toMatch(/@import\.proplane\.local$/);
  });

  it("falls back to the formatted phone when the text gives no name", async () => {
    const { db, rows } = database();
    const result = await routeUnrecognizedInboundText(db, { ...TEXT, body: "Is the room still available?" });
    expect(result).toMatchObject({ kind: "potential", name: "+1 (206) 555-0199" });
    expect((rows.manager_application_records[0].row_data as Row).name).toBe("+1 (206) 555-0199");
  });

  it("a second text from the same number joins the first and never duplicates the row", async () => {
    const { db, rows } = database();
    await routeUnrecognizedInboundText(db, { ...TEXT, body: "This is Priya" });
    const again = await routeUnrecognizedInboundText(db, { ...TEXT, fromPhone: "+1 206 555 0199", body: "Anyone there?" });

    expect(again).toMatchObject({ kind: "known-resident" });
    expect(rows.manager_application_records).toHaveLength(1);
  });

  it("a webhook retry of the same text upserts the same row", async () => {
    const { db, rows, upserts } = database();
    const first = routeUnrecognizedInboundText(db, { ...TEXT, body: "Hello" });
    const second = routeUnrecognizedInboundText(db, { ...TEXT, body: "Hello" });
    await Promise.all([first, second]);
    // Both calls raced past the lookup; the deterministic id + ignoreDuplicates keep one row.
    expect(upserts.every((entry) => entry.row.id === smsLeadApplicationId(OWNER, "+12065550199"))).toBe(true);
    expect(rows.manager_application_records).toHaveLength(1);
  });

  it("a number that already has an application creates nothing", async () => {
    const { db, rows } = database({
      manager_application_records: [
        { id: "PROPLANE-HAND", manager_user_id: OWNER, row_data: { phone: "206-555-0199", name: "Added by hand" } },
      ],
    });
    const result = await routeUnrecognizedInboundText(db, { ...TEXT, body: "Hi" });
    expect(result).toEqual({ kind: "known-resident", applicationId: "PROPLANE-HAND" });
    expect(rows.manager_application_records).toHaveLength(1);
  });

  it("another manager's application with this phone does not count", async () => {
    const { db, rows } = database({
      manager_application_records: [
        { id: "PROPLANE-THEIRS", manager_user_id: "mgr-other", row_data: { phone: "+12065550199" } },
      ],
    });
    const result = await routeUnrecognizedInboundText(db, { ...TEXT, body: "Hi" });
    expect(result.kind).toBe("potential");
    expect(rows.manager_application_records).toHaveLength(2);
  });

  it("STOP, START and HELP create nothing", async () => {
    for (const body of ["STOP", "start", "Help."]) {
      const { db, rows } = database();
      expect(await routeUnrecognizedInboundText(db, { ...TEXT, body })).toEqual({ kind: "stop" });
      expect(rows.manager_application_records ?? []).toHaveLength(0);
      expect(rows.manager_vendor_records ?? []).toHaveLength(0);
    }
  });

  it("an unreadable phone creates nothing", async () => {
    const { db, rows } = database();
    expect(await routeUnrecognizedInboundText(db, { ...TEXT, fromPhone: "12", body: "Hi" })).toEqual({ kind: "invalid" });
    expect(rows.manager_application_records ?? []).toHaveLength(0);
  });
});

describe("routeUnrecognizedInboundText (C2-DT5)", () => {
  const vendorRow = {
    id: "vendor-dana",
    manager_user_id: OWNER,
    row_data: { id: "vendor-dana", name: "Dana's Plumbing", phone: "(206) 555-0199", active: true, vendorUserId: "u-dana" },
  };

  it("a known vendor's text lands on that vendor, never Potential residents", async () => {
    const { db, rows } = database({ manager_vendor_records: [vendorRow] });
    const result = await routeUnrecognizedInboundText(db, { ...TEXT, body: "Hi, is Room 3 still available?" });

    expect(result).toEqual({
      kind: "vendor",
      vendorId: "vendor-dana",
      vendorUserId: "u-dana",
      name: "Dana's Plumbing",
      created: false,
    });
    expect(rows.manager_application_records ?? []).toHaveLength(0);
    expect(rows.manager_vendor_records).toHaveLength(1);
  });

  it("another manager's vendor with this phone is not matched", async () => {
    const { db } = database({ manager_vendor_records: [{ ...vendorRow, manager_user_id: "mgr-other" }] });
    expect((await routeUnrecognizedInboundText(db, { ...TEXT, body: "Hello" })).kind).toBe("potential");
  });

  it("an unknown number that sounds like a trade becomes a vendor, not a Potential resident", async () => {
    const { db, rows } = database();
    const result = await routeUnrecognizedInboundText(db, { ...TEXT, body: "I'm a plumber, can I quote the leak?" });

    expect(result).toMatchObject({ kind: "vendor", created: true, vendorUserId: null });
    expect(rows.manager_application_records ?? []).toHaveLength(0);
    expect(rows.manager_vendor_records).toHaveLength(1);
    expect(rows.manager_vendor_records[0].row_data).toMatchObject({
      trade: "Plumbing",
      phone: "+12065550199",
      active: true,
      managerUserId: OWNER,
    });
  });

  it("the vendor the first text created is found by the second, so the list never doubles", async () => {
    const { db, rows } = database();
    await routeUnrecognizedInboundText(db, { ...TEXT, body: "electrician here, quote ready" });
    const again = await routeUnrecognizedInboundText(db, { ...TEXT, body: "any update?" });

    expect(again).toMatchObject({ kind: "vendor", created: false });
    expect(rows.manager_vendor_records).toHaveLength(1);
    expect(rows.manager_application_records ?? []).toHaveLength(0);
  });
});

describe("ensureVendorForOutboundText (C2-DT5)", () => {
  const send = { managerUserId: OWNER, toPhone: "(206) 555-0123", body: "Can you look at a leak?" };

  it("ticking 'This is a vendor' adds a stranger to Vendors", async () => {
    const { db, rows } = database();
    const result = await ensureVendorForOutboundText(db, { ...send, markedVendor: true });
    expect(result).toMatchObject({ created: true });
    expect(rows.manager_vendor_records).toHaveLength(1);
    expect(rows.manager_vendor_records[0].row_data).toMatchObject({ phone: "+12065550123" });
  });

  it("an ordinary text to a stranger adds nobody", async () => {
    const { db, rows } = database();
    expect(await ensureVendorForOutboundText(db, { ...send, markedVendor: false })).toBeNull();
    expect(rows.manager_vendor_records ?? []).toHaveLength(0);
  });

  it("texting a vendor already on the list changes nothing", async () => {
    const { db, rows } = database({
      manager_vendor_records: [
        { id: "v1", manager_user_id: OWNER, row_data: { id: "v1", name: "Existing", phone: "+12065550123", active: true } },
      ],
    });
    expect(await ensureVendorForOutboundText(db, { ...send, markedVendor: true })).toEqual({
      vendorId: "v1",
      name: "Existing",
      created: false,
    });
    expect(rows.manager_vendor_records).toHaveLength(1);
  });

  it("a PropLane vendor account that VERIFIED that number is added without the tick", async () => {
    const { db, rows } = database({
      vendor_business_profiles: [
        { user_id: "u-vendor", business_name: "Apex Plumbing", work_email: "a@apex.test", work_phone: "(206) 555-0123", trades: ["Plumbing"] },
      ],
      profiles: [{ id: "u-vendor", phone: "+12065550123", phone_verified_at: "2026-09-01T00:00:00.000Z" }],
    });
    const result = await ensureVendorForOutboundText(db, { ...send, markedVendor: false });
    expect(result).toMatchObject({ name: "Apex Plumbing", created: true });
    expect(rows.manager_vendor_records[0]).toMatchObject({ manager_user_id: OWNER, vendor_user_id: "u-vendor" });
  });

  it("an account that merely TYPED that number is never linked to the manager's roster", async () => {
    // `work_phone` is self-reported, so a match is a claim, not proof: an
    // account that types a real contractor's number must not be pulled onto
    // the manager's roster when the manager texts that contractor.
    const { db, rows } = database({
      vendor_business_profiles: [
        { user_id: "u-impostor", business_name: "Not Apex", work_email: "x@x.test", work_phone: "(206) 555-0123", trades: ["Plumbing"] },
      ],
      profiles: [{ id: "u-impostor", phone: "+12065559999", phone_verified_at: "2026-09-01T00:00:00.000Z" }],
    });
    expect(await ensureVendorForOutboundText(db, { ...send, markedVendor: false })).toBeNull();
    expect(rows.manager_vendor_records ?? []).toHaveLength(0);
  });

  it("an unverified account still gets an UNLINKED roster row when the manager ticks 'this is a vendor'", async () => {
    const { db, rows } = database({
      vendor_business_profiles: [
        { user_id: "u-impostor", business_name: "Not Apex", work_email: "x@x.test", work_phone: "(206) 555-0123", trades: ["Plumbing"] },
      ],
    });
    const result = await ensureVendorForOutboundText(db, { ...send, markedVendor: true });
    expect(result).toMatchObject({ created: true });
    expect(rows.manager_vendor_records[0]).toMatchObject({ manager_user_id: OWNER, vendor_user_id: null });
  });
});
