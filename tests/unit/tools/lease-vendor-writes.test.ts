import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentContext } from "@/lib/tools/context";
import { auditDayBucket } from "@/lib/tools/audit";

// The lease notification and vendor invite pipelines are shared server libs
// with their own delivery concerns (Resend, recipient scoping, tokens); the
// tool tests assert they are invoked with server-derived values, not re-test
// their internals.
vi.mock("@/lib/portal-inbox-delivery", () => ({
  deliverPortalInboxMessage: vi.fn(async () => ({ ok: true, recipientCount: 1 })),
}));
vi.mock("@/lib/vendor-invite.server", () => ({
  sendVendorInvite: vi.fn(async () => ({ ok: true, emailId: "email_1", linkUrl: "https://axis.test/auth/vendor-register?token=t" })),
}));

import { deliverPortalInboxMessage } from "@/lib/portal-inbox-delivery";
import { sendVendorInvite } from "@/lib/vendor-invite.server";
import { listLeasesTool, amendLeaseTool, voidLeaseTool, sendLeaseForSignatureTool } from "@/lib/tools/domains/leases";
import { buildUploadedLeaseParse } from "@/lib/uploaded-lease-extraction";
import { addVendorTool, updateVendorTool, inviteVendorTool } from "@/lib/tools/domains/vendors";
import { executeWrite, previewWrite } from "./fake-agent-ctx";

/**
 * Local fake db, richer than tests/unit/tools/fake-agent-ctx.ts (which must not
 * be edited): the write tools additionally need maybeSingle / insert / update /
 * upsert / delete, plus the audit_log partial-unique dedupe_key behavior.
 * Filters are actually applied, so a missing landlord scope would surface
 * another landlord's rows and fail the test.
 */
type Row = Record<string, unknown>;
type Store = { tables: Record<string, Row[]> };

class FakeQuery {
  private filters: [string, unknown][] = [];
  private mode: "select" | "update" | "delete" = "select";
  private updateVals: Row = {};
  constructor(private table: string, private store: Store) {}

  select() {
    return this;
  }
  order() {
    return this;
  }
  limit() {
    return this;
  }
  eq(col: string, val: unknown) {
    this.filters.push([col, val]);
    return this;
  }
  neq(col: string, val: unknown) {
    this.filters.push([`!${col}`, val]);
    return this;
  }
  beginUpdate(vals: Row) {
    this.mode = "update";
    this.updateVals = vals;
    return this;
  }
  beginDelete() {
    this.mode = "delete";
    return this;
  }

  private matches(row: Row): boolean {
    return this.filters.every(([col, val]) => {
      if (col.startsWith("!")) return row[col.slice(1)] !== val;
      if (!(col in row)) return true;
      return row[col] === val;
    });
  }
  private applySelect(): Row[] {
    return (this.store.tables[this.table] ?? []).filter((r) => this.matches(r));
  }
  private run(): { data: Row[] | null; error: null } {
    if (this.mode === "update") {
      for (const r of this.store.tables[this.table] ?? []) {
        if (this.matches(r)) Object.assign(r, this.updateVals);
      }
      return { data: null, error: null };
    }
    if (this.mode === "delete") {
      this.store.tables[this.table] = (this.store.tables[this.table] ?? []).filter((r) => !this.matches(r));
      return { data: null, error: null };
    }
    return { data: this.applySelect(), error: null };
  }

  maybeSingle() {
    return Promise.resolve({ data: this.applySelect()[0] ?? null, error: null });
  }
  range(from: number, to: number) {
    return Promise.resolve({ data: this.applySelect().slice(from, to + 1), error: null });
  }
  then<T>(resolve: (v: { data: Row[] | null; error: null }) => T) {
    return Promise.resolve(this.run()).then(resolve);
  }
}

