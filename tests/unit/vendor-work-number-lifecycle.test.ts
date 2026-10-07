import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createFakeDb, type FakeDb, type Row } from "../helpers/fake-table-db";

const mocks = vi.hoisted(() => ({
  resolveVendorPortalUserId: vi.fn(),
  setVendorForwardToPhone: vi.fn(),
  getVendorWorkIdentity: vi.fn(),
  releaseTwilioNumber: vi.fn(),
}));
vi.mock("@/lib/auth/vendor-api-access", () => ({ resolveVendorPortalUserId: mocks.resolveVendorPortalUserId }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({}) }));
vi.mock("@/lib/twilio-provisioning", () => ({ releaseTwilioNumber: mocks.releaseTwilioNumber }));
vi.mock("@/lib/twilio-client.server", () => ({ createTwilioRestClient: () => null }));
vi.mock("@/lib/vendor-work-identity.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/vendor-work-identity.server")>()),
  setVendorForwardToPhone: mocks.setVendorForwardToPhone,
  getVendorWorkIdentity: mocks.getVendorWorkIdentity,
}));

import { PATCH } from "@/app/api/vendor/work-identity/route";
import { releaseIdleVendorWorkNumbers } from "@/lib/vendor-work-identity-release.server";
import { providerDestinationFor } from "@/lib/sms/owner-sms-dispatcher.server";

const NOW = new Date("2026-10-06T18:00:00Z");
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

describe("a number nobody texts through for 60 days is released", () => {
  function seed(rows: Row[], usage: Row[] = [], conversations: Row[] = []): FakeDb {
    return createFakeDb({ vendor_work_identities: rows, vendor_work_identity_usage_events: usage, vendor_work_number_conversations: conversations });
  }
  const idle = (extra: Row = {}): Row => ({
    id: "identity-1", vendor_user_id: "vendor-1", phone_number: "+14255550177", phone_number_sid: "PN123", messaging_service_sid: "MG1",
    sms_state: "ready", attachment_state: "attached", sms_send_ready: true, sms_receive_ready: true, email_state: "ready", updated_at: ago(70), ...extra,
  });
  const run = (db: FakeDb, release = vi.fn().mockResolvedValue(true)) =>
    releaseIdleVendorWorkNumbers(db as unknown as SupabaseClient, { now: NOW, release }).then((result) => ({ result, release }));

  it("removes it at the provider, frees the row for a new claim, and keeps the work email", async () => {
    const db = seed([idle()]);
    const { result, release } = await run(db);
    expect(result).toEqual({ released: 1, failed: 0, active: 0 });
    expect(release).toHaveBeenCalledWith("PN123");
    expect(db.tables.vendor_work_identities![0]).toMatchObject({
      phone_number: null, phone_number_sid: null, sms_state: "not_started", attachment_state: "not_started", sms_send_ready: false, sms_receive_ready: false, email_state: "ready",
    });
  });

  it("leaves a number with any text in the window alone", async () => {
    const db = seed([idle()], [{ id: "u1", identity_id: "identity-1", meter: "inbound_sms", created_at: ago(10) }]);
    const { result, release } = await run(db);
    expect(result).toEqual({ released: 0, failed: 0, active: 1 });
    expect(release).not.toHaveBeenCalled();
    expect(db.tables.vendor_work_identities![0]!.phone_number).toBe("+14255550177");
  });

  it("a recent conversation counts as activity too", async () => {
    const db = seed([idle()], [], [{ id: "c1", identity_id: "identity-1", last_activity_at: ago(5) }]);
    expect((await run(db)).result.active).toBe(1);
  });

  it("does not touch a number claimed less than 60 days ago", async () => {
    const db = seed([idle({ updated_at: ago(30) })]);
    const { result, release } = await run(db);
    expect(result).toEqual({ released: 0, failed: 0, active: 0 });
    expect(release).not.toHaveBeenCalled();
  });

  it("a remove the provider cannot confirm is held for inspection, never freed or re-bought", async () => {
    const db = seed([idle()]);
    const { result } = await run(db, vi.fn().mockResolvedValue(false));
    expect(result).toEqual({ released: 0, failed: 1, active: 0 });
    expect(db.tables.vendor_work_identities![0]).toMatchObject({ phone_number: "+14255550177", sms_state: "reconciling", quarantine_reason: "idle_release_unconfirmed" });
  });

  it("a dry-run number has nothing to remove at the provider", async () => {
    const db = seed([idle({ phone_number_sid: "PNdryrun0123" })]);
    const { result, release } = await run(db);
    expect(result.released).toBe(1);
    expect(release).not.toHaveBeenCalled();
  });

  it("never releases a number that is not ready (already released, quarantined)", async () => {
    const db = seed([idle({ sms_state: "reconciling" }), idle({ id: "identity-2", sms_state: "disabled" })]);
    const { result } = await run(db);
    expect(result).toEqual({ released: 0, failed: 0, active: 0 });
  });
});

