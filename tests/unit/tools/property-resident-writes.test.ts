import { randomBytes } from "node:crypto";
import { openApplicantRow } from "@/lib/security/applicant-identity";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { managerPropertyLimitMessage } from "@/lib/manager-access";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import type { AgentContext } from "@/lib/tools/context";
import { auditDayBucket } from "@/lib/tools/audit";
import { buildRegistry } from "@/lib/tools/registry";

// The share tool authorizes through getShareablePropertyForUser, which builds
// its own service-role client — stub it so tests stay in-memory. manager_a may
// share only "p1"; every other (userId, propertyId) pair is unshareable.
vi.mock("@/lib/manager-property-share-access", () => ({
  getShareablePropertyForUser: vi.fn(async (userId: string, propertyId: string) =>
    userId === "manager_a" && propertyId === "p1"
      ? { id: "p1", title: "Sunset Lofts", buildingName: "Sunset Lofts", address: "1 A St", adminPublishLive: true }
      : null,
  ),
}));

/**
 * The plan's listing cap is resolved from `manager_purchases` through a
 * service-role client. Stub only that read so these tests stay in-memory; the
 * slot COUNT below still runs for real against the seeded records.
 */
let EFFECTIVE_TIER: string | null = null;
vi.mock("@/lib/manager-access-server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/manager-access-server")>()),
  getEffectiveManagerSkuTier: async () => ({ ok: true, tier: EFFECTIVE_TIER }),
}));

import {
  createPropertyTool,
  updatePropertyTool,
  updatePropertyLeaseConfigTool,
  sharePropertyLinkTool,
  buildDraftPropertyRowData,
} from "@/lib/tools/domains/properties";
import {
  setResidentApprovalTool,
  sendResidentWelcomeTool,
  revokeResidentAccessTool,
  recordMoveOutTool,
} from "@/lib/tools/domains/residents";
import { updateApplicationBucketTool, orderBackgroundCheckTool } from "@/lib/tools/domains/applications";
import { executeWrite, previewWrite } from "./fake-agent-ctx";

type Row = Record<string, unknown>;
type WriteLogEntry = { table: string; values: Row; filters: [string, unknown][] };

/**
 * Write-capable stand-in for the service-role client (fake-agent-ctx's
 * FakeQuery is read-only). Applies eq/neq/in filters against seeded rows,
 * performs insert/update/upsert/delete in place, and models the partial UNIQUE
 * behavior of audit_log.dedupe_key (NULLs never collide) so the idempotency
 * paths are exercised end to end.
 */
