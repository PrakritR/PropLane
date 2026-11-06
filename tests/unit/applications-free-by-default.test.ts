/**
 * Applications are free by default (captain, 2026-10-29): nothing configured at any level = $0, no
 * checkout, no charge row. A fee a manager saved (account, listing, form, room) still wins unchanged.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/manager-access-server", () => ({ getManagerPurchaseSku: vi.fn() }));
vi.mock("@/lib/manager-manual-payment-settings", () => ({ loadManagerManualPaymentSettings: vi.fn() }));
vi.mock("@/lib/auth/guest-application-upsert", () => ({ resolveManagerUserIdForProperty: vi.fn(async () => "mgr_free") }));
vi.mock("@/lib/household-charges.server", () => ({ upsertManagerCharges: vi.fn() }));

import { upsertManagerCharges } from "@/lib/household-charges.server";
import { resolveApplicationFeeProperty } from "@/lib/application-fee-checkout.server";
import { ensureApplicationFeeChargeRow } from "@/lib/application-fee-charge-row.server";
import { applicationFeeFactForTerms } from "@/lib/form-resolved-fee";
import { LONG_TERM_LEASE_TERM } from "@/lib/rental-application/lease-terms";
import {
  createDefaultListingSubmission,
  normalizeManagerListingSubmissionV1,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import { readApplicationFeeInput } from "@/lib/listing-inline-forms";
import { applicationFeeCentsFromPropertyData } from "@/lib/application-fee-server";

const root = join(__dirname, "..", "..");
const src = (p: string) => readFileSync(join(root, p), "utf8");

function db(sub: ManagerListingSubmissionV1, accountFeeCents: number | null): SupabaseClient {
  return {
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.order = () => chain;
      chain.limit = async () => ({ data: [], error: null });
      chain.maybeSingle = async () => {
        if (table === "manager_property_records") {
          return { data: { manager_user_id: "mgr_free", property_data: { listingSubmission: sub } }, error: null };
        }
        if (table === "manager_automation_settings") {
          return {
            data: accountFeeCents === null ? null : { row_data: { applicationSettings: { applicationFeeCents: accountFeeCents } } },
            error: null,
          };
        }
        return { data: null, error: null };
      };
      return chain;
    },
  } as unknown as SupabaseClient;
}

const blank = () => normalizeManagerListingSubmissionV1({ ...createDefaultListingSubmission(), axisPaymentsEnabled: true });
const withFee = (applicationFee: string) =>
  normalizeManagerListingSubmissionV1({ ...createDefaultListingSubmission(), axisPaymentsEnabled: true, applicationFee });

describe("applications are free by default", () => {
  it("a new listing opens with no application fee and the editor reads it as blank", () => {
    const sub = createDefaultListingSubmission();
    expect(sub.applicationFee).toBe("");
    expect(readApplicationFeeInput(sub, "long")).toEqual({ value: "", placeholder: "", varies: false });
  });

  it("nothing configured: the fee is 0 and no checkout starts", async () => {
    const input = { propertyId: "p1", managerUserId: "mgr_free", leaseTerm: LONG_TERM_LEASE_TERM };
    expect(await resolveApplicationFeeProperty(db(blank(), null), input)).toMatchObject({
      ok: false,
      code: "NO_APPLICATION_FEE",
    });
    const free = await resolveApplicationFeeProperty(db(blank(), null), input, { allowZeroFee: true });
    expect(free.ok && free.value.applicationFeeCents).toBe(0);
  });

  it("the Application tab shows No fee, the same number the checkout charges", () => {
    expect(applicationFeeFactForTerms(blank(), [LONG_TERM_LEASE_TERM], null)).toBe("No fee");
  });

  it("no charge row is created for a free application", async () => {
    vi.mocked(upsertManagerCharges).mockClear();
    const row = await ensureApplicationFeeChargeRow(db(blank(), null), {
      residentEmail: "a@example.com",
      propertyId: "p1",
    });
    expect(row).toBeNull();
    expect(upsertManagerCharges).not.toHaveBeenCalled();
  });

  it("explicit fees keep winning: account $50, listing $30, and an account 0", async () => {
    const input = { propertyId: "p1", managerUserId: "mgr_free", leaseTerm: LONG_TERM_LEASE_TERM };
    const account = await resolveApplicationFeeProperty(db(blank(), 5000), input);
    expect(account.ok && account.value.applicationFeeCents).toBe(5000);
    const listing = await resolveApplicationFeeProperty(db(withFee("30"), null), input);
    expect(listing.ok && listing.value.applicationFeeCents).toBe(3000);
    const zero = await resolveApplicationFeeProperty(db(blank(), 0), input, { allowZeroFee: true });
    expect(zero.ok && zero.value.applicationFeeCents).toBe(0);
  });

  it("a stored property with no listing submission is free, not $50", () => {
    expect(applicationFeeCentsFromPropertyData(null)).toBe(0);
  });

  it("the Application cost inputs no longer suggest 50, and the legacy constant is gone", () => {
    for (const file of ["src/components/portal/pro-portal-settings-panels.tsx", "src/components/portal/pro-portal-settings-forms-panel.tsx"]) {
      const text = src(file);
      const at = text.indexOf('aria-label="Application cost"');
      expect(at).toBeGreaterThan(-1);
      expect(text.slice(at, at + 600)).toContain('placeholder="0"');
    }
    expect(src("src/lib/manager-application-settings.ts")).not.toContain("LEGACY_DEFAULT_APPLICATION_FEE_CENTS");
  });
});