function makeCtx(tables: Record<string, Row[]>) {
  tables.manager_application_records ??= (tables.portal_lease_pipeline_records ?? []).map(record => {
    const lease = record.row_data as Row;
    lease.axisId ??= `APP-${lease.id}`;
    return { id: lease.axisId, manager_user_id: record.manager_user_id, row_data: { bucket: "approved", propertyId: record.property_id, assignedRoomChoice: lease.roomChoice, application: lease.application } };
  });
  const store: Store = { tables };
  const db = {
    async rpc(name: string, args: Row) {
      if (name !== "commit_room_lease_extension") throw new Error(`Unexpected RPC ${name}`);
      const lease = tables.portal_lease_pipeline_records?.find(r => r.id === args.p_lease_id && r.manager_user_id === args.p_owner);
      const application = tables.manager_application_records?.find(r => r.id === args.p_application_id && r.manager_user_id === args.p_owner);
      if (!lease || !application) return { error: { code: "40001" } };
      lease.row_data = args.p_next_lease;
      return { error: null };
    },
    from(table: string) {
      return {
        select: () => new FakeQuery(table, store),
        update: (vals: Row) => new FakeQuery(table, store).beginUpdate(vals),
        delete: () => new FakeQuery(table, store).beginDelete(),
        insert: async (row: Row) => {
          // Model the partial UNIQUE on audit_log.dedupe_key (NULLs never collide).
          if (
            table === "audit_log" &&
            row.dedupe_key != null &&
            (store.tables[table] ?? []).some((r) => r.dedupe_key === row.dedupe_key)
          ) {
            return { error: { code: "23505", message: "duplicate key value" } };
          }
          (store.tables[table] ??= []).push({ ...row });
          return { error: null };
        },
        upsert: async (row: Row) => {
          const rows = (store.tables[table] ??= []);
          const idx = rows.findIndex((r) => r.id === row.id);
          if (idx === -1) rows.push({ ...row });
          else rows[idx] = { ...rows[idx], ...row };
          return { error: null };
        },
      };
    },
  };
  const ctx = {
    landlordId: "manager_a",
    userId: "manager_a",
    email: "manager@axis.test",
    roles: ["manager"],
    isAdmin: false,
    db,
  } as unknown as AgentContext;
  return { ctx, store };
}

const SIGNED_AT = "2026-01-15T00:00:00.000Z";
const bothSignatures = {
  managerSignature: { name: "Alex Manager", signedAtIso: SIGNED_AT, role: "manager" },
  residentSignature: { name: "Pat Resident", signedAtIso: SIGNED_AT, role: "resident" },
};

function leaseRecord(
  managerUserId: string,
  rowData: Row,
  cols: { property_id?: string | null; resident_email?: string | null } = {},
): Row {
  return {
    id: rowData.id,
    manager_user_id: managerUserId,
    property_id: cols.property_id ?? null,
    resident_email: cols.resident_email ?? (String(rowData.residentEmail ?? "") || null),
    row_data: rowData,
  };
}

function fullySignedLease(id: string, overrides: Row = {}): Row {
  return {
    id,
    residentName: "Casey Doe",
    residentEmail: "casey@example.com",
    unit: "12 Main · Room 1",
    bucket: "signed",
    thread: [],
    application: { leaseStart: "2026-01-01", leaseEnd: "2026-06-30" },
    generatedHtml: "<html>lease</html>",
    fullySignedAt: SIGNED_AT,
    ...bothSignatures,
    ...overrides,
  };
}