function makeWriteCtx(tables: Record<string, Row[]>, overrides: Partial<AgentContext> = {}) {
  const log = {
    inserts: [] as WriteLogEntry[],
    updates: [] as WriteLogEntry[],
    upserts: [] as WriteLogEntry[],
    authDeletedUserIds: [] as string[],
  };

  class Q {
    private filters: [string, unknown][] = [];
    private mode: { kind: "select" } | { kind: "update"; values: Row } | { kind: "delete" } = { kind: "select" };
    constructor(private table: string) {}

    private countMode = false;

    select(_cols?: string, opts?: { count?: string; head?: boolean }) {
      if (opts?.count) this.countMode = true;
      return this;
    }
    order() {
      return this;
    }
    limit() {
      return this;
    }
    or() {
      // OR trees are not modeled; unmatched tables are simply left unseeded.
      return this;
    }
    in(col: string, vals: unknown[]) {
      this.filters.push([`in:${col}`, vals]);
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

    private matches(row: Row): boolean {
      return this.filters.every(([col, val]) => {
        if (col.startsWith("in:")) {
          const c = col.slice(3);
          return Array.isArray(val) && (val as unknown[]).includes(row[c]);
        }
        if (col.startsWith("!")) return row[col.slice(1)] !== val;
        if (!(col in row)) return true;
        return row[col] === val;
      });
    }

    private matched(): Row[] {
      return (tables[this.table] ?? []).filter((r) => this.matches(r));
    }

    private run(): Promise<{ data: Row[] | null; error: null }> {
      if (this.mode.kind === "update") {
        for (const row of this.matched()) Object.assign(row, this.mode.values);
        log.updates.push({ table: this.table, values: this.mode.values, filters: this.filters });
        return Promise.resolve({ data: null, error: null });
      }
      if (this.mode.kind === "delete") {
        tables[this.table] = (tables[this.table] ?? []).filter((r) => !this.matches(r));
        return Promise.resolve({ data: null, error: null });
      }
      return Promise.resolve({ data: this.matched(), error: null });
    }

    update(values: Row) {
      this.mode = { kind: "update", values };
      return this;
    }
    delete() {
      this.mode = { kind: "delete" };
      return this;
    }
    insert(values: Row) {
      if (this.table === "audit_log") {
        const key = values.dedupe_key;
        if (key != null && (tables.audit_log ?? []).some((r) => r.dedupe_key === key)) {
          return Promise.resolve({ error: { code: "23505", message: "duplicate key value" } });
        }
      }
      tables[this.table] = [...(tables[this.table] ?? []), { ...values }];
      log.inserts.push({ table: this.table, values, filters: [] });
      return Promise.resolve({ error: null });
    }
    upsert(values: Row) {
      const list = (tables[this.table] ??= []);
      const idx = list.findIndex((r) => r.id === values.id);
      if (idx >= 0) list[idx] = { ...list[idx], ...values };
      else list.push({ ...values });
      log.upserts.push({ table: this.table, values, filters: [] });
      return Promise.resolve({ error: null });
    }

    maybeSingle() {
      return this.run().then((res) => ({ data: (res.data ?? [])[0] ?? null, error: null }));
    }
    range(from: number, to: number) {
      return this.run().then((res) => ({ data: (res.data ?? []).slice(from, to + 1), error: null }));
    }
    then<T>(resolve: (v: { data: Row[] | null; count?: number; error: null }) => T) {
      if (this.countMode) {
        return Promise.resolve({ data: null, count: this.matched().length, error: null as null }).then(resolve);
      }
      return this.run().then(resolve);
    }
  }

  const db = {
    from(table: string) {
      return new Q(table);
    },
    auth: {
      admin: {
        listUsers: async () => ({ data: { users: [] }, error: null }),
        deleteUser: async (id: string) => {
          log.authDeletedUserIds.push(id);
          return { error: null };
        },
      },
    },
  };

  const ctx = {
    landlordId: "manager_a",
    userId: "manager_a",
    email: "manager@axis.test",
    roles: ["manager"],
    isAdmin: false,
    db,
    ...overrides,
  } as unknown as AgentContext;
  return { ctx, tables, log };
}

function auditRows(tables: Record<string, Row[]>): Row[] {
  return tables.audit_log ?? [];
}

const ENV_KEYS = ["RESEND_API_KEY", "CERTN_API_KEY", "CHECKR_API_KEY", "BACKGROUND_CHECK_API_KEY", "CHECKR_SIMULATE", "NEXT_PUBLIC_APP_URL"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.stubEnv("DATA_ENCRYPTION_ACTIVE_KEY_ID", "test");
  vi.stubEnv("DATA_ENCRYPTION_KEYS_JSON", JSON.stringify({ test: randomBytes(32).toString("base64") }));
  EFFECTIVE_TIER = null;
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// registry guard
// ---------------------------------------------------------------------------

describe("registry identity-field guard", () => {
  it("accepts every new tool (no identity fields in write input schemas)", () => {
    expect(() =>
      buildRegistry([
        createPropertyTool,
        updatePropertyTool,
        sharePropertyLinkTool,
        setResidentApprovalTool,
        sendResidentWelcomeTool,
        revokeResidentAccessTool,
        recordMoveOutTool,
        updateApplicationBucketTool,
        orderBackgroundCheckTool,
      ]),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// create_property
// ---------------------------------------------------------------------------

describe("create_property", () => {
  it("buildDraftPropertyRowData produces the pending-row shape", () => {
    const row = buildDraftPropertyRowData(
      { title: " Loft ", address: "9 Z St", beds: 3, baths: 1.5, rentUsd: 1800.4, description: "Nice" },
      "manager_a",
    );
    expect(row.id).toMatch(/^prop_\d+_[a-z0-9]+$/);
    expect(row).toMatchObject({
      buildingName: "Loft",
      address: "9 Z St",
      beds: 3,
      baths: 1.5,
      monthlyRent: 1800,
      tagline: "Nice",
      submittedByUserId: "manager_a",
      unitLabel: "New listing",
      petFriendly: false,
    });
  });

  it("preview discloses the pending admin-review status", async () => {
    const { ctx } = makeWriteCtx({});
    const res = await previewWrite(createPropertyTool, ctx, {
      title: "Loft",
      address: "9 Z St",
      beds: 3,
      baths: 1,
      rentUsd: 1800,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(JSON.stringify(res.preview.fields)).toContain("admin");
    expect(res.preview.fields.some((l) => l.value.includes("$1800/mo"))).toBe(true);
  });

  it("execute inserts a landlord-scoped pending record and audits with the address+day dedupe key", async () => {
    const { ctx, tables } = makeWriteCtx({});
    const res = await executeWrite(createPropertyTool, ctx, {
      title: "Loft",
      address: "9  Z St",
      beds: 3,
      baths: 1,
      rentUsd: 1800,
    });
    expect(res.ok).toBe(true);

    const inserted = tables.manager_property_records?.[0];
    expect(inserted).toMatchObject({ manager_user_id: "manager_a", status: "pending" });
    expect((inserted?.row_data as Row).buildingName).toBe("Loft");

    const audit = auditRows(tables)[0];
    expect(audit?.dedupe_key).toBe(`create_property:manager_a:9 z st:${auditDayBucket()}`);
    expect(audit?.landlord_id).toBe("manager_a");
  });

  it("execute is idempotent per address per day", async () => {
    const { ctx, tables } = makeWriteCtx({});
    const input = { title: "Loft", address: "9 Z St", beds: 3, baths: 1, rentUsd: 1800 };
    await executeWrite(createPropertyTool, ctx, input);
    const second = await executeWrite(createPropertyTool, ctx, input);
    expect(second).toMatchObject({ ok: true });
    if (second.ok) expect(second.reply).toContain("already");
    expect(tables.manager_property_records).toHaveLength(1);
  });
});

/**
 * Regression: agent-create-property-bypasses-quota.
 *
 * The other half of the same bypass as `agent-relist-bypasses-quota` below:
 * this tool inserts `manager_property_records` with status "pending", which IS
 * a listing slot, and never passes through `POST /api/property-records` where
 * the cap lives. So a Free manager whose "+ Add property" button is disabled
 * could just ask the assistant to create the listing instead.
 */
describe("create_property respects the plan's listing cap", () => {
  const draft = { title: "Loft", address: "9 Z St", beds: 3, baths: 1, rentUsd: 1800 };

  it("refuses a create that would take a second listing slot on Free", async () => {
    EFFECTIVE_TIER = "free";
    const { ctx, tables } = makeWriteCtx({
      manager_property_records: [liveProperty("manager_a", "p_live")],
    });

    const res = await executeWrite(createPropertyTool, ctx, draft);

    expect(res.ok).toBe(false);
    // The manager reads the same sentence the portal shows, not a bare failure.
    if (!res.ok) expect(res.error).toBe(managerPropertyLimitMessage("free"));
    // Nothing was inserted, and the refusal did not burn the dedupe key.
    expect(tables.manager_property_records).toHaveLength(1);
    expect(auditRows(tables)).toEqual([]);
  });

  it("allows the create while the manager is still under the cap", async () => {
    EFFECTIVE_TIER = "free";
    const { ctx, tables } = makeWriteCtx({ manager_property_records: [] });

    const res = await executeWrite(createPropertyTool, ctx, draft);

    expect(res.ok).toBe(true);
    expect(tables.manager_property_records).toHaveLength(1);
    expect(tables.manager_property_records![0]).toMatchObject({ status: "pending" });
  });

  it("does not count another manager's listings against this one", async () => {
    EFFECTIVE_TIER = "free";
    const { ctx, tables } = makeWriteCtx({
      manager_property_records: [liveProperty("manager_b", "p_other")],
    });

    const res = await executeWrite(createPropertyTool, ctx, draft);

    expect(res.ok).toBe(true);
    expect(tables.manager_property_records).toHaveLength(2);
  });

  it("leaves a landlord with no numeric cap unaffected", async () => {
    EFFECTIVE_TIER = null;
    const { ctx, tables } = makeWriteCtx({
      manager_property_records: Array.from({ length: 12 }, (_, i) => liveProperty("manager_a", `p_live_${i}`)),
    });

    const res = await executeWrite(createPropertyTool, ctx, draft);

    expect(res.ok).toBe(true);
    expect(tables.manager_property_records).toHaveLength(13);
  });
});

// ---------------------------------------------------------------------------
// update_property
// ---------------------------------------------------------------------------

function liveProperty(managerUserId: string, id: string): Row {
  return {
    id,
    manager_user_id: managerUserId,
    status: "live",
    row_data: { id, buildingName: "Sunset Lofts", monthlyRent: 2000, beds: 2, baths: 1, tagline: "Old" },
    property_data: {
      id,
      title: "Sunset Lofts",
      buildingName: "Sunset Lofts",
      address: "1 A St",
      zip: "98101",
      neighborhood: "Fremont",
      beds: 2,
      baths: 1,
      rentLabel: "$2,000/mo",
      unitLabel: "Unit A",
      petFriendly: false,
      tagline: "Old",
      adminPublishLive: true,
    },
  };
}

describe("update_property", () => {
  it("preview rejects a foreign property id", async () => {
    const { ctx } = makeWriteCtx({ manager_property_records: [liveProperty("manager_b", "p_foreign")] });
    const res = await previewWrite(updatePropertyTool, ctx, { propertyId: "p_foreign", rentUsd: 100 });
    expect(res).toMatchObject({ ok: false });
    if (!res.ok) expect(res.error).toContain("list_properties");
  });

  it("preview refuses pending → live (admin review required)", async () => {
    const { ctx } = makeWriteCtx({
      manager_property_records: [
        { id: "p2", manager_user_id: "manager_a", status: "pending", row_data: { buildingName: "Draft" }, property_data: null },
      ],
    });
    const res = await previewWrite(updatePropertyTool, ctx, { propertyId: "p2", status: "live" });
    expect(res).toMatchObject({ ok: false });
    if (!res.ok) expect(res.error.toLowerCase()).toContain("admin review");
  });

  it("preview shows a field diff for owned live listings", async () => {
    const { ctx } = makeWriteCtx({ manager_property_records: [liveProperty("manager_a", "p1")] });
    const res = await previewWrite(updatePropertyTool, ctx, { propertyId: "p1", rentUsd: 2200 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const rentLine = res.preview.fields.find((l) => l.label === "Monthly rent");
    expect(rentLine?.value).toBe("$2,000/mo → $2,200/mo");
  });

  it("execute read-merge-writes BOTH payloads and audits with the patch-hash dedupe key", async () => {
    const { ctx, tables } = makeWriteCtx({ manager_property_records: [liveProperty("manager_a", "p1")] });
    const res = await executeWrite(updatePropertyTool, ctx, { propertyId: "p1", rentUsd: 2200, description: "New tagline" });
    expect(res.ok).toBe(true);

    const rec = tables.manager_property_records![0]!;
    expect((rec.row_data as Row).monthlyRent).toBe(2200);
    expect((rec.row_data as Row).tagline).toBe("New tagline");
    expect((rec.row_data as Row).buildingName).toBe("Sunset Lofts"); // merged, not rebuilt
    expect((rec.property_data as Row).rentLabel).toBe("$2,200/mo");
    expect((rec.property_data as Row).tagline).toBe("New tagline");
    expect((rec.property_data as Row).address).toBe("1 A St");
    expect(rec.status).toBe("live");

    const audit = auditRows(tables)[0]!;
    expect(String(audit.dedupe_key)).toMatch(/^update_property:manager_a:p1:[a-z0-9]+$/);
    // Repeating the exact same patch is a no-op.
    const again = await executeWrite(updatePropertyTool, ctx, { propertyId: "p1", rentUsd: 2200, description: "New tagline" });
    expect(again).toMatchObject({ ok: true });
    if (again.ok) expect(again.reply).toContain("already");
  });

  it("execute unlists a live listing, synthesizing the admin-row payload", async () => {
    const { ctx, tables } = makeWriteCtx({ manager_property_records: [liveProperty("manager_a", "p1")] });
    const res = await executeWrite(updatePropertyTool, ctx, { propertyId: "p1", status: "unlisted" });
    expect(res.ok).toBe(true);
    const rec = tables.manager_property_records![0]!;
    expect(rec.status).toBe("unlisted");
    expect(rec.row_data as Row).toMatchObject({ adminRefId: "p1", buildingName: "Sunset Lofts", monthlyRent: 2000 });
    // relisting flips it back and keeps the published payload live-approved
    const relist = await executeWrite(updatePropertyTool, ctx, { propertyId: "p1", status: "live" });
    expect(relist.ok).toBe(true);
    expect(rec.status).toBe("live");
    expect((rec.property_data as Row).adminPublishLive).toBe(true);
  });

  it("execute never matches another landlord's record", async () => {
    const { ctx, tables } = makeWriteCtx({ manager_property_records: [liveProperty("manager_b", "p_foreign")] });
    const res = await executeWrite(updatePropertyTool, ctx, { propertyId: "p_foreign", rentUsd: 1 });
    expect(res.ok).toBe(false);
    expect(tables.manager_property_records![0]!.row_data).toMatchObject({ monthlyRent: 2000 });
  });
});

/**
 * Regression: agent-relist-bypasses-quota.
 *
 * The plan's property cap is enforced in `POST /api/property-records`, but this
 * tool writes `manager_property_records` itself and never goes near that route.
 * So a Free manager at their limit could unlist one listing, publish another,
 * and ask the assistant to "set the first one live again" — the exact action the
 * portal's Relist button refuses.
 */
describe("update_property respects the plan's listing cap", () => {
  function unlistedProperty(managerUserId: string, id: string): Row {
    return { ...liveProperty(managerUserId, id), status: "unlisted" };
  }

  it("refuses a relist that would take a second listing slot on Free", async () => {
    EFFECTIVE_TIER = "free";
    const { ctx, tables } = makeWriteCtx({
      manager_property_records: [unlistedProperty("manager_a", "p_down"), liveProperty("manager_a", "p_live")],
    });

    const res = await executeWrite(updatePropertyTool, ctx, { propertyId: "p_down", status: "live" });

    expect(res.ok).toBe(false);
    // The manager reads the same sentence the portal shows, not a bare failure.
    if (!res.ok) expect(res.error).toBe(managerPropertyLimitMessage("free"));
    // Nothing moved, and the refusal did not burn the dedupe key.
    expect(tables.manager_property_records![0]!.status).toBe("unlisted");
    expect(auditRows(tables)).toEqual([]);
  });

  it("allows the relist once the slot is free again", async () => {
    EFFECTIVE_TIER = "free";
    const { ctx, tables } = makeWriteCtx({
      manager_property_records: [unlistedProperty("manager_a", "p_down")],
    });

    const res = await executeWrite(updatePropertyTool, ctx, { propertyId: "p_down", status: "live" });

    expect(res.ok).toBe(true);
    expect(tables.manager_property_records![0]!.status).toBe("live");
  });

  it("never charges an over-limit account for an ordinary edit or an unlist", async () => {
    // Block the transition INTO a slot, never the state of being over the cap.
    EFFECTIVE_TIER = "free";
    const { ctx, tables } = makeWriteCtx({
      manager_property_records: [liveProperty("manager_a", "p1"), liveProperty("manager_a", "p2")],
    });

    const edit = await executeWrite(updatePropertyTool, ctx, { propertyId: "p1", rentUsd: 2400 });
    const unlist = await executeWrite(updatePropertyTool, ctx, { propertyId: "p2", status: "unlisted" });

    expect(edit.ok).toBe(true);
    expect(unlist.ok).toBe(true);
    expect((tables.manager_property_records![0]!.row_data as Row).monthlyRent).toBe(2400);
    expect(tables.manager_property_records![1]!.status).toBe("unlisted");
  });

  it("leaves a landlord with no numeric cap unaffected", async () => {
    EFFECTIVE_TIER = null;
    const { ctx, tables } = makeWriteCtx({
      manager_property_records: [
        unlistedProperty("manager_a", "p_down"),
        ...Array.from({ length: 12 }, (_, i) => liveProperty("manager_a", `p_live_${i}`)),
      ],
    });

    const res = await executeWrite(updatePropertyTool, ctx, { propertyId: "p_down", status: "live" });

    expect(res.ok).toBe(true);
    expect(tables.manager_property_records![0]!.status).toBe("live");
  });
});

// ---------------------------------------------------------------------------
// update_property_lease_config
// ---------------------------------------------------------------------------

function livePropertyWithLeaseSubmission(managerUserId: string, id: string): Row {
  const rec = liveProperty(managerUserId, id);
  const submission = {
    ...createDefaultListingSubmission(),
    buildingName: "Sunset Lofts",
    address: "1 A St",
    zip: "98101",
    leaseConfigMode: "standard" as const,
    leaseCustomKind: "terms" as const,
    customLeaseTerms: "",
    tagline: "Old",
  };
  return {
    ...rec,
    property_data: { ...(rec.property_data as Row), listingSubmission: submission },
  };
}

describe("update_property_lease_config", () => {
  it("preview requires custom terms when switching to custom_comments", async () => {
    const { ctx } = makeWriteCtx({ manager_property_records: [livePropertyWithLeaseSubmission("manager_a", "p1")] });
    const res = await previewWrite(updatePropertyLeaseConfigTool, ctx, {
      propertyId: "p1",
      leaseSource: "custom_comments",
    });
    expect(res.ok).toBe(false);
  });

  it("execute merges custom lease terms into listingSubmission", async () => {
    const { ctx, tables } = makeWriteCtx({
      manager_property_records: [livePropertyWithLeaseSubmission("manager_a", "p1")],
    });
    const res = await executeWrite(updatePropertyLeaseConfigTool, ctx, {
      propertyId: "p1",
      leaseSource: "custom_comments",
      customLeaseTerms: "No smoking indoors.",
    });
    expect(res.ok, res.ok ? "" : (res as { error?: string }).error).toBe(true);
    const sub = (tables.manager_property_records![0]!.property_data as Row).listingSubmission as Row;
    expect(sub.customLeaseTerms).toBe("No smoking indoors.");
    expect(auditRows(tables)[0]!.dedupe_key).toMatch(/^update_property_lease_config:manager_a:p1:/);
  });
});

// ---------------------------------------------------------------------------
// share_property_link
// ---------------------------------------------------------------------------

describe("share_property_link", () => {
  const managerProfile: Row = { id: "manager_a", role: "manager", email: "manager@axis.test" };

  it("preview rejects an unshareable/foreign property", async () => {
    const { ctx } = makeWriteCtx({ profiles: [managerProfile] });
    const res = await previewWrite(sharePropertyLinkTool, ctx, { kind: "apply", propertyId: "p_foreign", toEmail: "lead@x.com" });
    expect(res).toMatchObject({ ok: false });
    if (!res.ok) expect(res.error).toContain("live listings");
  });

  it("preview normalizes the email and discloses email-delivery configuration honestly", async () => {
    const { ctx } = makeWriteCtx({ profiles: [managerProfile] });
    const res = await previewWrite(sharePropertyLinkTool, ctx, { kind: "apply", propertyId: "p1", toEmail: " Lead@X.com " });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect((res.input as { toEmail: string }).toEmail).toBe("lead@x.com");
    const delivery = res.preview.fields.find((l) => l.label === "Email delivery");
    expect(delivery?.value).toContain("NOT configured");
    expect(res.preview.fields.find((l) => l.label === "Link")?.value).toContain("http");
  });

  it("execute without Resend returns the link honestly and audits with the day-bucketed dedupe key", async () => {
    const { ctx, tables } = makeWriteCtx({ profiles: [managerProfile] });
    const res = await executeWrite(sharePropertyLinkTool, ctx, { kind: "apply", propertyId: "p1", toEmail: "lead@x.com" });
    expect(res).toMatchObject({ ok: true });
    if (res.ok) {
      expect(res.reply).toContain("isn't configured");
      expect(res.reply).toContain("http");
    }
    const audit = auditRows(tables)[0]!;
    expect(audit.dedupe_key).toBe(`share_property_link:manager_a:p1:lead@x.com:apply:${auditDayBucket()}`);

    const second = await executeWrite(sharePropertyLinkTool, ctx, { kind: "apply", propertyId: "p1", toEmail: "lead@x.com" });
    expect(second).toMatchObject({ ok: true });
    if (second.ok) expect(second.reply).toContain("already");
    expect(auditRows(tables)).toHaveLength(1);
  });

  it("execute emails through Resend when configured", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ id: "email_1" }), { status: 200 }));
    const { ctx, tables } = makeWriteCtx({ profiles: [managerProfile] });
    const res = await executeWrite(sharePropertyLinkTool, ctx, { kind: "tour", propertyId: "p1", toEmail: "lead@x.com" });
    expect(res).toMatchObject({ ok: true });
    if (res.ok) expect(res.reply).toContain("Emailed");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const audit = auditRows(tables)[0]!;
    expect((audit.result_summary as Row).delivery).toBe("emailed");
  });

  it("execute refuses a property the landlord cannot share", async () => {
    const { ctx, tables } = makeWriteCtx({ profiles: [managerProfile] });
    const res = await executeWrite(sharePropertyLinkTool, ctx, { kind: "apply", propertyId: "p_foreign", toEmail: "lead@x.com" });
    expect(res).toMatchObject({ ok: false });
    expect(auditRows(tables)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// set_resident_approval
// ---------------------------------------------------------------------------

function residentSeed() {
  return {
    manager_application_records: [
      {
        id: "app_1",
        manager_user_id: "manager_a",
        resident_email: "t@x.com",
        row_data: {
          id: "app_1",
          name: "Ten Ant",
          email: "t@x.com",
          property: "12 Main",
          stage: "Submitted",
          bucket: "pending" as const,
          application: { ssn: "123-45-6789", leaseStart: "2026-08-01", leaseEnd: "2027-07-31", consentCredit: true },
        },
      },
      {
        id: "app_foreign",
        manager_user_id: "manager_b",
        resident_email: "other@x.com",
        row_data: { id: "app_foreign", name: "Other", email: "other@x.com", bucket: "pending" as const },
      },
    ],
    profiles: [
      { id: "u1", role: "resident", email: "t@x.com", full_name: "Ten Ant", application_approved: false },
      { id: "u2", role: "resident", email: "other@x.com", full_name: "Other", application_approved: true },
      { id: "manager_a", role: "manager", email: "manager@axis.test" },
    ],
    profile_roles: [{ user_id: "u1", role: "resident" }],
  };
}

describe("set_resident_approval", () => {
  it("preview rejects a resident outside the landlord's portfolio", async () => {
    const { ctx } = makeWriteCtx(residentSeed());
    const res = await previewWrite(setResidentApprovalTool, ctx, { residentEmail: "other@x.com", approved: false });
    expect(res).toMatchObject({ ok: false });
    if (!res.ok) expect(res.error).toContain("portfolio");
  });

  it("preview shows the from→to transition and portal-access effect", async () => {
    const { ctx } = makeWriteCtx(residentSeed());
    const res = await previewWrite(setResidentApprovalTool, ctx, { residentEmail: "T@X.com", approved: true });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.preview.fields.find((l) => l.label === "Approval")?.value).toBe("Not approved → Approved");
    expect(res.preview.fields.find((l) => l.label === "Effect")?.value).toContain("on");
  });

  it("execute updates the resident profile and audits with the email+value dedupe key", async () => {
    const { ctx, tables, log } = makeWriteCtx(residentSeed());
    const res = await executeWrite(setResidentApprovalTool, ctx, { residentEmail: "t@x.com", approved: true });
    expect(res).toMatchObject({ ok: true });

    const profile = tables.profiles!.find((p) => p.id === "u1")!;
    expect(profile.application_approved).toBe(true);
    const profileUpdate = log.updates.find((u) => u.table === "profiles");
    expect(profileUpdate?.filters).toEqual(
      expect.arrayContaining([
        ["role", "resident"],
        ["email", "t@x.com"],
      ]),
    );

    expect(auditRows(tables)[0]!.dedupe_key).toBe("set_resident_approval:manager_a:t@x.com:true");

    const second = await executeWrite(setResidentApprovalTool, ctx, { residentEmail: "t@x.com", approved: true });
    expect(second).toMatchObject({ ok: true });
    if (second.ok) expect(second.reply).toContain("already");
  });

  it("execute refuses (and does not touch profiles) for a foreign resident", async () => {
    const { ctx, tables, log } = makeWriteCtx(residentSeed());
    const res = await executeWrite(setResidentApprovalTool, ctx, { residentEmail: "other@x.com", approved: false });
    expect(res).toMatchObject({ ok: false });
    expect(tables.profiles!.find((p) => p.id === "u2")!.application_approved).toBe(true);
    expect(log.updates.filter((u) => u.table === "profiles")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// send_resident_welcome
// ---------------------------------------------------------------------------

describe("send_resident_welcome", () => {
  it("preview rejects a foreign application id", async () => {
    const { ctx } = makeWriteCtx(residentSeed());
    const res = await previewWrite(sendResidentWelcomeTool, ctx, { applicationId: "app_foreign" });
    expect(res).toMatchObject({ ok: false });
  });

  it("preview returns an honest error when email delivery is not configured", async () => {
    const { ctx } = makeWriteCtx(residentSeed());
    const res = await previewWrite(sendResidentWelcomeTool, ctx, { applicationId: "app_1" });
    expect(res).toMatchObject({ ok: false });
    if (!res.ok) expect(res.error).toContain("not configured");
  });

  it("execute resolves recipient + Axis ID server-side and records the send", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ id: "email_1" }), { status: 200 }));
    const { ctx, tables, log } = makeWriteCtx(residentSeed());
    const res = await executeWrite(sendResidentWelcomeTool, ctx, { applicationId: "app_1" });
    expect(res).toMatchObject({ ok: true });
    if (res.ok) {
      expect(res.reply).toContain("t@x.com");
      expect(res.reply).toContain("PROPLANE-");
    }
    expect(auditRows(tables)[0]!.dedupe_key).toBe(`send_resident_welcome:manager_a:app_1:${auditDayBucket()}`);
    // The manager's Sent inbox record was written.
    expect(log.upserts.some((u) => u.table === "portal_inbox_thread_records")).toBe(true);

    const second = await executeWrite(sendResidentWelcomeTool, ctx, { applicationId: "app_1" });
    expect(second).toMatchObject({ ok: true });
    if (second.ok) expect(second.reply).toContain("already");
  });
});

// ---------------------------------------------------------------------------
// revoke_resident_access
// ---------------------------------------------------------------------------

describe("revoke_resident_access", () => {
  it("is a destructive tool with a preview warning describing what is removed", async () => {
    expect(revokeResidentAccessTool.destructive).toBe(true);
    const { ctx } = makeWriteCtx(residentSeed());
    const res = await previewWrite(revokeResidentAccessTool, ctx, { residentEmail: "t@x.com" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.preview.warnings?.[0]).toContain("permanently");
    expect(res.preview.warnings?.[0]).toContain("NOT deleted");
  });

  it("preview rejects a resident outside the landlord's portfolio", async () => {
    const { ctx } = makeWriteCtx(residentSeed());
    const res = await previewWrite(revokeResidentAccessTool, ctx, { residentEmail: "other@x.com" });
    expect(res).toMatchObject({ ok: false });
  });

  it("execute removes the login, audits one-shot, and is idempotent forever", async () => {
    const { ctx, tables, log } = makeWriteCtx(residentSeed());
    const res = await executeWrite(revokeResidentAccessTool, ctx, { residentEmail: "t@x.com" });
    expect(res).toMatchObject({ ok: true });
    // Resident-only role → the auth user is deleted entirely.
    expect(log.authDeletedUserIds).toEqual(["u1"]);
    expect(auditRows(tables)[0]!.dedupe_key).toBe("revoke_resident_access:manager_a:t@x.com");

    const second = await executeWrite(revokeResidentAccessTool, ctx, { residentEmail: "t@x.com" });
    expect(second).toMatchObject({ ok: true });
    if (second.ok) expect(second.reply).toContain("already");
    expect(log.authDeletedUserIds).toHaveLength(1);
  });

  it("execute refuses a foreign resident without touching anything", async () => {
    const { ctx, tables, log } = makeWriteCtx(residentSeed());
    const res = await executeWrite(revokeResidentAccessTool, ctx, { residentEmail: "other@x.com" });
    expect(res).toMatchObject({ ok: false });
    expect(log.authDeletedUserIds).toHaveLength(0);
    // Intent was recorded then stamped failed with the dedupe key cleared.
    expect(auditRows(tables)[0]!.dedupe_key).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// record_move_out
// ---------------------------------------------------------------------------

describe("record_move_out", () => {
  it("preview warns that it does not amend a signed lease and rejects foreign ids", async () => {
    const { ctx } = makeWriteCtx(residentSeed());
    const ok = await previewWrite(recordMoveOutTool, ctx, { applicationId: "app_1", moveOutDate: "2026-09-30" });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.preview.warnings?.[0]).toContain("amend_lease");

    const foreign = await previewWrite(recordMoveOutTool, ctx, { applicationId: "app_foreign", moveOutDate: "2026-09-30" });
    expect(foreign).toMatchObject({ ok: false });
  });

  it("rejects malformed dates via the schema", () => {
    const parsed = recordMoveOutTool.inputSchema.safeParse({ applicationId: "app_1", moveOutDate: "Sept 30" });
    expect(parsed.success).toBe(false);
  });

  it("execute read-merge-writes the exact lease-amendment fields and audits", async () => {
    const { ctx, tables } = makeWriteCtx(residentSeed());
    const res = await executeWrite(recordMoveOutTool, ctx, { applicationId: "app_1", moveOutDate: "2026-09-30" });
    expect(res).toMatchObject({ ok: true });

    const rowData = tables.manager_application_records![0]!.row_data as Row;
    expect((rowData.application as Row).leaseEnd).toBe("2026-09-30");
    expect((rowData.manualResidentDetails as Row).moveOutDate).toBe("2026-09-30");
    // Merge, never rebuild: unrelated application answers survive untouched.
    expect((rowData.application as Row).leaseStart).toBe("2026-08-01");
    expect((rowData.application as Row).ssn).toBeUndefined();
    expect(openApplicantRow(rowData, "app_1").application?.ssn).toBe("123-45-6789");
    expect(rowData.name).toBe("Ten Ant");

    expect(auditRows(tables)[0]!.dedupe_key).toBe("record_move_out:manager_a:app_1:2026-09-30");

    const second = await executeWrite(recordMoveOutTool, ctx, { applicationId: "app_1", moveOutDate: "2026-09-30" });
    expect(second).toMatchObject({ ok: true });
    if (second.ok) expect(second.reply).toContain("already");
  });

  it("execute never touches a foreign application", async () => {
    const { ctx, tables } = makeWriteCtx(residentSeed());
    const res = await executeWrite(recordMoveOutTool, ctx, { applicationId: "app_foreign", moveOutDate: "2026-09-30" });
    expect(res).toMatchObject({ ok: false });
    const foreignRow = tables.manager_application_records![1]!.row_data as Row;
    expect(foreignRow.manualResidentDetails).toBeUndefined();
    expect(auditRows(tables)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// update_application_bucket
// ---------------------------------------------------------------------------

describe("update_application_bucket", () => {
  it("preview rejects foreign ids and same-bucket no-ops", async () => {
    const { ctx } = makeWriteCtx(residentSeed());
    const foreign = await previewWrite(updateApplicationBucketTool, ctx, { applicationId: "app_foreign", bucket: "approved" });
    expect(foreign).toMatchObject({ ok: false });

    const noop = await previewWrite(updateApplicationBucketTool, ctx, { applicationId: "app_1", bucket: "pending" });
    expect(noop).toMatchObject({ ok: false });
  });

  it("has no waitlist bucket", () => {
    expect(updateApplicationBucketTool.inputSchema.safeParse({ applicationId: "a", bucket: "waitlist" }).success).toBe(false);
  });

  it("preview notes the portal-access side effect on approval", async () => {
    const { ctx } = makeWriteCtx(residentSeed());
    const res = await previewWrite(updateApplicationBucketTool, ctx, { applicationId: "app_1", bucket: "approved" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const side = res.preview.fields.find((l) => l.label === "Side effect");
    expect(side?.value).toContain("turned on");
  });

  it("execute sets bucket + UI stage label, syncs profile approval, and audits", async () => {
    const { ctx, tables, log } = makeWriteCtx(residentSeed());
    const res = await executeWrite(updateApplicationBucketTool, ctx, { applicationId: "app_1", bucket: "approved" });
    expect(res).toMatchObject({ ok: true });

    const rowData = tables.manager_application_records![0]!.row_data as Row;
    expect(rowData.bucket).toBe("approved");
    expect(rowData.stage).toBe("Approved"); // matches stageLabelForApplicationBucket
    expect(rowData.managerUserId).toBe("manager_a");
    expect((rowData.application as Row).ssn).toBeUndefined();
    expect(openApplicantRow(rowData, "app_1").application?.ssn).toBe("123-45-6789"); // merged, not rebuilt

    // The resident's profiles.application_approved flag was synced on.
    expect(tables.profiles!.find((p) => p.id === "u1")!.application_approved).toBe(true);
    expect(log.updates.some((u) => u.table === "profiles")).toBe(true);

    expect(auditRows(tables)[0]!.dedupe_key).toBe("update_application_bucket:manager_a:app_1:approved");

    const second = await executeWrite(updateApplicationBucketTool, ctx, { applicationId: "app_1", bucket: "approved" });
    expect(second).toMatchObject({ ok: true });
    if (second.ok) expect(second.reply).toContain("already");
  });

  it("execute never moves a foreign application", async () => {
    const { ctx, tables } = makeWriteCtx(residentSeed());
    const res = await executeWrite(updateApplicationBucketTool, ctx, { applicationId: "app_foreign", bucket: "approved" });
    expect(res).toMatchObject({ ok: false });
    expect((tables.manager_application_records![1]!.row_data as Row).bucket).toBe("pending");
    expect(auditRows(tables)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// order_background_check
// ---------------------------------------------------------------------------

describe("order_background_check", () => {
  it("preview returns an honest error when no screening provider is configured", async () => {
    const { ctx } = makeWriteCtx(residentSeed());
    const res = await previewWrite(orderBackgroundCheckTool, ctx, { applicationId: "app_1" });
    expect(res).toMatchObject({ ok: false });
    if (!res.ok) expect(res.error).toContain("not configured");
  });

  it("preview rejects an explicitly requested unconfigured provider", async () => {
    process.env.CERTN_API_KEY = "certn_test";
    const { ctx } = makeWriteCtx(residentSeed());
    const res = await previewWrite(orderBackgroundCheckTool, ctx, { applicationId: "app_1", provider: "checkr" });
    expect(res).toMatchObject({ ok: false });
    if (!res.ok) expect(res.error).toContain("CHECKR_API_KEY");
  });

  it("preview rejects foreign ids even when configured", async () => {
    process.env.CERTN_API_KEY = "certn_test";
    const { ctx } = makeWriteCtx(residentSeed());
    const res = await previewWrite(orderBackgroundCheckTool, ctx, { applicationId: "app_foreign", provider: "certn" });
    expect(res).toMatchObject({ ok: false });
    if (!res.ok) expect(res.error).toContain("list_applications");
  });

  it("preview shows applicant, provider, cost warning, and consent when configured", async () => {
    process.env.CERTN_API_KEY = "certn_test";
    const { ctx } = makeWriteCtx(residentSeed());
    const res = await previewWrite(orderBackgroundCheckTool, ctx, { applicationId: "app_1", provider: "certn" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.preview.fields.find((l) => l.label === "Provider")?.value).toBe("certn");
    expect(res.preview.fields.find((l) => l.label === "Consent on file")?.value).toBe("Yes");
    expect(res.preview.warnings?.[0]).toContain("$");
  });

  it("preview refuses when the applicant did not consent", async () => {
    process.env.CERTN_API_KEY = "certn_test";
    const seed = residentSeed();
    (seed.manager_application_records[0]!.row_data as { application: Row }).application.consentCredit = false;
    const { ctx } = makeWriteCtx(seed);
    const res = await previewWrite(orderBackgroundCheckTool, ctx, { applicationId: "app_1", provider: "certn" });
    expect(res).toMatchObject({ ok: false });
    if (!res.ok) expect(res.error).toContain("authorize");
  });

  it("execute refuses a foreign application before ordering or auditing anything", async () => {
    process.env.CERTN_API_KEY = "certn_test";
    const { ctx, tables } = makeWriteCtx(residentSeed());
    const res = await executeWrite(orderBackgroundCheckTool, ctx, { applicationId: "app_foreign", provider: "certn" });
    expect(res).toMatchObject({ ok: false });
    expect(auditRows(tables)).toHaveLength(0);
  });
});

/**
 * Reviewer-facing transcript of the assistant path, so the plan cap can be read
 * rather than inferred from assertions. Set `PROPERTY_LIMIT_EVIDENCE_DIR` to
 * write it to that directory; the assertions run either way.
 */
describe("assistant transcript at the plan's listing cap", () => {
  it("answers create_property and the relist with the portal's own sentence", async () => {
    const lines: string[] = [];
    const say = (text = "") => lines.push(text);

    say("=".repeat(78));
    say("assistant write tools — real handlers, real plan quota");
    say("=".repeat(78));
    say();
    say('Manager on Free (1 listing) already has one live listing "p_live".');
    say();

    EFFECTIVE_TIER = "free";
    const create = makeWriteCtx({ manager_property_records: [liveProperty("manager_a", "p_live")] });
    const draft = { title: "Loft", address: "9 Z St", beds: 3, baths: 1, rentUsd: 1800 };
    const createRes = await executeWrite(createPropertyTool, create.ctx, draft);

    say('  manager: "add a listing at 9 Z St, 3 bed, $1800"');
    say("    tool: create_property (would insert status=pending, a listing slot)");
    say(`    <- ${createRes.ok ? "ok" : `refused: ${createRes.error}`}`);
    say(`       records for this manager: ${JSON.stringify(
      (create.tables.manager_property_records ?? []).map((r) => [r.id, r.status]),
    )}`);
    say(`       audit rows written: ${auditRows(create.tables).length}`);
    say();
    expect(createRes.ok).toBe(false);
    if (!createRes.ok) expect(createRes.error).toBe(managerPropertyLimitMessage("free"));

    const relist = makeWriteCtx({
      manager_property_records: [
        { ...liveProperty("manager_a", "p_down"), status: "unlisted" },
        liveProperty("manager_a", "p_live"),
      ],
    });
    const relistRes = await executeWrite(updatePropertyTool, relist.ctx, { propertyId: "p_down", status: "live" });

    say('  manager: "set p_down live again"');
    say("    tool: update_property { status: live }");
    say(`    <- ${relistRes.ok ? "ok" : `refused: ${relistRes.error}`}`);
    say(`       records for this manager: ${JSON.stringify(
      (relist.tables.manager_property_records ?? []).map((r) => [r.id, r.status]),
    )}`);
    say(`       audit rows written: ${auditRows(relist.tables).length}`);
    say();
    expect(relistRes.ok).toBe(false);
    if (!relistRes.ok) expect(relistRes.error).toBe(managerPropertyLimitMessage("free"));

    const edit = makeWriteCtx({
      manager_property_records: [liveProperty("manager_a", "p1"), liveProperty("manager_a", "p2")],
    });
    const editRes = await executeWrite(updatePropertyTool, edit.ctx, { propertyId: "p1", rentUsd: 2400 });
    const unlistRes = await executeWrite(updatePropertyTool, edit.ctx, { propertyId: "p2", status: "unlisted" });

    say("  the same account, ALREADY over the cap with two live listings:");
    say(`    edit the rent on p1     -> ${editRes.ok ? "ok" : `refused: ${editRes.error}`}`);
    say(`    unlist p2               -> ${unlistRes.ok ? "ok" : `refused: ${unlistRes.error}`}`);
    say(`    nothing deleted or hidden: ${JSON.stringify(
      (edit.tables.manager_property_records ?? []).map((r) => [r.id, r.status]),
    )}`);
    say();
    expect(editRes.ok).toBe(true);
    expect(unlistRes.ok).toBe(true);

    const free = makeWriteCtx({
      manager_property_records: [{ ...liveProperty("manager_a", "p_down"), status: "unlisted" }],
    });
    const freeRes = await executeWrite(updatePropertyTool, free.ctx, { propertyId: "p_down", status: "live" });
    say("  once the slot is free again, the same relist goes through:");
    say(`    update_property { status: live } -> ${freeRes.ok ? "ok" : `refused: ${freeRes.error}`}`);
    say(`    ${JSON.stringify((free.tables.manager_property_records ?? []).map((r) => [r.id, r.status]))}`);
    say();
    expect(freeRes.ok).toBe(true);
    say("=".repeat(78));

    const outDir = process.env.PROPERTY_LIMIT_EVIDENCE_DIR;
    if (outDir) {
      mkdirSync(outDir, { recursive: true });
      writeFileSync(path.join(outDir, "property-limit-assistant-transcript.txt"), `${lines.join("\n")}\n`);
    }
     
    console.log(lines.join("\n"));
  });
});
