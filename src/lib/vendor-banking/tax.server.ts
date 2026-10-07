import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { encryptTin, tinLast4 } from "@/lib/reports/tin-crypto";
import { resolveOwnVendorRecords } from "@/lib/vendor-own-record";
import { listVendorBankingLedgerEntries } from "@/lib/vendor-banking/ledger.server";
import {
  summarizeVendorTaxYears,
  type VendorTaxYearSummary,
  type VendorW9Input,
  type VendorW9Profile,
} from "@/lib/vendor-banking/tax";

const TABLE = "vendor_account_tax_profiles";
/** Columns safe to read back — the ciphertext column is never selected for a client response. */
const SAFE_COLUMNS =
  "legal_name, business_name, entity_type, address_line1, address_line2, city, state, zip, tin_type, tin_last4, w9_attestation, w9_received_at";

type ProfileRow = {
  legal_name: string | null;
  business_name: string | null;
  entity_type: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  tin_type: string | null;
  tin_last4: string | null;
  w9_attestation: boolean | null;
  w9_received_at: string | null;
};

function toProfile(row: ProfileRow): VendorW9Profile {
  return {
    legalName: row.legal_name,
    businessName: row.business_name,
    entityType: row.entity_type,
    addressLine1: row.address_line1,
    addressLine2: row.address_line2,
    city: row.city,
    state: row.state,
    zip: row.zip,
    tinType: row.tin_type === "ssn" || row.tin_type === "ein" ? row.tin_type : null,
    tinLast4: row.tin_last4,
    attested: row.w9_attestation === true,
    receivedAt: row.w9_received_at,
  };
}

/** The vendor's own W-9 (null when none), pinned to `vendorUserId`. */
export async function readVendorW9(db: SupabaseClient, vendorUserId: string): Promise<VendorW9Profile | null> {
  const { data, error } = await db.from(TABLE).select(SAFE_COLUMNS).eq("vendor_user_id", vendorUserId).maybeSingle();
  if (error) throw new Error(`Could not read the W-9: ${error.message}`);
  return data ? toProfile(data as ProfileRow) : null;
}

export async function vendorHasTinOnFile(db: SupabaseClient, vendorUserId: string): Promise<boolean> {
  const { data, error } = await db.from(TABLE).select("tin_last4").eq("vendor_user_id", vendorUserId).maybeSingle();
  if (error) throw new Error(`Could not read the W-9: ${error.message}`);
  return Boolean((data as { tin_last4?: string | null } | null)?.tin_last4);
}

/**
 * Saves the vendor's one W-9. The TIN is encrypted (AES-256-GCM,
 * `FINANCIALS_TIN_ENCRYPTION_KEY`; throws when the key is missing so the route
 * fails closed) and only its last four digits are stored beside it. The legacy
 * per-manager rows the manager's 1099 export reads are kept in step from the same
 * ciphertext — best effort, never a reason to lose the vendor's save.
 */
export async function saveVendorW9(db: SupabaseClient, vendorUserId: string, input: VendorW9Input): Promise<VendorW9Profile> {
  const now = new Date().toISOString();
  const row: Record<string, unknown> = {
    vendor_user_id: vendorUserId,
    legal_name: input.legalName,
    business_name: input.businessName,
    entity_type: input.entityType,
    address_line1: input.addressLine1,
    address_line2: input.addressLine2,
    city: input.city,
    state: input.state,
    zip: input.zip,
    tin_type: input.tinType,
    w9_attestation: true,
    updated_at: now,
  };
  if (input.tin) {
    row.tin_ciphertext = encryptTin(input.tin);
    row.tin_last4 = tinLast4(input.tin);
    row.w9_received_at = now;
  }
  const { data, error } = await db.from(TABLE).upsert(row, { onConflict: "vendor_user_id" }).select(SAFE_COLUMNS).single();
  if (error) throw new Error(`Could not save the W-9: ${error.message}`);

  try {
    const { data: stored } = await db.from(TABLE).select("tin_ciphertext, tin_last4, w9_received_at").eq("vendor_user_id", vendorUserId).maybeSingle();
    const secret = stored as { tin_ciphertext?: string | null; tin_last4?: string | null; w9_received_at?: string | null } | null;
    if (secret?.tin_ciphertext) {
      for (const record of await resolveOwnVendorRecords(db, vendorUserId)) {
        await db.from("vendor_tax_profiles").upsert(
          {
            vendor_id: record.id,
            manager_user_id: record.managerUserId,
            vendor_user_id: vendorUserId,
            submitted_by_vendor: true,
            legal_name: input.legalName,
            business_name: input.businessName,
            entity_type: input.entityType === "individual" ? "individual" : "business",
            address_line1: input.addressLine1,
            address_line2: input.addressLine2,
            city: input.city,
            state: input.state,
            zip: input.zip,
            tin_type: input.tinType,
            tin_ciphertext: secret.tin_ciphertext,
            tin_last4: secret.tin_last4,
            w9_received_at: secret.w9_received_at,
            w9_attestation: true,
            updated_at: now,
          },
          { onConflict: "manager_user_id,vendor_id" },
        );
      }
    }
  } catch (e) {
    console.error("[vendor/finances/tax] legacy W-9 mirror failed", e instanceof Error ? e.message : e);
  }

  return toProfile(data as ProfileRow);
}

/**
 * Earnings, fees and refunds per tax year, straight from the vendor ledger.
 * The read is unlimited and paged — a 1099 total that stopped at a row cap
 * would under-report against the reporting threshold with nothing to show for it.
 */
export async function readVendorTaxYears(db: SupabaseClient, vendorUserId: string): Promise<VendorTaxYearSummary[]> {
  const entries = await listVendorBankingLedgerEntries(db, vendorUserId);
  return summarizeVendorTaxYears(entries);
}
