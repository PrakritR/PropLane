import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { purgeCoManagerReferencesToUser } from "@/lib/auth/purge-orphaned-co-manager-links";
import { MANAGER_DOCUMENTS_BUCKET } from "@/lib/documents/manager-documents";
import { ADMIN_INBOX_SCOPE } from "@/lib/portal-inbox-thread-scope";
import { reclaimApplicationPhotos } from "@/lib/rental-application/application-photos.server";

type ServiceDb = ReturnType<typeof createSupabaseServiceRoleClient>;

function normalizeEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function looksLikeMissingTableError(err: { message?: string } | null | undefined): boolean {
  const m = (err?.message ?? "").toLowerCase();
  return (
    m.includes("schema cache") ||
    m.includes("does not exist") ||
    (m.includes("relation") && m.includes("not"))
  );
}

function assertNoDeleteErrors(results: { error: { message: string } | null }[]) {
  const failed = results.find((result) => result.error && !looksLikeMissingTableError(result.error));
  if (failed?.error) throw new Error(failed.error.message);
}

/** Remove leases, payments, applications, and other portal rows for a resident. */
export async function purgeResidentPortalData(
  db: ServiceDb,
  input: { email?: string; userId?: string | null; applicationId?: string | null },
): Promise<void> {
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  const userId = input.userId ?? null;
  const applicationId = typeof input.applicationId === "string" ? input.applicationId.trim() : "";

  const deleteOps: PromiseLike<{ error: { message: string } | null }>[] = [];
  // Every application row this purge hard-deletes must also reclaim its private
  // application-documents uploads (applicant ID / income photos) — retention
  // Option A: the photos live exactly as long as the row.
  const photoReclaimIds = new Set<string>();

  if (email) {
    // The resident's own screening (background-check) orders and cosigner
    // submissions are keyed by application id (not email/user id), so resolve this
    // resident's application ids and purge those child rows too — otherwise
    // sensitive third-party-check PII orphans after a "permanent" account delete.
    const { data: appRows } = await db
      .from("manager_application_records")
      .select("id")
      .eq("resident_email", email);
    const applicationIds = (appRows ?? [])
      .map((row) => (row as { id?: unknown }).id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    for (const id of applicationIds) photoReclaimIds.add(id);
    if (applicationIds.length > 0) {
      deleteOps.push(
        db.from("screening_orders").delete().in("application_id", applicationIds),
        db.from("cosigner_submission_records").delete().in("signer_app_id", applicationIds),
      );
    }

    deleteOps.push(
      db.from("portal_household_charge_records").delete().eq("resident_email", email),
      db.from("portal_recurring_rent_profile_records").delete().eq("resident_email", email),
      db.from("portal_lease_pipeline_records").delete().eq("resident_email", email),
      db.from("portal_work_order_records").delete().eq("resident_email", email),
      db.from("portal_service_request_records").delete().eq("resident_email", email),
      db.from("portal_inbox_thread_records").delete().eq("participant_email", email).neq("scope", ADMIN_INBOX_SCOPE),
      db.from("portal_outbound_mail_records").delete().eq("recipient_email", email),
      db.from("portal_resident_lease_upload_records").delete().eq("resident_email", email),
      db.from("manager_application_records").delete().eq("resident_email", email),
      db.from("portal_bug_feedback_records").delete().eq("reporter_email", email),
      db.from("ledger_entries").delete().eq("resident_email", email),
      db.from("portal_household_charge_records").delete().filter("row_data->>residentEmail", "eq", email),
      db.from("portal_recurring_rent_profile_records").delete().filter("row_data->>residentEmail", "eq", email),
      db.from("portal_lease_pipeline_records").delete().filter("row_data->>residentEmail", "eq", email),
      db.from("portal_work_order_records").delete().filter("row_data->>residentEmail", "eq", email),
      db.from("portal_service_request_records").delete().filter("row_data->>residentEmail", "eq", email),
      db.from("portal_resident_lease_upload_records").delete().filter("row_data->>residentEmail", "eq", email),
      db.from("portal_inbox_thread_records").delete().filter("row_data->>email", "eq", email),
      db.from("portal_inbox_thread_records").delete().filter("row_data->>fromEmail", "eq", email),
      db.from("portal_scheduled_inbox_message_records").delete().filter("row_data->>recipientEmail", "eq", email),
      db.from("portal_scheduled_inbox_message_records").delete().filter("row_data->>senderEmail", "eq", email),
    );
  }

  if (userId) {
    deleteOps.push(
      db.from("portal_household_charge_records").delete().eq("resident_user_id", userId),
      db.from("portal_recurring_rent_profile_records").delete().eq("resident_user_id", userId),
      db.from("portal_lease_pipeline_records").delete().eq("resident_user_id", userId),
      db.from("portal_resident_lease_upload_records").delete().eq("resident_user_id", userId),
      db.from("portal_bug_feedback_records").delete().eq("reporter_user_id", userId),
      db.from("ledger_entries").delete().eq("resident_user_id", userId),
      db.from("portal_inbox_thread_records").delete().eq("owner_user_id", userId).neq("scope", ADMIN_INBOX_SCOPE),
      db.from("portal_scheduled_inbox_message_records").delete().filter("row_data->>senderUserId", "eq", userId),
      db.from("portal_scheduled_inbox_message_records").delete().filter("row_data->>recipientUserId", "eq", userId),
    );
  }

  if (applicationId) {
    photoReclaimIds.add(applicationId);
    deleteOps.push(
      db.from("manager_application_records").delete().eq("id", applicationId),
      db.from("portal_household_charge_records").delete().filter("row_data->>applicationId", "eq", applicationId),
      db.from("portal_lease_pipeline_records").delete().filter("row_data->>axisId", "eq", applicationId),
      db.from("cosigner_submission_records").delete().eq("signer_app_id", applicationId),
      db.from("screening_orders").delete().eq("application_id", applicationId),
    );
  }

  if (deleteOps.length === 0) return;
  assertNoDeleteErrors(await Promise.all(deleteOps));
  // Only after the rows are really gone: best-effort, never blocks the purge.
  await Promise.allSettled([...photoReclaimIds].map((id) => reclaimApplicationPhotos(db, id)));
}

/** Remove portal rows keyed to one application without touching the resident login. */
export async function purgeApplicationPortalData(db: ServiceDb, applicationId: string): Promise<void> {
  const appId = applicationId.trim();
  if (!appId) return;

  const deleteOps: PromiseLike<{ error: { message: string } | null }>[] = [
    db.from("manager_application_records").delete().eq("id", appId),
    db.from("portal_household_charge_records").delete().filter("row_data->>applicationId", "eq", appId),
    db.from("portal_lease_pipeline_records").delete().filter("row_data->>axisId", "eq", appId),
    db.from("cosigner_submission_records").delete().eq("signer_app_id", appId),
    db.from("screening_orders").delete().eq("application_id", appId),
  ];

  assertNoDeleteErrors(await Promise.all(deleteOps));
  await reclaimApplicationPhotos(db, appId).catch(() => undefined);
}

/** Remove properties, resident records, payments, leases, and other portal rows for a manager. */
export async function purgeManagerPortalData(db: ServiceDb, managerUserId: string): Promise<void> {
  if (!managerUserId) return;

  const { data: profileRow } = await db.from("profiles").select("email").eq("id", managerUserId).maybeSingle();
  const email = normalizeEmail(profileRow?.email);

  await purgeCoManagerReferencesToUser(db, managerUserId);

  // Applicant ID / income photos ride with the application rows deleted below —
  // resolve those ids first so their private uploads are reclaimed too.
  const { data: managerAppRows } = await db
    .from("manager_application_records")
    .select("id")
    .eq("manager_user_id", managerUserId);
  const managerApplicationIds = (managerAppRows ?? [])
    .map((row) => (row as { id?: unknown }).id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);

  const deleteOps: PromiseLike<{ error: { message: string } | null }>[] = [
    // Financial / GL chain — ledger rows must go before journal entries (FK pointer).
    db.from("ledger_entries").delete().eq("manager_user_id", managerUserId),
    db.from("security_deposit_ledger").delete().eq("manager_user_id", managerUserId),
    db.from("gl_journal_entries").delete().eq("manager_user_id", managerUserId),
    // Vendor AP / dispatch chain (before work orders they hang off).
    db.from("vendor_payouts").delete().eq("manager_user_id", managerUserId),
    db.from("vendor_invoices").delete().eq("manager_user_id", managerUserId),
    db.from("manager_bills").delete().eq("manager_user_id", managerUserId),
    db.from("work_order_vendor_offers").delete().eq("manager_user_id", managerUserId),
    db.from("vendor_invites").delete().eq("manager_user_id", managerUserId),
    db.from("vendor_tax_profiles").delete().eq("manager_user_id", managerUserId),
    // Agent + audit (landlord_id is the manager on portal surfaces).
    db.from("agent_pending_actions").delete().eq("landlord_id", managerUserId),
    db.from("agent_sessions").delete().eq("landlord_id", managerUserId),
    db.from("audit_log").delete().eq("landlord_id", managerUserId),
    db.from("manager_sms_numbers").delete().eq("manager_user_id", managerUserId),
    db.from("manager_assistant_emails").delete().eq("manager_user_id", managerUserId),
    db.from("manager_property_records").delete().eq("manager_user_id", managerUserId),
    db.from("manager_application_records").delete().eq("manager_user_id", managerUserId),
    db.from("portal_household_charge_records").delete().eq("manager_user_id", managerUserId),
    db.from("portal_recurring_rent_profile_records").delete().eq("manager_user_id", managerUserId),
    db.from("portal_lease_pipeline_records").delete().eq("manager_user_id", managerUserId),
    db.from("portal_service_request_records").delete().eq("manager_user_id", managerUserId),
    db.from("portal_work_order_records").delete().eq("manager_user_id", managerUserId),
    db.from("portal_inbox_thread_records").delete().eq("owner_user_id", managerUserId),
    db.from("portal_schedule_records").delete().eq("manager_user_id", managerUserId),
    db.from("portal_pro_relationship_records").delete().eq("manager_user_id", managerUserId),
    db.from("portal_pro_relationship_records").delete().eq("related_user_id", managerUserId),
    db.from("account_link_invites").delete().eq("inviter_user_id", managerUserId),
    db.from("account_link_invites").delete().eq("invitee_user_id", managerUserId),
    db.from("portal_bug_feedback_records").delete().eq("reporter_user_id", managerUserId),
    db.from("manager_purchases").delete().eq("user_id", managerUserId),
    db.from("manager_vendor_records").delete().eq("manager_user_id", managerUserId),
    db.from("cosigner_submission_records").delete().eq("manager_user_id", managerUserId),
    db.from("screening_orders").delete().eq("manager_user_id", managerUserId),
    db.from("manager_documents").delete().eq("manager_user_id", managerUserId),
  ];

  if (email) {
    deleteOps.push(db.from("manager_purchases").delete().ilike("email", email));
  }

  // The manager document library holds the user's OWN private uploads (leases,
  // insurance, tax PDFs). Financial ledger/GL rows are retained lawfully; user
  // files are not — remove the private storage objects before the rows above are
  // deleted. Best-effort: storage errors and a missing table (older DBs) must not
  // block the account deletion.
  try {
    const { data: docRows } = await db
      .from("manager_documents")
      .select("storage_path")
      .eq("manager_user_id", managerUserId);
    const storagePaths = (docRows ?? [])
      .map((row) => (row as { storage_path?: unknown }).storage_path)
      .filter((path): path is string => typeof path === "string" && path.length > 0);
    if (storagePaths.length > 0) {
      await db.storage.from(MANAGER_DOCUMENTS_BUCKET).remove(storagePaths);
    }
  } catch {
    /* best-effort storage cleanup */
  }

  assertNoDeleteErrors(await Promise.all(deleteOps));
  await Promise.allSettled(managerApplicationIds.map((id) => reclaimApplicationPhotos(db, id)));
}
