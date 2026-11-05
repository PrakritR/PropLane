/** Read-only fail-closed classification of the canonical account-purge candidate set. */
import type { SupabaseClient } from "@supabase/supabase-js";
import { ACCOUNT_PURGE_TABLES } from "@/lib/auth/account-purge-manifest";
import { managerTasksStorageKey } from "@/lib/manager-tasks";
import { DEFAULT_LIFECYCLE_AUTOMATION, LIFECYCLE_TASK_META } from "@/lib/task-lifecycle-automation";
import type { SignupJournal } from "./signup-proof-journal";
import { inspectSignupPhoneState } from "./signup-proof-phone-cleanup";
import { optionalPurgeTableAbsentOnDev } from "./synthetic-workspace-preflight";

type Row = Record<string, unknown>;
type Input = { db: SupabaseClient; journal: SignupJournal; paired?: SignupJournal; requireAbsent?: boolean; optionalTableAbsent?: (table: string) => Promise<boolean> };
const safe = (): never => { throw new Error("Signup cleanup candidate refused."); };
const providerField = /(?:stripe_|twilio_|access_token|refresh_token|api_key|provider_sid|provider_message_id|provider_id|messaging_service_sid|phone_number_sid|campaign_sid|bank_account)/i;
function assertNoProvider(value: unknown): void {
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (key === "stripe_checkout_session_id" && typeof item === "string" && /^axis_(?:intent|pending)_[a-f0-9-]+$/i.test(item)) continue;
    if (providerField.test(key) && item != null && item !== "" && item !== false) safe();
    if (typeof item === "object") assertNoProvider(item);
  }
}
const ownColumns: Record<string, string> = {
  email_onboarding_handoffs: "user_id", manager_automation_settings: "manager_user_id", manager_purchases: "user_id",
  portal_workspaces: "owner_user_id", manager_sms_numbers: "manager_user_id", manager_property_records: "manager_user_id",
  phone_verifications: "user_id", phone_required_skips: "user_id", sms_consent: "user_id", notification_preferences: "user_id", agent_user_preferences: "user_id",
  device_push_tokens: "user_id", resident_housemate_sharing: "user_id", workspace_automation_settings: "owner_user_id",
  listing_prefill_usage: "manager_user_id", manager_door_count_snapshots: "manager_user_id",
};
/** The saved Auth subject, pair and frozen inventory must identify the same resident. */
export function assertSignupApplicationResidentSubject(row: Row, manager: SignupJournal | undefined, resident: SignupJournal | undefined, application: NonNullable<SignupJournal["inventory"]>[number] | undefined): void {
  const data = row.row_data;
  if (manager?.tier !== "pro" || resident?.tier !== "resident" || !manager.actorId || !resident.actorId || manager.actorId === resident.actorId || application?.namespace !== "application" || application.actorId !== manager.actorId || !data || typeof data !== "object" || Array.isArray(data)) safe();
  const subject = (data as Row).residentUserId;
  if (typeof subject !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(subject) || subject !== resident!.actorId || subject !== application!.residentActorId) safe();
}
export async function classifySignupCandidate(table: string, row: Row, journal: SignupJournal, paired?: SignupJournal, db?: SupabaseClient): Promise<void> {
  const actor = journal.actorId!;
  assertNoProvider(row);
  if (table === "sms_phone_contacts") {
    inspectSignupPhoneState(journal, { contacts: [row] as never[], challenges: [], locks: [] });
    return;
  }
  if (table === "manager_application_records") {
    const manager = journal.tier === "pro" ? journal : paired;
    const resident = journal.tier === "resident" ? journal : paired;
    const app = manager?.inventory?.find((entry) => entry.namespace === "application" && entry.state === "resolved");
    assertSignupApplicationResidentSubject(row, manager, resident, app);
    if (!manager?.actorId || !app || row.id !== app.id || row.manager_user_id !== manager.actorId || row.resident_email !== (journal.tier === "resident" ? journal.email : paired?.email) || row.test_workspace_id != null || row.workspace_id != null || (row.property_id !== app.propertyId && row.assigned_property_id !== app.propertyId) || [row.property_id, row.assigned_property_id].some((id) => id != null && id !== app.propertyId)) safe();
    return;
  }
  const manager = journal.tier === "pro" ? journal : paired;
  const resident = journal.tier === "resident" ? journal : paired;
  const pairIds = [manager?.actorId, resident?.actorId].filter(Boolean);
  const pairEmails = [manager?.email, resident?.email].filter(Boolean);
  const application = manager?.inventory?.find((entry) => entry.namespace === "application" && entry.state === "resolved");
  const property = manager?.inventory?.find((entry) => entry.namespace === "property" && entry.state === "resolved");
  const related = (value: unknown) => value == null || pairIds.includes(String(value));
  // Owner selectors alone do not authorize references to another fixture or workspace.
  if (row.test_workspace_id != null) safe();
  for (const key of ["property_id", "assigned_property_id"]) if (row[key] != null && row[key] !== property?.id) safe();
  if (row.application_id != null && row.application_id !== application?.id) safe();
  if (row.workspace_id != null) {
    if (!db || typeof row.workspace_id !== "string") safe();
    const workspace = await db.from("portal_workspaces").select("owner_user_id").eq("id", row.workspace_id).limit(2);
    if (workspace.error || workspace.data?.length !== 1 || !pairIds.includes(workspace.data[0]?.owner_user_id)) safe();
  }
  if (table === "portal_schedule_records") {
    const data = row.row_data as Row | null;
    const id = manager?.actorId && managerTasksStorageKey(manager.actorId);
    if (!manager?.actorId || !application?.id || !property?.id || row.manager_user_id !== manager.actorId || row.id !== id || row.record_type !== "manager_tasks" || row.property_id != null || row.workspace_id != null || !data || Object.keys(data).some((key) => !["id", "recordType", "managerUserId", "tasks"].includes(key)) || data.id !== id || data.recordType !== "manager_tasks" || data.managerUserId !== manager.actorId || !Array.isArray(data.tasks) || data.tasks.length > 2) safe();
    const seen = new Set<string>(), taskIds = new Set<string>();
    for (const value of data!.tasks as unknown[]) {
      if (!value || typeof value !== "object" || Array.isArray(value)) safe();
      const task = value as Row, template = String(task.templateKey);
      const assignee = task.assignee as Row | null;
      if (!["review_application", "decide_application"].includes(template) || seen.has(template) || task.title !== (template === "review_application" ? "Review application" : "Approve or decline application") || task.sourceId !== application.id || task.dedupKey !== `${template}:${application.id}` || task.propertyId !== property.id || !assignee || assignee.type !== "team" || assignee.id !== manager.actorId || Object.keys(assignee).some((key) => !["type", "id", "name"].includes(key)) || task.priority != null || task.recurrence != null || typeof task.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(task.id) || task.taskType !== "general" || task.urgency !== "deadline" || task.completed !== false) safe();
      if (taskIds.has(String(task.id))) safe();
      taskIds.add(String(task.id));
      seen.add(template);
      for (const key of ["createdAt", "updatedAt"]) { const time = Date.parse(String(task[key])); if (!Number.isFinite(time) || time < Date.parse(manager.startedAt) || time > Date.now()) safe(); }
      const due = Date.parse(String(task.dueDate));
      const key = template as "review_application" | "decide_application";
      const submittedAt = due - DEFAULT_LIFECYCLE_AUTOMATION[key].offsetMinutes * 60_000;
      if (!Number.isFinite(due) || submittedAt < Date.parse(manager.startedAt) || submittedAt > Date.parse(String(task.createdAt)) || task.title !== LIFECYCLE_TASK_META[key].taskTitle || Date.parse(String(task.updatedAt)) < Date.parse(String(task.createdAt))) safe();
      for (const key of ["attachments", "comments", "checklist"]) if (task[key] != null && (!Array.isArray(task[key]) || (task[key] as unknown[]).length)) safe();
      for (const key of ["linkedTourId", "linkedWorkOrderId", "recurrenceOfTaskId", "reminderSentAt", "advanceReminderSentOffsets", "completedAt", "start", "end"]) if (task[key] != null) safe();
      const allowed = new Set(["id", "title", "notes", "propertyId", "propertyTitle", "roomLabel", "dueDate", "completed", "assignee", "taskType", "urgency", "priority", "recurrence", "checklist", "attachments", "comments", "templateKey", "sourceId", "dedupKey", "createdAt", "updatedAt"]);
      if (Object.keys(task).some((key) => !allowed.has(key))) safe();
    }
    return;
  }
  if (table === "resident_workspace_bindings") {
    if (!manager?.actorId || !resident?.actorId || row.manager_user_id !== manager.actorId || row.resident_user_id !== resident.actorId || row.application_id != null && row.application_id !== application?.id) safe();
    return;
  }
  if (table === "application_form_requests") {
    if (!manager?.actorId || !application?.id || row.manager_user_id !== manager.actorId || row.application_id !== application.id || row.applicant_user_id !== resident?.actorId || [row.helper_user_id, row.filled_by_user_id, row.fee_paid_by_user_id].some((id) => !related(id)) || row.fee_paid_at || row.fee_session_id) safe();
    return;
  }
  if (table === "portal_pro_relationship_records") {
    if (!manager?.actorId || !resident?.actorId || row.manager_user_id !== manager.actorId || row.related_user_id !== resident.actorId || row.related_email != null && row.related_email !== resident.email) safe();
    return;
  }
  if (table === "action_events") {
    if (row.manager_user_id !== manager?.actorId || ![property?.id, application?.id].filter(Boolean).includes(String(row.entity_id)) || !related(row.sender_user_id) || row.sender_email != null && !pairEmails.includes(String(row.sender_email))) safe();
    return;
  }
  if (table === "action_event_deliveries") {
    if (!db || !pairIds.includes(String(row.recipient_user_id)) || row.recipient_email != null && !pairEmails.includes(String(row.recipient_email)) || !row.event_id) safe();
    const result = await db.from("action_events").select("*").eq("id", row.event_id).limit(2);
    if (result.error || result.data?.length !== 1) safe();
    await classifySignupCandidate("action_events", result.data[0], journal, paired, db);
    return;
  }
  if (table === "audit_log") {
    if (row.landlord_id !== manager?.actorId || !related(row.actor_user_id) || row.test_workspace_id != null) safe();
    return;
  }
  if (table === "portal_inbox_thread_records") {
    const known = manager?.inventory?.find((entry) => entry.namespace === "resident-threads" && entry.state === "resolved")?.ids ?? [];
    if (!pairIds.includes(String(row.owner_user_id)) || !["axis_portal_inbox_manager_v1", "axis_portal_inbox_resident_v1"].includes(String(row.scope)) || row.test_workspace_id != null || !known.includes(String(row.id))) safe();
    if (row.participant_email != null && !pairEmails.includes(String(row.participant_email))) safe();
    const recordRef = (row.row_data as { recordRef?: { id?: string } } | null)?.recordRef;
    if (recordRef && ![property?.id, application?.id].filter(Boolean).includes(recordRef.id)) safe();
    if (row.workspace_id != null) {
      if (!db) safe();
      const workspace = await db.from("portal_workspaces").select("owner_user_id").eq("id", row.workspace_id).limit(2);
      if (workspace.error || workspace.data?.length !== 1 || !pairIds.includes(workspace.data[0]?.owner_user_id)) safe();
    }
    return;
  }
  const owner = ownColumns[table];
  if (!owner || row[owner] !== actor) safe();
  if (table === "manager_property_records") {
    const property = journal.inventory?.find((entry) => entry.namespace === "property" && entry.state === "resolved");
    if (!property || row.id !== property.id || !JSON.stringify([row.row_data, row.property_data]).includes(journal.nonce)) safe();
  }
  if (table === "manager_purchases" && (row.email !== journal.email || row.tier !== "pro" || row.billing !== "trial" || typeof row.stripe_checkout_session_id !== "string" || !/^axis_(?:intent|pending)_[a-f0-9-]+$/i.test(row.stripe_checkout_session_id) || row.stripe_subscription_id)) safe();
  if (table === "portal_workspaces" && (!Number.isFinite(Date.parse(String(row.created_at))) || Date.parse(String(row.created_at)) < Date.parse(journal.startedAt) || row.is_default !== true || row.is_service !== false || row.stripe_connect_account_id != null || row.stripe_connect_charges_enabled !== false || row.stripe_connect_payouts_enabled !== false)) safe();
  if (table === "manager_sms_numbers") {
    if (!db || typeof row.workspace_id !== "string") safe();
    const workspace = await db.from("portal_workspaces").select("*").eq("id", row.workspace_id).limit(2);
    if (workspace.error || workspace.data?.length !== 1 || workspace.data[0]?.owner_user_id !== actor) safe();
    if (row.provider !== "twilio" || row.provision_state !== "pending_registration" || row.registration_state !== "pending" || row.attachment_state !== "not_attached" || row.number_registration_state !== "not_submitted") safe();
    for (const key of ["phone_number", "phone_number_sid", "messaging_service_sid", "campaign_sid", "provision_request_id", "provisioned_at", "released_at", "attached_at", "registration_submitted_at", "last_provider_event_at", "provider_reconciled_at", "grace_started_at", "grace_expires_at", "quarantined_at", "quarantine_reason", "detach_confirmed_at", "deregistration_confirmed_at", "provider_release_confirmed_at"]) if (row[key] !== null) safe();
  }
}
/** Query every manifest predicate, including detaches, with the canonical restrict guard. */
export async function inspectSignupPurgeCandidates(input: Input): Promise<Array<{ table: string; row: Row }>> {
  const { db, journal } = input;
  if (!journal.actorId || (db as unknown as { supabaseUrl?: string }).supabaseUrl !== journal.target || journal.target !== "https://emstjswhotsnyksqhqyf.supabase.co") safe();
  const scope = journal.tier === "resident" ? "resident" : "manager";
  const roots: Array<{ table: string; row: Row }> = [];
  const checks: Array<() => Promise<void>> = [];
  for (const rule of ACCOUNT_PURGE_TABLES) {
    const current = rule[scope];
    if (!current) continue;
    const predicates = [
      ...(current.ids ?? []).map((column) => ({ column, value: journal.actorId!, email: false })),
      ...(current.emails ?? []).map((column) => ({ column, value: journal.email, email: true })),
      ...(current.detachIds ?? []).map((column) => ({ column, value: journal.actorId!, email: false })),
      ...(current.detachEmails ?? []).map((column) => ({ column, value: journal.email, email: true })),
    ];
    for (const predicate of predicates) checks.push(async () => {
      let query = db.from(rule.table).select("*", { count: "exact" });
      query = predicate.email ? query.ilike(predicate.column, predicate.value.replace(/[\\%_]/g, "\\$&")) : query.eq(predicate.column, predicate.value);
      if (current.restrict) query = query.neq(current.restrict.column, current.restrict.notEquals);
      let result;
      try { result = await query.limit(101); } catch { return safe(); }
      if (result.error) {
        if (result.error.code === "PGRST205" && await (input.optionalTableAbsent ?? optionalPurgeTableAbsentOnDev)(rule.table)) return;
        safe();
      }
      if (!Array.isArray(result.data) || result.data.length > 100 || !Number.isSafeInteger(result.count) || result.count !== result.data.length) safe();
      if ((current.preserveFinancial || input.requireAbsent) && result.data.length) safe();
      for (const row of result.data) { await classifySignupCandidate(rule.table, row as Row, journal, input.paired, db); roots.push({ table: rule.table, row: row as Row }); }
    });
  }
  for (let offset = 0; offset < checks.length; offset += 6) await Promise.all(checks.slice(offset, offset + 6).map((check) => check()));
  return roots;
}
