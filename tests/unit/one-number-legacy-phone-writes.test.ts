import { beforeEach, describe, expect, it, vi } from "vitest";
import { createConversationFakeDb, type FakeDb } from "../helpers/conversation-fake-db";
import { legacyPhoneWriteDecision } from "@/lib/auth/legacy-phone-write";

const state = vi.hoisted(() => ({ db: null as unknown, shared: true, readFailed: false, sendSms: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "user", email: "u@example.test" } } }) } }),
}));
vi.mock("@/lib/auth/session-rejection", () => ({ getUserOrRejection: async () => ({ user: { id: "user" } }) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => state.db }));
vi.mock("@/lib/one-number/config.server", () => ({
  loadSharedLineConfig: async () => ({ mode: state.shared ? "shared" : "per_workspace" }),
  loadSharedLineConfigStrict: async () => (state.readFailed ? { ok: false } : { ok: true, config: { mode: state.shared ? "shared" : "per_workspace" } }),
}));
vi.mock("@/lib/auth/profile-role-row", () => ({ ensureProfileRoleRow: async () => undefined }));
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));
vi.mock("@/lib/vendor-own-record", () => ({ resolveOwnVendorRecord: async () => ({ id: "vendor", managerUserId: "owner", row: { id: "vendor", phone: "+12065550100" } }) }));
vi.mock("@/lib/twilio", async () => ({
  ...(await import("@/lib/phone-e164")), sendSms: state.sendSms,
}));

import { PATCH as patchProfile } from "@/app/api/profile/route";
import { POST as backfill } from "@/app/api/profile/backfill/route";
import { PATCH as patchVendor } from "@/app/api/vendor/profile/route";
import { POST as legacySend, PUT as legacyVerify } from "@/app/api/manager/phone/route";

const PHONE = "+12065550100";
const NEXT = "+12065550101";
let db: FakeDb;
function request(body: object) {
  return new Request("http://localhost/api/profile", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
}
beforeEach(() => {
  state.shared = true;
  state.readFailed = false;
  state.sendSms.mockReset();
  db = createConversationFakeDb({ profiles: [{ id: "user", role: "vendor", phone: PHONE, phone_verified_at: "2026-10-18T00:00:00Z" }], manager_vendor_records: [{ id: "vendor", row_data: { phone: PHONE } }] });
  state.db = db;
});

describe("shared-line legacy phone write boundary", () => {
  it.each([
    ["profile", patchProfile], ["backfill", backfill], ["vendor", patchVendor],
  ] as const)("%s refuses changing a verified identity before any profile write", async (_name, action) => {
    const response = await action(request({ phone: NEXT, fullName: "Updated" }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ redirectTo: "/auth/verify-phone" });
    expect(db.tables.profiles[0].phone).toBe(PHONE);
    expect(db.tables.profiles[0].phone_verified_at).toBeTruthy();
    expect(db.tables.manager_vendor_records[0].row_data).toEqual({ phone: PHONE });
  });

  it("profile permits a name-only edit and preserves the verified phone", async () => {
    const response = await patchProfile(request({ fullName: "Updated" }));
    expect(response.status).toBe(200);
    expect(db.tables.profiles[0]).toMatchObject({ full_name: "Updated", phone: PHONE, phone_verified_at: "2026-10-18T00:00:00Z" });
  });

  it("profile retains the original verified representation on an equivalent phone edit", async () => {
    const response = await patchProfile(request({ fullName: "Updated", phone: "(206) 555-0100" }));
    expect(response.status).toBe(200);
    expect(db.tables.profiles[0]).toMatchObject({ phone: PHONE, phone_verified_at: "2026-10-18T00:00:00Z" });
  });

  it.each([["profile", patchProfile], ["backfill", backfill], ["vendor", patchVendor]] as const)(
    "%s permits an unverified contact edit without granting verification", async (_name, action) => {
      db.tables.profiles[0].phone_verified_at = null;
      expect((await action(request({ phone: NEXT }))).status).toBe(200);
      expect(db.tables.profiles[0]).toMatchObject({ phone: NEXT, phone_verified_at: null });
    },
  );

  it.each([["send", legacySend], ["verify", legacyVerify]] as const)(
    "legacy %s directs to the new verification flow before provider work", async (_name, action) => {
      const response = await action(request({ phone: NEXT, code: "123456" }));
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ redirectTo: "/auth/verify-phone" });
      expect(state.sendSms).not.toHaveBeenCalled();
      expect(db.tables.phone_verifications ?? []).toEqual([]);
    },
  );

  it("per-workspace profile editing keeps its existing verification reset", async () => {
    state.shared = false;
    expect((await patchProfile(request({ phone: NEXT }))).status).toBe(200);
    expect(db.tables.profiles[0]).toMatchObject({ phone: NEXT, phone_verified_at: null });
  });

  it.each([
    ["profile", patchProfile], ["backfill", backfill], ["vendor", patchVendor], ["legacy send", legacySend], ["legacy verify", legacyVerify],
  ] as const)("%s refuses with 503 when the line config cannot be read (never fails open)", async (_name, action) => {
    state.readFailed = true;
    state.shared = false;
    const response = await action(request({ phone: NEXT, code: "123456", fullName: "Updated" }));
    expect(response.status).toBe(503);
    expect(db.tables.profiles[0]).toMatchObject({ phone: PHONE, phone_verified_at: "2026-10-18T00:00:00Z" });
    expect(state.sendSms).not.toHaveBeenCalled();
    expect(db.tables.phone_verifications ?? []).toEqual([]);
  });

  it("shared identity cannot be erased before attaching another phone", () => {
    expect(legacyPhoneWriteDecision({ phone: PHONE, phone_verified_at: "now" }, null, true).blocked).toBe(true);
  });
});
