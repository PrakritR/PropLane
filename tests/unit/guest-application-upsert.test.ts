import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { prepareGuestApplicationUpsert } from "@/lib/auth/guest-application-upsert";
import { attachResidentSetupToken, isResidentSetupTokenValid } from "@/lib/auth/resident-setup-token";

function baseRow(overrides: Partial<DemoApplicantRow> = {}): DemoApplicantRow {
  return {
    id: "AXIS-GUEST01",
    name: "Guest Applicant",
    property: "House",
    stage: "Submitted",
    bucket: "pending",
    detail: "Submitted",
    email: "guest@example.com",
    propertyId: "prop-1",
    ...overrides,
  };
}

describe("prepareGuestApplicationUpsert", () => {
  const resolveManager = vi.fn();

  beforeEach(() => {
    resolveManager.mockReset();
    resolveManager.mockResolvedValue({
      // `status` is NOT NULL in manager_property_records, and a live listing is
      // the only one that accepts applications (PRP-206).
      data: { manager_user_id: "mgr-1", status: "live", property_data: null },
      error: null,
    });
  });

  function makeDb() {
    return {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === "manager_property_records") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: resolveManager,
              }),
            }),
          };
        }
        if (table === "manager_application_records") {
          // The server-side duplicate guard (PRP-204) reads this table; these
          // fixtures have no prior applications, so it finds none.
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue({ data: [], error: null }),
              }),
            }),
          };
        }
        throw new Error(`unexpected table ${table}`);
      }),
    };
  }

  it("allows pending guest upserts and issues a setup token", async () => {
    const result = await prepareGuestApplicationUpsert(makeDb() as never, {
      row: baseRow(),
      existing: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.row.managerUserId).toBe("mgr-1");
    expect(result.row.bucket).toBe("pending");
    expect(result.setupToken.length).toBeGreaterThan(20);
    expect(isResidentSetupTokenValid(result.row, result.setupToken)).toBe(true);
  });

  it("rejects missing email", async () => {
    const result = await prepareGuestApplicationUpsert(makeDb() as never, {
      row: baseRow({ email: "not-an-email" }),
      existing: null,
    });
    expect(result).toMatchObject({ ok: false, status: 400 });
  });

  it("rejects non-pending buckets", async () => {
    const result = await prepareGuestApplicationUpsert(makeDb() as never, {
      row: baseRow({ bucket: "approved" }),
      existing: null,
    });
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it("rejects email mismatch on existing pending row", async () => {
    const result = await prepareGuestApplicationUpsert(makeDb() as never, {
      row: baseRow({ email: "other@example.com" }),
      existing: baseRow({ email: "guest@example.com" }),
    });
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it("rejects a submit whose property resolves to no manager, ignoring a forged managerUserId", async () => {
    resolveManager.mockResolvedValue({ data: null, error: null });
    const result = await prepareGuestApplicationUpsert(makeDb() as never, {
      row: baseRow({ propertyId: "prop-unknown", managerUserId: "victim-manager" }),
      existing: null,
    });
    expect(result).toMatchObject({ ok: false, status: 400 });
  });

  it("keeps the stored attribution on an edit instead of a forged managerUserId", async () => {
    resolveManager.mockResolvedValue({ data: null, error: null });
    const result = await prepareGuestApplicationUpsert(makeDb() as never, {
      row: baseRow({ propertyId: "prop-unknown", managerUserId: "victim-manager" }),
      existing: baseRow({ managerUserId: "mgr-1" }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.row.managerUserId).toBe("mgr-1");
  });

  it("rejects edits to non-pending existing applications", async () => {
    const result = await prepareGuestApplicationUpsert(makeDb() as never, {
      row: baseRow(),
      existing: baseRow({ bucket: "approved" }),
    });
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it("preserves an existing setup token when the client still holds it", async () => {
    const withToken = attachResidentSetupToken(baseRow());
    const result = await prepareGuestApplicationUpsert(makeDb() as never, {
      row: baseRow({ fullLegalName: "Updated" } as never),
      existing: withToken.row,
      clientSetupToken: withToken.token,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.setupToken).toBe(withToken.token);
    expect(result.row.setupTokenHash).toBe(withToken.row.setupTokenHash);
    expect(isResidentSetupTokenValid(result.row, withToken.token)).toBe(true);
  });
});