function vendorRecord(managerUserId: string, rowData: Row, vendorUserId: string | null = null): Row {
  return {
    id: rowData.id,
    manager_user_id: managerUserId,
    vendor_user_id: vendorUserId,
    row_data: rowData,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("list_leases (projection upgrade)", () => {
  it("returns propertyId, lease dates, fullySignedAt, and residentEmail; foreign rows never surface", async () => {
    const { ctx } = makeCtx({
      portal_lease_pipeline_records: [
        leaseRecord("manager_a", fullySignedLease("lease_1", { propertyId: "prop_9" })),
        leaseRecord("manager_b", fullySignedLease("lease_foreign")),
      ],
    });
    const res = (await listLeasesTool.handler(ctx, {})) as { count: number; leases: Row[] };
    expect(res.count).toBe(1);
    expect(res.leases[0]).toMatchObject({
      id: "lease_1",
      status: "Fully Signed",
      residentEmail: "casey@example.com",
      propertyId: "prop_9",
      leaseStart: "2026-01-01",
      leaseEnd: "2026-06-30",
      fullySignedAt: SIGNED_AT,
    });
  });
});

describe("amend_lease", () => {
  it("preview rejects a lease owned by another landlord", async () => {
    const { ctx } = makeCtx({
      portal_lease_pipeline_records: [leaseRecord("manager_b", fullySignedLease("lease_foreign"))],
    });
    const res = await previewWrite(amendLeaseTool, ctx, { leaseId: "lease_foreign", newLeaseEnd: "2026-12-31" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("list_leases");
  });

  it("preview rejects a lease that is not fully signed", async () => {
    const { ctx } = makeCtx({
      portal_lease_pipeline_records: [
        leaseRecord("manager_a", fullySignedLease("lease_draft", { managerSignature: null, bucket: "manager" })),
      ],
    });
    const res = await previewWrite(amendLeaseTool, ctx, { leaseId: "lease_draft", newLeaseEnd: "2026-12-31" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("fully signed");
  });

  it("preview surfaces the conflict reason and next available date when the room is booked", async () => {
    const { ctx } = makeCtx({
      portal_lease_pipeline_records: [
        leaseRecord(
          "manager_a",
          fullySignedLease("lease_a", { roomChoice: "Room 1::room1", residentEmail: "casey@example.com" }),
          { property_id: "prop_1", resident_email: "casey@example.com" },
        ),
        leaseRecord(
          "manager_a",
          fullySignedLease("lease_b", {
            roomChoice: "Room 1::room1",
            residentEmail: "next@example.com",
            application: { leaseStart: "2026-09-01", leaseEnd: "2027-08-31" },
          }),
          { property_id: "prop_1", resident_email: "next@example.com" },
        ),
      ],
    });
    const res = await previewWrite(amendLeaseTool, ctx, { leaseId: "lease_a", newLeaseEnd: "2026-12-31" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("already booked");
      expect(res.error).toContain("Next available date: 2027-08-31");
    }
  });

  it("preview happy path carries the signature-reset warning", async () => {
    const { ctx } = makeCtx({
      portal_lease_pipeline_records: [leaseRecord("manager_a", fullySignedLease("lease_a"))],
    });
    const res = await previewWrite(amendLeaseTool, ctx, { leaseId: "lease_a", newLeaseEnd: "2026-12-31" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.preview.warnings?.[0]).toBe("Both signatures reset; the lease returns to review and must be re-signed.");
      expect(res.preview.fields).toContainEqual({ label: "New end", value: "2026-12-31" });
    }
  });

  it("execute amends the lease, resets signatures, and audits with the {leaseId}:{newLeaseEnd} dedupe key", async () => {
    const { ctx, store } = makeCtx({
      portal_lease_pipeline_records: [leaseRecord("manager_a", fullySignedLease("lease_a"))],
    });
    const res = await executeWrite(amendLeaseTool, ctx, { leaseId: "lease_a", newLeaseEnd: "2026-12-31" });
    expect(res.ok).toBe(true);

    const audit = store.tables.audit_log ?? [];
    expect(audit).toHaveLength(1);
    expect(audit[0]!.dedupe_key).toBe("amend_lease:manager_a:lease_a:2026-12-31");

    const record = store.tables.portal_lease_pipeline_records!.find((r) => r.id === "lease_a")!;
    const rowData = record.row_data as Row;
    expect((rowData.application as Row).leaseEnd).toBe("2026-12-31");
    expect(rowData.status).toBe("Manager Review");
    expect(rowData.managerSignature).toBeNull();
    expect(rowData.residentSignature).toBeNull();
  });

  it("execute is idempotent per lease + target date (duplicate returns already-done)", async () => {
    const { ctx, store } = makeCtx({
      portal_lease_pipeline_records: [leaseRecord("manager_a", fullySignedLease("lease_a"))],
    });
    await executeWrite(amendLeaseTool, ctx, { leaseId: "lease_a", newLeaseEnd: "2026-12-31" });
    // Restore signatures as if nothing changed, to prove the dedupe key (not
    // lease state) is what blocks the retry.
    const record = store.tables.portal_lease_pipeline_records!.find((r) => r.id === "lease_a")!;
    record.row_data = fullySignedLease("lease_a");
    const second = await executeWrite(amendLeaseTool, ctx, { leaseId: "lease_a", newLeaseEnd: "2026-12-31" });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.reply).toContain("already");
    expect(store.tables.audit_log).toHaveLength(1);
  });

  it("execute refuses a foreign lease id (cross-landlord isolation)", async () => {
    const { ctx, store } = makeCtx({
      portal_lease_pipeline_records: [leaseRecord("manager_b", fullySignedLease("lease_foreign"))],
    });
    const res = await executeWrite(amendLeaseTool, ctx, { leaseId: "lease_foreign", newLeaseEnd: "2026-12-31" });
    expect(res.ok).toBe(false);
    expect(store.tables.audit_log ?? []).toHaveLength(0);
    const rowData = store.tables.portal_lease_pipeline_records![0]!.row_data as Row;
    expect((rowData.application as Row).leaseEnd).toBe("2026-06-30");
  });
});

describe("void_lease", () => {
  it("is marked destructive and previews the permanence warning", async () => {
    expect(voidLeaseTool.destructive).toBe(true);
    const { ctx } = makeCtx({
      portal_lease_pipeline_records: [leaseRecord("manager_a", fullySignedLease("lease_v"))],
    });
    const res = await previewWrite(voidLeaseTool, ctx, { leaseId: "lease_v", reason: "Tenant broke the agreement" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.preview.warnings?.[0]).toBe("Voiding is permanent; the resident keeps portal access.");
      expect(res.preview.fields).toContainEqual({ label: "Reason", value: "Tenant broke the agreement" });
    }
  });

  it("preview rejects foreign and unknown lease ids", async () => {
    const { ctx } = makeCtx({
      portal_lease_pipeline_records: [leaseRecord("manager_b", fullySignedLease("lease_foreign"))],
    });
    const foreign = await previewWrite(voidLeaseTool, ctx, { leaseId: "lease_foreign" });
    expect(foreign.ok).toBe(false);
    const unknown = await previewWrite(voidLeaseTool, ctx, { leaseId: "nope" });
    expect(unknown.ok).toBe(false);
  });

  it("execute read-merge-writes row_data (extra fields preserved) and audits one-shot", async () => {
    const { ctx, store } = makeCtx({
      portal_lease_pipeline_records: [
        leaseRecord("manager_a", fullySignedLease("lease_v", { customField: "keep-me", bucket: "signed" })),
      ],
    });
    const res = await executeWrite(voidLeaseTool, ctx, { leaseId: "lease_v", reason: "Unit sold" });
    expect(res.ok).toBe(true);

    const record = store.tables.portal_lease_pipeline_records![0]!;
    const rowData = record.row_data as Row;
    expect(rowData.status).toBe("Voided");
    expect(typeof rowData.voidedAt).toBe("string");
    expect(rowData.customField).toBe("keep-me");
    expect(rowData.generatedHtml).toBe("<html>lease</html>");
    // Top-level status column mirrors the pipeline route (bucket first).
    expect(record.status).toBe("signed");
    const thread = rowData.thread as Row[];
    expect(String(thread.at(-1)!.body)).toContain("Unit sold");

    const audit = store.tables.audit_log ?? [];
    expect(audit).toHaveLength(1);
    expect(audit[0]!.dedupe_key).toBe("void_lease:manager_a:lease_v");
  });

  it("re-executing on an already-voided lease is a no-op already-done reply", async () => {
    const { ctx, store } = makeCtx({
      portal_lease_pipeline_records: [leaseRecord("manager_a", fullySignedLease("lease_v"))],
    });
    await executeWrite(voidLeaseTool, ctx, { leaseId: "lease_v" });
    const second = await executeWrite(voidLeaseTool, ctx, { leaseId: "lease_v" });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.reply).toContain("already voided");
    expect(store.tables.audit_log).toHaveLength(1);
  });
});

describe("send_lease_for_signature", () => {
  function draftLease(id: string, overrides: Row = {}): Row {
    return {
      id,
      residentName: "Casey Doe",
      residentEmail: "casey@example.com",
      unit: "12 Main · Room 1",
      bucket: "manager",
      thread: [],
      application: { leaseStart: "2026-01-01", leaseEnd: "2026-06-30" },
      generatedHtml: "<html>lease</html>",
      ...overrides,
    };
  }

  it("preview rejects a lease with no document", async () => {
    const { ctx } = makeCtx({
      portal_lease_pipeline_records: [
        leaseRecord("manager_a", draftLease("lease_s", { generatedHtml: null, managerUploadedPdf: null })),
      ],
    });
    const res = await previewWrite(sendLeaseForSignatureTool, ctx, { leaseId: "lease_s" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("no lease document yet");
  });

  it("preview rejects a finalized lease and a foreign lease", async () => {
    const { ctx } = makeCtx({
      portal_lease_pipeline_records: [
        leaseRecord("manager_a", fullySignedLease("lease_done")),
        leaseRecord("manager_b", draftLease("lease_foreign")),
      ],
    });
    const done = await previewWrite(sendLeaseForSignatureTool, ctx, { leaseId: "lease_done" });
    expect(done.ok).toBe(false);
    const foreign = await previewWrite(sendLeaseForSignatureTool, ctx, { leaseId: "lease_foreign" });
    expect(foreign.ok).toBe(false);
  });

  // The applicant half of that same gate. `sendForSignatureBlockerWithContext`
  // runs `leaseSendGateBlockerAmong` over the landlord's OWN applications, so a
  // lease whose applicant was never approved is refused through the tool layer
  // exactly as the Leases UI refuses it. Pinned here because the check is one
  // import away from disappearing while everything still compiles.
  it("preview and execute both refuse a lease whose application is still pending", async () => {
    const { ctx, store } = makeCtx({
      portal_lease_pipeline_records: [leaseRecord("manager_a", draftLease("lease_pending"))],
      manager_application_records: [
        {
          id: "app_pending",
          manager_user_id: "manager_a",
          row_data: { id: "AXIS-PENDING1", name: "Casey Doe", email: "casey@example.com", bucket: "pending" },
        },
      ],
    });

    const preview = await previewWrite(sendLeaseForSignatureTool, ctx, { leaseId: "lease_pending" });
    expect(preview.ok).toBe(false);
    if (!preview.ok) expect(preview.error).toMatch(/still pending review/i);

    const executed = await executeWrite(sendLeaseForSignatureTool, ctx, { leaseId: "lease_pending" });
    expect(executed.ok).toBe(false);

    const rowData = store.tables.portal_lease_pipeline_records![0]!.row_data as Row;
    expect(rowData.bucket).toBe("manager");
    expect(rowData.status).toBeUndefined();
    expect(store.tables.audit_log ?? []).toHaveLength(0);
    expect(deliverPortalInboxMessage).not.toHaveBeenCalled();
  });

  // The assistant reaches the same transition the Leases UI does, so it has to
  // clear the same gate: a machine reading of an uploaded contract that no
  // person has confirmed must not become signable through the tool layer.
  const IMPORT_SHA = "d".repeat(64);

  function importedLease(id: string, reviewStatus: "needs_review" | "confirmed"): Row {
    return draftLease(id, {
      generatedHtml: null,
      managerUploadedPdf: {
        dataUrl: "data:application/pdf;base64,JVBERi0xLjQK",
        originalDataUrl: "data:application/pdf;base64,JVBERi0xLjQK",
        fileName: "third-party-lease.pdf",
        uploadedAt: "2026-08-01T00:00:00.000Z",
      },
      uploadedLeaseParse: {
        ...buildUploadedLeaseParse({
          pages: ["1. RENT\nMonthly rent is $2,150.00."],
          fileName: "third-party-lease.pdf",
          sourceSha256: IMPORT_SHA,
          extractedAtIso: "2026-08-01T00:00:00.000Z",
        }),
        review:
          reviewStatus === "confirmed"
            ? { status: reviewStatus, confirmedDocumentSha256: IMPORT_SHA }
            : { status: reviewStatus },
      },
    });
  }

  it("preview and execute both refuse an imported lease no manager has confirmed", async () => {
    const { ctx, store } = makeCtx({
      portal_lease_pipeline_records: [leaseRecord("manager_a", importedLease("lease_import", "needs_review"))],
    });

    const preview = await previewWrite(sendLeaseForSignatureTool, ctx, { leaseId: "lease_import" });
    expect(preview.ok).toBe(false);
    if (!preview.ok) expect(preview.error).toContain("confirm it before sending");

    const executed = await executeWrite(sendLeaseForSignatureTool, ctx, { leaseId: "lease_import" });
    expect(executed.ok).toBe(false);

    const rowData = store.tables.portal_lease_pipeline_records![0]!.row_data as Row;
    expect(rowData.bucket).toBe("manager");
    expect(rowData.status).toBeUndefined();
    expect(store.tables.audit_log ?? []).toHaveLength(0);
    expect(deliverPortalInboxMessage).not.toHaveBeenCalled();
  });

  it("refuses a confirmation that is not bound to the document on the row", async () => {
    const forged = importedLease("lease_forged", "confirmed");
    (forged.uploadedLeaseParse as Row).review = { status: "confirmed", confirmedByName: "Forged" };
    const { ctx } = makeCtx({ portal_lease_pipeline_records: [leaseRecord("manager_a", forged)] });

    const preview = await previewWrite(sendLeaseForSignatureTool, ctx, { leaseId: "lease_forged" });

    expect(preview.ok).toBe(false);
    if (!preview.ok) expect(preview.error).toContain("confirm it before sending");
  });

  it("sends an imported lease once a manager has confirmed the reading", async () => {
    const { ctx, store } = makeCtx({
      portal_lease_pipeline_records: [leaseRecord("manager_a", importedLease("lease_import", "confirmed"))],
    });

    const res = await executeWrite(sendLeaseForSignatureTool, ctx, { leaseId: "lease_import" });

    expect(res.ok).toBe(true);
    const rowData = store.tables.portal_lease_pipeline_records![0]!.row_data as Row;
    expect(rowData.status).toBe("Resident Signature Pending");
  });

  it("execute moves the lease to the resident-signature stage and notifies the resident", async () => {
    const { ctx, store } = makeCtx({
      portal_lease_pipeline_records: [leaseRecord("manager_a", draftLease("lease_s"))],
    });
    const res = await executeWrite(sendLeaseForSignatureTool, ctx, { leaseId: "lease_s" });
    expect(res.ok).toBe(true);

    const record = store.tables.portal_lease_pipeline_records![0]!;
    const rowData = record.row_data as Row;
    expect(rowData.bucket).toBe("resident");
    expect(rowData.status).toBe("Resident Signature Pending");
    expect(rowData.currentActorRole).toBe("resident");
    expect(typeof rowData.sentToResidentAt).toBe("string");
    expect(record.status).toBe("resident");

    const audit = store.tables.audit_log ?? [];
    expect(audit).toHaveLength(1);
    expect(audit[0]!.dedupe_key).toBe(`send_lease_for_signature:manager_a:lease_s:${auditDayBucket()}`);

    expect(deliverPortalInboxMessage).toHaveBeenCalledTimes(1);
    const [, opts] = (deliverPortalInboxMessage as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(opts.toEmails).toEqual(["casey@example.com"]);
  });

  it("execute is idempotent per lease per day (no second notification)", async () => {
    const { ctx, store } = makeCtx({
      portal_lease_pipeline_records: [leaseRecord("manager_a", draftLease("lease_s"))],
    });
    await executeWrite(sendLeaseForSignatureTool, ctx, { leaseId: "lease_s" });
    const second = await executeWrite(sendLeaseForSignatureTool, ctx, { leaseId: "lease_s" });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.reply).toContain("already sent");
    expect(store.tables.audit_log).toHaveLength(1);
    expect(deliverPortalInboxMessage).toHaveBeenCalledTimes(1);
  });
});

describe("add_vendor", () => {
  it("preview rejects a duplicate vendor (same email) with a corrective message", async () => {
    const { ctx } = makeCtx({
      manager_vendor_records: [
        vendorRecord("manager_a", { id: "v1", name: "Ace Plumbing", trade: "plumbing", email: "ace@x.com", phone: "", notes: "", active: true }),
      ],
    });
    const res = await previewWrite(addVendorTool, ctx, { name: "Ace Co", trade: "hvac", email: "ace@x.com" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("already in the vendor directory");
  });

  it("execute inserts an owned, active directory row and audits with the email dedupe key", async () => {
    const { ctx, store } = makeCtx({ manager_vendor_records: [] });
    const res = await executeWrite(addVendorTool, ctx, {
      name: "Ace Plumbing",
      trade: "plumbing",
      email: "Ace@X.com",
      phone: "555-0100",
    });
    expect(res.ok).toBe(true);

    const rows = store.tables.manager_vendor_records!;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.manager_user_id).toBe("manager_a");
    const rowData = rows[0]!.row_data as Row;
    expect(rowData).toMatchObject({
      name: "Ace Plumbing",
      trade: "plumbing",
      email: "ace@x.com",
      phone: "555-0100",
      active: true,
      managerUserId: "manager_a",
    });
    expect(String(rowData.id)).toMatch(/^vendor-/);

    const audit = store.tables.audit_log ?? [];
    expect(audit).toHaveLength(1);
    expect(audit[0]!.dedupe_key).toBe("add_vendor:manager_a:ace@x.com");
  });

  it("execute short-circuits when the vendor already exists (no duplicate row)", async () => {
    const { ctx, store } = makeCtx({ manager_vendor_records: [] });
    await executeWrite(addVendorTool, ctx, { name: "Ace Plumbing", trade: "plumbing", email: "ace@x.com" });
    const second = await executeWrite(addVendorTool, ctx, { name: "Ace Plumbing", trade: "plumbing", email: "ace@x.com" });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.reply).toContain("already");
    expect(store.tables.manager_vendor_records).toHaveLength(1);
    expect(store.tables.audit_log).toHaveLength(1);
  });
});

describe("update_vendor", () => {
  const ownedVendor = () =>
    vendorRecord("manager_a", {
      id: "v1",
      name: "Ace Plumbing",
      trade: "plumbing",
      email: "ace@x.com",
      phone: "555-0100",
      notes: "old notes",
      active: true,
      // Fields outside the allowlist that must survive untouched.
      zelleContact: "555-pay",
      zellePaymentsEnabled: true,
      sharedWithManagers: true,
      vendorDocuments: [{ id: "doc1" }],
    });

  it("schema rejects fields outside the allowlist (payment contacts, sharing)", () => {
    expect(updateVendorTool.inputSchema.safeParse({ vendorId: "v1", zelleContact: "x" }).success).toBe(false);
    expect(updateVendorTool.inputSchema.safeParse({ vendorId: "v1", sharedWithManagers: false }).success).toBe(false);
    expect(updateVendorTool.inputSchema.safeParse({ vendorId: "v1", email: "a@b.co" }).success).toBe(false);
  });

  it("preview rejects a foreign vendor id and an empty patch", async () => {
    const { ctx } = makeCtx({
      manager_vendor_records: [vendorRecord("manager_b", { id: "v_foreign", name: "Other", trade: "hvac", email: "", phone: "", notes: "", active: true })],
    });
    const foreign = await previewWrite(updateVendorTool, ctx, { vendorId: "v_foreign", active: false });
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.error).toContain("list_vendors");

    const { ctx: ctx2 } = makeCtx({ manager_vendor_records: [ownedVendor()] });
    const empty = await previewWrite(updateVendorTool, ctx2, { vendorId: "v1" });
    expect(empty.ok).toBe(false);
  });

  it("preview shows an old → new diff for provided fields only", async () => {
    const { ctx } = makeCtx({ manager_vendor_records: [ownedVendor()] });
    const res = await previewWrite(updateVendorTool, ctx, { vendorId: "v1", active: false, notes: "new notes" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.preview.fields).toContainEqual({ label: "Status", value: "active → inactive" });
      expect(res.preview.fields).toContainEqual({ label: "Notes", value: "old notes → new notes" });
      expect(res.preview.fields).toHaveLength(2);
    }
  });

  it("execute merges only allowlisted fields and preserves payment/sharing data", async () => {
    const { ctx, store } = makeCtx({ manager_vendor_records: [ownedVendor()] });
    const res = await executeWrite(updateVendorTool, ctx, { vendorId: "v1", active: false, notes: "new notes" });
    expect(res.ok).toBe(true);

    const rowData = store.tables.manager_vendor_records![0]!.row_data as Row;
    expect(rowData.active).toBe(false);
    expect(rowData.notes).toBe("new notes");
    expect(rowData.trade).toBe("plumbing");
    expect(rowData.zelleContact).toBe("555-pay");
    expect(rowData.zellePaymentsEnabled).toBe(true);
    expect(rowData.sharedWithManagers).toBe(true);
    expect(rowData.vendorDocuments).toEqual([{ id: "doc1" }]);

    const audit = store.tables.audit_log ?? [];
    expect(audit).toHaveLength(1);
    expect(String(audit[0]!.dedupe_key)).toMatch(/^update_vendor:manager_a:v1:/);
  });

  it("execute dedupes the identical patch (already applied)", async () => {
    const { ctx, store } = makeCtx({ manager_vendor_records: [ownedVendor()] });
    await executeWrite(updateVendorTool, ctx, { vendorId: "v1", notes: "new notes" });
    const second = await executeWrite(updateVendorTool, ctx, { vendorId: "v1", notes: "new notes" });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.reply).toContain("already applied");
    expect(store.tables.audit_log).toHaveLength(1);
  });
});

describe("invite_vendor", () => {
  const invitableVendor = () =>
    vendorRecord("manager_a", {
      id: "v2",
      name: "Spark Electric",
      trade: "electrical",
      email: "Spark@X.com",
      phone: "",
      notes: "",
      active: true,
    });

  it("preview rejects a vendor without a valid email on file", async () => {
    const { ctx } = makeCtx({
      manager_vendor_records: [vendorRecord("manager_a", { id: "v3", name: "No Email Co", trade: "hvac", email: "", phone: "", notes: "", active: true })],
    });
    const res = await previewWrite(inviteVendorTool, ctx, { vendorId: "v3" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("email");
  });

  it("preview rejects a vendor that already has a linked account, and a foreign vendor", async () => {
    const { ctx } = makeCtx({
      manager_vendor_records: [
        vendorRecord("manager_a", { id: "v4", name: "Linked Co", trade: "hvac", email: "l@x.com", phone: "", notes: "", active: true }, "vendor_user_9"),
        vendorRecord("manager_b", { id: "v_foreign", name: "Other", trade: "hvac", email: "o@x.com", phone: "", notes: "", active: true }),
      ],
    });
    const linked = await previewWrite(inviteVendorTool, ctx, { vendorId: "v4" });
    expect(linked.ok).toBe(false);
    if (!linked.ok) expect(linked.error).toContain("already has a linked Axis account");
    const foreign = await previewWrite(inviteVendorTool, ctx, { vendorId: "v_foreign" });
    expect(foreign.ok).toBe(false);
  });

  it("execute sends the invite to the directory-row email (never model input) and audits one-shot", async () => {
    const { ctx, store } = makeCtx({
      manager_vendor_records: [invitableVendor()],
      profiles: [{ id: "manager_a", full_name: "Pat Manager", email: "manager@axis.test" }],
    });
    const res = await executeWrite(inviteVendorTool, ctx, { vendorId: "v2" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.reply).toContain("spark@x.com");

    expect(sendVendorInvite).toHaveBeenCalledTimes(1);
    const [, opts] = (sendVendorInvite as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(opts).toMatchObject({
      managerUserId: "manager_a",
      managerName: "Pat Manager",
      vendorId: "v2",
      vendorEmail: "spark@x.com",
      vendorName: "Spark Electric",
    });

    const audit = store.tables.audit_log ?? [];
    expect(audit).toHaveLength(1);
    expect(audit[0]!.dedupe_key).toBe("invite_vendor:manager_a:v2");
  });

  it("execute dedupes a repeat invite and never calls the invite pipeline again", async () => {
    const { ctx, store } = makeCtx({ manager_vendor_records: [invitableVendor()] });
    await executeWrite(inviteVendorTool, ctx, { vendorId: "v2" });
    const second = await executeWrite(inviteVendorTool, ctx, { vendorId: "v2" });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.reply).toContain("already invited");
    expect(sendVendorInvite).toHaveBeenCalledTimes(1);
    expect(store.tables.audit_log).toHaveLength(1);
  });

  it("execute refuses a foreign vendor id without touching the invite pipeline", async () => {
    const { ctx, store } = makeCtx({
      manager_vendor_records: [vendorRecord("manager_b", { id: "v_foreign", name: "Other", trade: "hvac", email: "o@x.com", phone: "", notes: "", active: true })],
    });
    const res = await executeWrite(inviteVendorTool, ctx, { vendorId: "v_foreign" });
    expect(res.ok).toBe(false);
    expect(sendVendorInvite).not.toHaveBeenCalled();
    expect(store.tables.audit_log ?? []).toHaveLength(0);
  });
});
