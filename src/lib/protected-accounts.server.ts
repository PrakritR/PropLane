import "server-only";
import { normalizeE164 } from "@/lib/phone-e164";

/**
 * Accounts that hold real customer data.
 *
 * Staging runs on a clone of the production database, so these people's real
 * email addresses and phone numbers are present in every non-production
 * environment. QA that approves an application or runs a rent reminder there
 * would email and text actual residents, and a sent message cannot be recalled
 * - the outbound log already shows real late-fee notices reaching a resident's
 * private relay address.
 *
 * Only the live production deployment may contact them. Everywhere else this
 * shield drops the message, inbound and outbound.
 *
 * This is deliberately narrow: it names one account rather than gating all of
 * staging, because the other accounts are test data that QA is meant to
 * exercise normally.
 */
export const PROTECTED_MANAGER_USER_IDS: readonly string[] = [
  // Ambika Mago - the Brooklyn 5257 / 5259 live listings.
  "c49d02b1-7e99-4484-9986-b3b4550c3519",
];

/**
 * Always shielded regardless of what the database says, so the account owner
 * and its co-manager are covered even if the row lookup fails or returns empty.
 */
export const PROTECTED_ACCOUNT_EMAILS: readonly string[] = [
  "ogambik2@gmail.com",
  "prakritramachandran@gmail.com",
];

/** Tables carrying `manager_user_id`; a contact can appear in any of them. */
const MANAGER_SCOPED_TABLES = [
  "portal_household_charge_records",
  "portal_lease_pipeline_records",
  "portal_service_request_records",
  "portal_work_order_records",
  "portal_reminder_records",
  "portal_recurring_rent_profile_records",
  "portal_scheduled_inbox_message_records",
  "manager_application_records",
  "manager_property_records",
] as const;

const EMAIL_PATTERN = /[\w.+-]+@[\w.-]+\.\w{2,}/g;
const PHONE_PATTERN = /\+?\d[\d().\s-]{8,}\d/g;
const CACHE_TTL_MS = 5 * 60 * 1000;

type ContactSet = { emails: Set<string>; phones: Set<string> };
type Cache = { at: number; contacts: ContactSet };

let cache: Cache | null = null;
let inFlight: Promise<ContactSet> | null = null;

/**
 * Databases that contain the real customer: production, and the staging clone
 * of it. Dev/test holds only seeded fixtures.
 */
const DATABASES_WITH_REAL_CUSTOMERS = ["xwszcafaontidfgznlxd", "qahnczmilgptcedaqype"];

/**
 * Production is the only place these accounts may be reached. `VERCEL_ENV` is
 * the deployment's own signal rather than NODE_ENV, which is also "production"
 * for a local production build.
 *
 * The shield then applies only where the real customer actually exists - the
 * staging clone, or anything else pointed at one of those projects. Dev/test
 * has no real resident to protect, so shielding there would fail QA closed for
 * nothing.
 */
export function protectedAccountsAreShielded(): boolean {
  if (process.env.VERCEL_ENV === "production") return false;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  return DATABASES_WITH_REAL_CUSTOMERS.some((ref) => url.includes(`${ref}.supabase.co`));
}

function staticEmails(): Set<string> {
  return new Set(PROTECTED_ACCOUNT_EMAILS.map((value) => value.toLowerCase()));
}

async function loadContacts(): Promise<ContactSet> {
  const contacts: ContactSet = { emails: staticEmails(), phones: new Set() };
  const { createSupabaseServiceRoleClient } = await import("@/lib/supabase/service");
  const db = createSupabaseServiceRoleClient();

  for (const table of MANAGER_SCOPED_TABLES) {
    const { data, error } = await db
      .from(table)
      .select("*")
      .in("manager_user_id", PROTECTED_MANAGER_USER_IDS)
      .limit(1000);
    // A missing table or renamed column must not silently shrink the shield.
    if (error) throw new Error(`protected-accounts: ${table}: ${error.message}`);
    for (const row of data ?? []) {
      // Contacts hide in row_data under many shapes, so scan the serialized row
      // rather than guessing at column names.
      const serialized = JSON.stringify(row);
      for (const email of serialized.match(EMAIL_PATTERN) ?? []) {
        contacts.emails.add(email.toLowerCase());
      }
      for (const candidate of serialized.match(PHONE_PATTERN) ?? []) {
        const phone = normalizeE164(candidate);
        if (phone) contacts.phones.add(phone);
      }
    }
  }
  return contacts;
}

/**
 * Resolved contacts for the protected accounts. Throws when it cannot be built,
 * so a caller that fails closed stays closed rather than treating an outage as
 * "nobody is protected".
 */
export async function protectedContacts(): Promise<ContactSet> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.contacts;
  inFlight ??= loadContacts()
    .then((contacts) => {
      cache = { at: Date.now(), contacts };
      return contacts;
    })
    .finally(() => {
      inFlight = null;
    });
  try {
    return await inFlight;
  } catch (error) {
    // Serve a stale set rather than nothing; only a cold failure propagates.
    if (cache) return cache.contacts;
    throw error;
  }
}

/**
 * True when this recipient must not be contacted from the current runtime.
 *
 * Fails CLOSED for the protected account: if the contact set cannot be built,
 * every recipient is treated as protected, because sending in error is
 * irreversible and blocking in error is not.
 */
export async function isShieldedRecipient(recipient: {
  email?: string | null;
  phone?: string | null;
}): Promise<boolean> {
  if (!protectedAccountsAreShielded()) return false;

  const email = recipient.email?.trim().toLowerCase() || "";
  const phone = recipient.phone ? normalizeE164(recipient.phone) : "";
  if (email && staticEmails().has(email)) return true;

  let contacts: ContactSet;
  try {
    contacts = await protectedContacts();
  } catch {
    return true;
  }
  return Boolean((email && contacts.emails.has(email)) || (phone && contacts.phones.has(phone)));
}

/** Convenience for callers that already know the owning account. */
export function isProtectedManagerUserId(managerUserId: string | null | undefined): boolean {
  if (!protectedAccountsAreShielded()) return false;
  return Boolean(managerUserId && PROTECTED_MANAGER_USER_IDS.includes(managerUserId));
}
