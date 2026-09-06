import { randomBytes } from "node:crypto";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { openCosignerIdentity } from "@/lib/security/cosigner-identity";

const mocks = vi.hoisted(() => ({ insert: vi.fn(), notify: vi.fn(), manager: "manager-a" }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: async () => ({ ok: true }), clientIpFrom: () => "synthetic" }));
vi.mock("@/lib/cosigner-notification.server", () => ({ notifyManagerCosignerSubmitted: mocks.notify }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({ from: () => ({
  insert: mocks.insert,
  select: () => ({ in: () => ({ maybeSingle: async () => ({ data: { id: "APP-a", manager_user_id: mocks.manager, row_data: { stage: "Submitted", bucket: "pending" } } }) }) }),
}) }) }));
import { POST } from "@/app/api/public/cosigner-submissions/route";

beforeEach(() => {
  vi.stubEnv("DATA_ENCRYPTION_ACTIVE_KEY_ID", "test");
  vi.stubEnv("DATA_ENCRYPTION_KEYS_JSON", JSON.stringify({ test: randomBytes(32).toString("base64") }));
  vi.stubEnv("COSIGNER_IDENTITY_REQUIRE_ENCRYPTED_READS", "true");
  mocks.manager = "manager-a";
  mocks.insert.mockReset().mockResolvedValue({ error: null });
  mocks.notify.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());

function request() {
  return new Request("https://example.test/api/public/cosigner-submissions", { method: "POST", body: JSON.stringify({
    signerAppId: "AXIS-123456", fullName: "Synthetic Cosigner", email: "synthetic@example.test", consentCredit: true,
    ssn: "123-45-6789", dob: "1980-01-01", dlNumber: "ID-123", _identityProtection: { version: 1, originOwnerId: "attacker" },
  }) });
}

it("public submission stores only protected identity and never trusts supplied crypto ownership", async () => {
  const res = await POST(request());
  expect(res.status).toBe(200);
  const row = mocks.insert.mock.calls[0][0];
  expect(row.signer_app_id).toBe("APP-a");
  expect(row.row_data.signerAppId).toBe("APP-a");
  expect(row.row_data._identityProtection.originOwnerId).toBe("manager-a");
  expect(row.row_data.dob).toMatch(/^proplane:/);
  expect(openCosignerIdentity(row.row_data, row.id)).toMatchObject({ ssn: "***-**-6789", dob: "1980-01-01", dlNumber: "ID-123" });
  expect(await res.json()).not.toHaveProperty("row_data");
  expect(JSON.stringify(mocks.notify.mock.calls)).not.toMatch(/1980|ID-123|6789/);
});

it("missing encryption configuration refuses the write without a plaintext fallback", async () => {
  vi.stubEnv("DATA_ENCRYPTION_KEYS_JSON", "");
  expect((await POST(request())).status).toBe(500);
  expect(mocks.insert).not.toHaveBeenCalled();
});

it("unassigned applications cannot invent an encryption owner from public input", async () => {
  mocks.manager = "";
  expect((await POST(request())).status).toBe(400);
  expect(mocks.insert).not.toHaveBeenCalled();
});