describe("a manager's text to a vendor with a number is delivered at that number", () => {
  const row = { counterparty_role: "vendor", purpose: "vendor_conversation", recipient_user_id: "vendor-1", recipient_phone: "+12065550142" };
  const dbWith = (identity: Row | null): SupabaseClient => createFakeDb({
    vendor_work_identities: identity ? [identity] : [],
  }) as unknown as SupabaseClient;
  const ready = { id: "identity-1", vendor_user_id: "vendor-1", phone_number: "+14255550177", sms_state: "ready", sms_receive_ready: true, attachment_state: "attached" };

  it("the provider destination is the vendor's PropLane number; the recorded recipient stays their own phone", async () => {
    expect(await providerDestinationFor(dbWith(ready), row)).toBe("+14255550177");
    expect(row.recipient_phone).toBe("+12065550142");
  });

  it("falls back to the vendor's own phone when there is no active number", async () => {
    expect(await providerDestinationFor(dbWith(null), row)).toBe("+12065550142");
    expect(await providerDestinationFor(dbWith({ ...ready, sms_state: "disabled" }), row)).toBe("+12065550142");
    expect(await providerDestinationFor(dbWith({ ...ready, sms_receive_ready: false }), row)).toBe("+12065550142");
  });

  it("falls back when the lookup fails, and never redirects anyone who is not a vendor thread", async () => {
    const broken = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: "boom" } }) }) }) }) } as unknown as SupabaseClient;
    expect(await providerDestinationFor(broken, row)).toBe("+12065550142");
    expect(await providerDestinationFor(dbWith(ready), { ...row, counterparty_role: "resident" })).toBe("+12065550142");
    expect(await providerDestinationFor(dbWith(ready), { ...row, purpose: "manager_conversation" })).toBe("+12065550142");
    expect(await providerDestinationFor(dbWith(ready), { ...row, recipient_user_id: null })).toBe("+12065550142");
  });
});

describe("PATCH /api/vendor/work-identity (forwarding)", () => {
  const patch = (body: unknown) => PATCH(new Request("http://test/api/vendor/work-identity", { method: "PATCH", body: JSON.stringify(body) }));
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveVendorPortalUserId.mockResolvedValue({ ok: true, userId: "vendor-1" });
    mocks.setVendorForwardToPhone.mockResolvedValue(true);
    mocks.getVendorWorkIdentity.mockResolvedValue({ forwardToPhone: false });
  });

  it("turns forwarding off and returns the refreshed identity", async () => {
    const res = await patch({ forwardToPhone: false });
    expect(res.status).toBe(200);
    expect(mocks.setVendorForwardToPhone).toHaveBeenCalledWith({}, "vendor-1", false);
    expect((await res.json()).identity).toEqual({ forwardToPhone: false });
  });
  it("401s a non-vendor", async () => {
    mocks.resolveVendorPortalUserId.mockResolvedValue({ ok: false, status: 401 });
    expect((await patch({ forwardToPhone: true })).status).toBe(401);
    expect(mocks.setVendorForwardToPhone).not.toHaveBeenCalled();
  });
  it("400s anything that is not a boolean", async () => {
    expect((await patch({ forwardToPhone: "yes" })).status).toBe(400);
    expect(mocks.setVendorForwardToPhone).not.toHaveBeenCalled();
  });
  it("409s a vendor with no number to forward for", async () => {
    mocks.setVendorForwardToPhone.mockResolvedValue(false);
    expect((await patch({ forwardToPhone: true })).status).toBe(409);
  });
});

describe("migration 20261006200000_vendor_work_number.sql", () => {
  const sql = readFileSync("supabase/migrations/20261006200000_vendor_work_number.sql", "utf8");
  it("is additive and idempotent", () => {
    expect(sql).not.toMatch(/\bdrop\s+(table|column|function|index|constraint)\b/i);
    expect(sql).not.toMatch(/\b(truncate|delete\s+from)\b/i);
    expect(sql).toContain("add column if not exists forward_to_phone boolean not null default true");
    expect(sql).toContain("create table if not exists public.vendor_work_number_conversations");
    expect(sql).toContain("create index if not exists");
    expect(sql).toContain("create or replace function public.claim_vendor_work_identity_outbound");
  });
  it("the fair-use cap is 1,000 segments per UTC month, counted from the body like the carrier does", () => {
    expect(sql).toContain("outbound_message_cap = 1000");
    expect(sql).toContain("date_trunc('month', now() at time zone 'utc')");
    for (const limit of ["160", "153", "70", "67"]) expect(sql).toContain(limit);
    expect(sql).toContain("'platform_cap_reached'");
    expect(sql).toContain("created_at >= v_month_start");
  });
  it("the new table is service-role only", () => {
    expect(sql).toContain("alter table public.vendor_work_number_conversations enable row level security");
    expect(sql).toMatch(/revoke all on public\.vendor_work_number_conversations from public, anon, authenticated/);
    expect(sql).toMatch(/grant select, insert, update on public\.vendor_work_number_conversations to service_role/);
    expect(sql).toMatch(/revoke execute on function public\.claim_vendor_work_identity_outbound/);
  });
});
