import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ACCOUNT_PURGE_TABLES } from "@/lib/auth/account-purge-manifest";
import { cleanupSignupReservations } from "../helpers/signup-proof-cleanup";
import { persistSignupJournal, readSignupJournal, type SignupJournal } from "../helpers/signup-proof-journal";

function fixture() {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "signup-cleanup-")));
  const actor = "11111111-1111-4111-8111-111111111111", nonce = "a".repeat(32);
  const manifest: SignupJournal = { schemaVersion: 1, target: "https://emstjswhotsnyksqhqyf.supabase.co", nonce, absentBeforeSignup: true, email: `p8-manager-${nonce}-draft@example.invalid`, phone: "+12065550100", fullName: "P8 draft manager", tier: "pro", startedAt: "2026-01-01T00:00:00Z", actorId: actor, actorCreatedAt: "2026-01-01T00:00:01Z", phase: "reserved" };
  const file = path.join(dir, `p8-${nonce}.manifest.json`); persistSignupJournal(file, manifest);
  const populated: Record<string, Record<string, unknown>[]> = {};
  const calls: string[] = [];
  const user = { id: actor, email: manifest.email, created_at: "2026-01-01T00:00:01Z", app_metadata: { proplane_email_onboarding: true }, identities: [{ provider: "email" }] };
  const users = new Map([[actor, user]]);
  const knownTables = new Set([...ACCOUNT_PURGE_TABLES.map((rule) => rule.table), "profiles", "profile_roles", "phone_otp_challenges", "phone_auth_operation_locks", "number_subscriptions", "number_credit_accounts", "number_credit_usage_events", "number_credit_purchases", "number_credit_adjustments", "resident_agent_numbers", "vendor_work_identities", "vendor_work_identity_release_queue", "account_link_invites", "test_workspace_members", "test_workspaces", "resident_inspections", "resident_move_in_forms", "manager_documents", "portal_recurring_rent_profile_records", "portal_resident_lease_upload_records", "portal_scheduled_inbox_message_records", "screening_orders", "cosigner_submission_records", "unclassified_children"]);
  const db = { supabaseUrl: manifest.target, from(table: string) {
    if (!knownTables.has(table)) throw new Error(`Unknown mock table: ${table}`);
    const filters: Array<(row: Record<string, unknown>) => boolean> = [];
    let deleting = false;
    const query = { select: () => query, eq: (c: string, v: unknown) => { filters.push((row) => row[c] === v); return query; }, ilike: (c: string, v: string) => { filters.push((row) => String(row[c]).toLowerCase() === v.toLowerCase()); return query; }, neq: (c: string, v: unknown) => { filters.push((row) => row[c] !== v); return query; }, is: (c: string, v: unknown) => { filters.push((row) => row[c] === v); return query; }, delete: () => { deleting = true; return query; }, limit: () => query, range: () => query, order: () => query, then(resolve: (v: unknown) => unknown) {
      const rows = (populated[table] ?? []).filter((row) => filters.every((filter) => filter(row)));
      if (deleting) { calls.push(`delete:${table}`); populated[table] = (populated[table] ?? []).filter((row) => !rows.includes(row)); }
      return Promise.resolve({ data: rows, count: rows.length, error: null }).then(resolve);
    } }; return query;
  }, rpc: async () => ({ data: [], error: null }), storage: { from: () => ({ list: async () => ({ data: [], error: null }) }) }, auth: { admin: {
    getUserById: async (id: string) => users.has(id) ? { data: { user: users.get(id) }, error: null } : { data: { user: null }, error: { status: 404, code: "user_not_found" } },
    listUsers: async () => ({ data: { users: [...users.values()].map((user) => ({ id: user.id, email: user.email, created_at: user.created_at, app_metadata: user.app_metadata })) }, error: null }),
    deleteUser: async (id: string) => { expect(users.has(id)).toBe(true); calls.push("auth-delete"); users.delete(id); populated.profiles = (populated.profiles ?? []).filter((row) => row.id !== id); populated.profile_roles = (populated.profile_roles ?? []).filter((row) => row.user_id !== id); populated.phone_otp_challenges = (populated.phone_otp_challenges ?? []).filter((row) => row.auth_user_id !== id); return { error: null }; },
  } } } as unknown as SupabaseClient;
  const observer = { query: async (sql: string) => sql.includes("session_counts") ? { rows: [{ project_ref: "emstjswhotsnyksqhqyf", sessions: 0, refresh_tokens: 0 }] } : { rows: [{ parent_schema: "auth", parent_table: "users", child_schema: "public", child_table: "profiles", parent_columns: ["id"], child_columns: ["id"], confdeltype: "c" }] }, end: async () => undefined };
  const managerPurge = vi.fn(async () => { calls.push("manager-purge"); });
  return { dir, file, manifest, db, observer, managerPurge, populated, calls, users };
}
it("cleans an early signup through the real scope guards and exact canonical actor call, then resumes idempotently", async () => {
  const f = fixture();
  try {
    const deps = { db: f.db, observer: f.observer, managerPurge: f.managerPurge };
    await cleanupSignupReservations([{ file: f.file, manifest: f.manifest }], deps);
    expect(f.calls).toEqual(["manager-purge", "auth-delete"]);
    expect(f.managerPurge).toHaveBeenCalledWith(f.db, f.manifest.actorId, true, f.manifest.email);
    expect(readSignupJournal(f.file).phase).toBe("complete");
    await cleanupSignupReservations([{ file: f.file, manifest: readSignupJournal(f.file) }], deps);
    expect(f.calls).toEqual(["manager-purge", "auth-delete"]);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
function unhydratedReservation(f: ReturnType<typeof fixture>) {
  const nonce = "c".repeat(32);
  const manifest: SignupJournal = { ...f.manifest, nonce, email: `p8-manager-${nonce}-draft@example.invalid` };
  delete manifest.actorId; delete manifest.actorCreatedAt;
  const file = path.join(f.dir, `p8-${nonce}.manifest.json`);
  persistSignupJournal(file, manifest);
  const user = f.users.values().next().value!;
  f.users.set(user.id, { ...user, email: manifest.email });
  return { file, manifest };
}
it("hydrates an unrecorded actor from sparse discovery before the existing exact cleanup guards", async () => {
  const f = fixture(); const reservation = unhydratedReservation(f);
  const detail = vi.spyOn(f.db.auth.admin, "getUserById");
  try {
    await cleanupSignupReservations([reservation], f);
    expect(detail.mock.calls.every(([id]) => id === f.manifest.actorId)).toBe(true);
    expect(detail.mock.calls.length).toBeGreaterThan(1);
    expect(f.managerPurge).toHaveBeenCalledWith(f.db, f.manifest.actorId, true, reservation.manifest.email);
    expect(f.calls).toEqual(["manager-purge", "auth-delete"]);
    expect(readSignupJournal(reservation.file)).toMatchObject({ actorId: f.manifest.actorId, actorCreatedAt: f.manifest.actorCreatedAt, phase: "complete" });
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
it.each(["error", "throw", "missing", "wrong id", "wrong email", "changed creation", "empty identities"])("refuses unrecorded actor hydration on %s before purge or delete", async (mode) => {
  const f = fixture(); const reservation = unhydratedReservation(f);
  try {
    const user = f.users.values().next().value!;
    const detail = vi.spyOn(f.db.auth.admin, "getUserById");
    if (mode === "throw") detail.mockRejectedValue(new Error("private provider payload"));
    else detail.mockResolvedValue({ data: { user: mode === "missing" ? null : { ...user, ...(mode === "wrong id" ? { id: "22222222-2222-4222-8222-222222222222" } : {}), ...(mode === "wrong email" ? { email: "private@example.invalid" } : {}), ...(mode === "changed creation" ? { created_at: "2026-01-01T00:00:02Z" } : {}), ...(mode === "empty identities" ? { identities: [] } : {}) } }, error: mode === "error" ? new Error("private provider payload") : null } as never);
    const before = readFileSync(reservation.file, "utf8"), memory = structuredClone(reservation.manifest);
    await expect(cleanupSignupReservations([reservation], f)).rejects.toThrow(/^Signup fixture cleanup refused\.$/);
    expect(detail).toHaveBeenCalledExactlyOnceWith(f.manifest.actorId);
    expect(f.calls).toEqual([]); expect(f.managerPurge).not.toHaveBeenCalled();
    expect(readFileSync(reservation.file, "utf8")).toBe(before); expect(reservation.manifest).toEqual(memory);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
it("retains session refusal after successful hydration of an unrecorded actor", async () => {
  const f = fixture(); const reservation = unhydratedReservation(f);
  try {
    f.observer.query = async () => ({ rows: [{ project_ref: "emstjswhotsnyksqhqyf", sessions: 1, refresh_tokens: 0 }] });
    await expect(cleanupSignupReservations([reservation], f)).rejects.toThrow(/^Signup fixture cleanup refused\.$/);
    expect(readSignupJournal(reservation.file)).toMatchObject({ actorId: f.manifest.actorId, actorCreatedAt: f.manifest.actorCreatedAt, phase: "reserved" });
    expect(f.calls).toEqual([]); expect(f.managerPurge).not.toHaveBeenCalled();
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
it("refuses a foreign co-manager reference before any destructive call", async () => {
  const f = fixture();
  try {
    f.populated.portal_pro_relationship_records = [{ related_user_id: f.manifest.actorId, manager_user_id: "foreign" }];
    await expect(cleanupSignupReservations([{ file: f.file, manifest: f.manifest }], f)).rejects.toThrow("refused");
    expect(f.calls).toEqual([]);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
it("preserves the begun phase after canonical failure and can retry the same actor", async () => {
  const f = fixture();
  try {
    const failed = vi.fn(async () => { throw new Error("private provider payload"); });
    await expect(cleanupSignupReservations([{ file: f.file, manifest: f.manifest }], { ...f, managerPurge: failed })).rejects.toThrow("Signup fixture cleanup refused.");
    expect(readSignupJournal(f.file).phase).toBe("cleanup-started");
    expect(f.calls).toEqual([]);
    await cleanupSignupReservations([{ file: f.file, manifest: readSignupJournal(f.file) }], f);
    expect(f.calls).toEqual(["manager-purge", "auth-delete"]);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
it("refuses sessions or unknown manifest-owned rows before purge", async () => {
  for (const mode of ["session", "unknown"]) {
    const f = fixture();
    try {
      if (mode === "session") f.observer.query = async () => ({ rows: [{ project_ref: "emstjswhotsnyksqhqyf", sessions: 1, refresh_tokens: 0 }] });
      else f.populated.portal_work_order_records = [{ manager_user_id: f.manifest.actorId }];
      await expect(cleanupSignupReservations([{ file: f.file, manifest: f.manifest }], f)).rejects.toThrow();
      expect(f.calls).toEqual([]);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  }
});
it.each(["resolved", "unresolved"] as const)("reconciles a full same-pair %s application and phone contacts, purges resident before manager, and repeats safely", async (applicationState) => {
  const f = fixture();
  const residentId = "22222222-2222-4222-8222-222222222222", residentNonce = "b".repeat(32);
  const propertyId = "33333333-3333-4333-8333-333333333333", appId = "PROPLANE-ABCDEF12", threadId = `app_submit_PROPLANE-ABCDEF12_${f.manifest.actorId}`;
  const resident: SignupJournal = { ...f.manifest, nonce: residentNonce, actorId: residentId, tier: "resident", email: `p8-resident-${residentNonce}-resident@example.invalid`, fullName: "P8 resident manager", phone: "+12065550101", registered: true, phoneBound: true, phase: "phone-bound", pairedActorId: f.manifest.actorId, pairedNonce: f.manifest.nonce };
  const residentFile = path.join(f.dir, `p8-${residentNonce}.manifest.json`);
  f.manifest.registered = true; f.manifest.phoneBound = true; f.manifest.phase = "phone-bound"; f.manifest.pairedActorId = residentId; f.manifest.pairedNonce = residentNonce;
  f.manifest.inventory = [
    { namespace: "property", state: "resolved", id: propertyId, actorId: f.manifest.actorId!, marker: f.manifest.nonce },
    { namespace: "listing", state: "unresolved", actorId: f.manifest.actorId!, marker: f.manifest.nonce },
    { namespace: "application", state: applicationState, ...(applicationState === "resolved" ? { id: appId } : {}), propertyId, residentActorId: residentId, actorId: f.manifest.actorId!, marker: f.manifest.nonce },
    { namespace: "resident-threads", state: "unresolved", propertyId, residentActorId: residentId, actorId: f.manifest.actorId!, marker: f.manifest.nonce },
  ];
  persistSignupJournal(f.file, f.manifest); persistSignupJournal(residentFile, resident);
  for (const journal of [f.manifest, resident]) f.users.set(journal.actorId!, { id: journal.actorId!, email: journal.email, created_at: "2026-01-01T00:00:01Z", app_metadata: { proplane_email_onboarding: true }, identities: [{ provider: "email" }, { provider: "phone", identity_data: { phone: journal.phone.slice(1) } }], phone: journal.phone.slice(1), phone_confirmed_at: "2026-01-01T00:00:02Z" } as never);
  f.populated.profiles = [f.manifest, resident].map((j) => ({ id: j.actorId, email: j.email, full_name: j.fullName, phone: j.phone, phone_verified_at: "2026-01-01T00:00:02Z", manager_id: j.tier === "pro" ? "PROPLANE-ABCDEF12" : null }));
  f.populated.profile_roles = [{ user_id: f.manifest.actorId, role: "manager" }, { user_id: residentId, role: "resident" }];
  f.populated.manager_property_records = [{ id: propertyId, manager_user_id: f.manifest.actorId, row_data: { name: f.manifest.nonce } }];
  f.populated.manager_application_records = [{ id: appId, manager_user_id: f.manifest.actorId, resident_email: resident.email, property_id: propertyId, row_data: { id: appId, residentUserId: residentId, email: resident.email, propertyId } }];
  f.populated.portal_inbox_thread_records = [{ id: threadId, owner_user_id: f.manifest.actorId, participant_email: resident.email, scope: "axis_portal_inbox_manager_v1" }];
  const taskRecordId = `axis_manager_tasks_v1_${f.manifest.actorId}`;
  f.populated.portal_schedule_records = [{ id: taskRecordId, manager_user_id: f.manifest.actorId, property_id: null, test_workspace_id: null, record_type: "manager_tasks", row_data: { id: taskRecordId, recordType: "manager_tasks", managerUserId: f.manifest.actorId, tasks: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", title: "Review application", propertyId, dueDate: "2026-01-03T00:00:00Z", completed: false, assignee: { type: "team", id: f.manifest.actorId, name: f.manifest.fullName }, taskType: "general", urgency: "deadline", templateKey: "review_application", sourceId: appId, dedupKey: `review_application:${appId}`, createdAt: "2026-01-02T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z" }] } }];
  f.populated.sms_phone_contacts = [f.manifest, resident].map((j) => ({ phone_e164: j.phone, user_id: j.actorId, display_name: null, first_seen_at: "2026-01-01T00:00:02Z", last_seen_at: "2026-01-01T00:00:02Z" }));
  const residentPurge = vi.fn(async () => { f.calls.push("resident-purge"); f.populated.manager_application_records = []; f.populated.portal_inbox_thread_records = []; });
  const managerPurge = vi.fn(async () => { f.calls.push("manager-purge"); f.populated.manager_property_records = []; f.populated.portal_schedule_records = []; });
  const reservations = () => [f.file, residentFile].map((file) => ({ file, manifest: readSignupJournal(file) }));
  try {
    const originalQuery = f.observer.query;
    f.observer.query = async (sql) => {
      const result = await originalQuery(sql);
      if (!sql.includes("session_counts")) result.rows.push({ parent_schema: "public", parent_table: "manager_application_records", child_schema: "public", child_table: "unclassified_children", parent_columns: ["id"], child_columns: ["application_id"], confdeltype: "c" } as never);
      return result;
    };
    f.populated.unclassified_children = [{ application_id: appId }];
    await expect(cleanupSignupReservations(reservations(), { ...f, residentPurge, managerPurge })).rejects.toThrow();
    expect(f.calls).toEqual([]);
    f.populated.unclassified_children = []; f.observer.query = originalQuery;
    await cleanupSignupReservations(reservations(), { ...f, residentPurge, managerPurge });
    expect(f.calls).toEqual(["delete:sms_phone_contacts", "resident-purge", "auth-delete", "delete:sms_phone_contacts", "manager-purge", "auth-delete"]);
    expect(readSignupJournal(f.file).phase).toBe("complete"); expect(readSignupJournal(residentFile).phase).toBe("complete");
    await cleanupSignupReservations(reservations(), { ...f, residentPurge, managerPurge });
    expect(residentPurge).toHaveBeenCalledOnce(); expect(managerPurge).toHaveBeenCalledOnce();
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
it("cleans a start failure that created no Auth actor without inventing ID authority", async () => {
  const f = fixture();
  try {
    delete f.manifest.actorId; delete f.manifest.actorCreatedAt;
    // A fresh reservation file, before any actor was identified.
    const file = path.join(f.dir, `p8-${"c".repeat(32)}.manifest.json`);
    const manifest = { ...f.manifest, nonce: "c".repeat(32), email: `p8-manager-${"c".repeat(32)}-draft@example.invalid` };
    persistSignupJournal(file, manifest); f.users.clear();
    await cleanupSignupReservations([{ file, manifest }], f);
    expect(readSignupJournal(file).phase).toBe("complete"); expect(f.calls).toEqual([]);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
it("refuses changed contact state, provider rows, foreign cascades and uploaded bytes before deletion", async () => {
  for (const mode of ["contact", "provider", "cascade", "storage"]) {
    const f = fixture();
    try {
      if (mode === "contact") {
        f.manifest.contactDelete = { firstSeenAt: "2026-01-01T00:00:02Z", lastSeenAt: "2026-01-01T00:00:02Z" }; persistSignupJournal(f.file, f.manifest);
        f.populated.sms_phone_contacts = [{ phone_e164: f.manifest.phone, user_id: f.manifest.actorId, display_name: null, first_seen_at: "2026-01-01T00:00:02Z", last_seen_at: "2026-01-01T00:00:03Z" }];
      }
      if (mode === "provider") f.populated.manager_purchases = [{ user_id: f.manifest.actorId, email: f.manifest.email, tier: "pro", billing: "trial", stripe_checkout_session_id: "cs_real" }];
      if (mode === "cascade") {
        const original = f.observer.query;
        f.observer.query = async (sql) => {
          const result = await original(sql);
          if (!sql.includes("session_counts")) result.rows.push({ parent_schema: "auth", parent_table: "users", child_schema: "public", child_table: "unclassified_children", parent_columns: ["id"], child_columns: ["user_id"], confdeltype: "c" } as never);
          return result;
        };
        f.populated.unclassified_children = [{ user_id: f.manifest.actorId, owner_user_id: "foreign" }];
      }
      if (mode === "storage") (f.db.storage as unknown as { from: () => unknown }).from = () => ({ list: async () => ({ data: [{ name: "unexpected.pdf" }], error: null }) });
      await expect(cleanupSignupReservations([{ file: f.file, manifest: f.manifest }], f)).rejects.toThrow("Signup fixture cleanup refused.");
      expect(f.calls).toEqual([]);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  }
});
it("resumes after Auth deletion failed, and refuses a replacement with a different creation timestamp", async () => {
  const f = fixture();
  try {
    const original = f.db.auth.admin.deleteUser;
    f.db.auth.admin.deleteUser = vi.fn(async () => ({ data: { user: null }, error: new Error("failed") })) as never;
    await expect(cleanupSignupReservations([{ file: f.file, manifest: f.manifest }], f)).rejects.toThrow();
    expect(readSignupJournal(f.file).phase).toBe("auth-delete-started");
    const user = f.users.get(f.manifest.actorId!)!;
    f.users.set(user.id, { ...user, created_at: "2026-01-01T01:00:00Z" });
    await expect(cleanupSignupReservations([{ file: f.file, manifest: readSignupJournal(f.file) }], f)).rejects.toThrow();
    f.users.set(user.id, user); f.db.auth.admin.deleteUser = original;
    await cleanupSignupReservations([{ file: f.file, manifest: readSignupJournal(f.file) }], f);
    expect(readSignupJournal(f.file).phase).toBe("complete");
    expect(f.managerPurge).toHaveBeenCalledOnce();
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

it("resumes at the same contact after interruption on either side of its deletion", async () => {
  for (const point of ["before", "after"]) {
    const f = fixture();
    try {
      f.populated.sms_phone_contacts = [{ phone_e164: f.manifest.phone, user_id: f.manifest.actorId, display_name: null, first_seen_at: "2026-01-01T00:00:02Z", last_seen_at: "2026-01-01T00:00:02Z" }];
      if (point === "before") {
        const realFrom = f.db.from.bind(f.db);
        let failed = false;
        f.db.from = ((table: string) => {
          const query = realFrom(table);
          if (table === "sms_phone_contacts" && !failed) {
            const originalDelete = query.delete.bind(query);
            query.delete = (() => { failed = true; throw new Error("interrupted before delete"); }) as typeof query.delete;
            void originalDelete;
          }
          return query;
        }) as typeof f.db.from;
      }
      const interruptedPurge = vi.fn(async () => { throw new Error("interrupted after delete"); });
      await expect(cleanupSignupReservations([{ file: f.file, manifest: f.manifest }], { ...f, managerPurge: interruptedPurge })).rejects.toThrow();
      expect(readSignupJournal(f.file).phase).toBe("cleanup-started");
      expect(f.populated.sms_phone_contacts).toHaveLength(point === "before" ? 1 : 0);
      await cleanupSignupReservations([{ file: f.file, manifest: readSignupJournal(f.file) }], f);
      expect(readSignupJournal(f.file).phase).toBe("complete");
      expect(f.calls.filter((call) => call === "delete:sms_phone_contacts")).toHaveLength(1);
      expect(f.calls.filter((call) => call === "auth-delete")).toHaveLength(1);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  }
});

const refusedSubjects = [
  ["foreign", { residentUserId: "99999999-9999-4999-8999-999999999999" }],
  ["missing", undefined], ["null", null], ["missing subject", {}],
  ["malformed", { residentUserId: "not-a-uuid" }], ["nonstring", { residentUserId: 123 }],
  ["array", []], ["primitive", "resident"],
  ["contradictory inventory", { residentUserId: "22222222-2222-4222-8222-222222222222" }],
  ["missing inventory subject", { residentUserId: "22222222-2222-4222-8222-222222222222" }],
] as const;
it.each(["resolved", "unresolved"] as const)("refuses invalid resident subjects in %s inventory before any mutation or journal resolution", async (state) => {
  for (const [mode, rowData] of refusedSubjects) {
    const f = fixture();
    try {
      const residentId = "22222222-2222-4222-8222-222222222222", nonce = "b".repeat(32), propertyId = "fixture-property", appId = "PROPLANE-ABCDEF12";
      const resident: SignupJournal = { ...f.manifest, nonce, actorId: residentId, tier: "resident", email: `p8-resident-${nonce}-resident@example.invalid`, fullName: "P8 resident manager", phone: "+12065550101", pairedActorId: f.manifest.actorId, pairedNonce: f.manifest.nonce };
      const residentFile = path.join(f.dir, `p8-${nonce}.manifest.json`);
      f.manifest.pairedActorId = residentId; f.manifest.pairedNonce = nonce;
      f.manifest.inventory = [
        { namespace: "property", state: "resolved", id: propertyId, actorId: f.manifest.actorId!, marker: f.manifest.nonce },
        { namespace: "application", state, ...(state === "resolved" ? { id: appId } : {}), propertyId, residentActorId: mode === "contradictory inventory" ? "99999999-9999-4999-8999-999999999999" : mode === "missing inventory subject" ? undefined : residentId, actorId: f.manifest.actorId!, marker: f.manifest.nonce },
      ];
      persistSignupJournal(f.file, f.manifest); persistSignupJournal(residentFile, resident);
      f.users.set(residentId, { ...f.users.get(f.manifest.actorId!)!, id: residentId, email: resident.email });
      f.populated.manager_property_records = [{ id: propertyId, manager_user_id: f.manifest.actorId, row_data: { name: f.manifest.nonce } }];
      f.populated.manager_application_records = [{ id: appId, manager_user_id: f.manifest.actorId, resident_email: resident.email, property_id: propertyId, row_data: rowData }];
      f.populated.sms_phone_contacts = [f.manifest, resident].map((j) => ({ phone_e164: j.phone, user_id: j.actorId, display_name: null, first_seen_at: "2026-01-01T00:00:02Z", last_seen_at: "2026-01-01T00:00:02Z" }));
      const before = [f.file, residentFile].map((file) => readFileSync(file, "utf8"));
      const residentPurge = vi.fn(async () => { f.calls.push("resident-purge"); });
      await expect(cleanupSignupReservations([f.file, residentFile].map((file) => ({ file, manifest: readSignupJournal(file) })), { ...f, residentPurge }), mode).rejects.toThrow("Signup fixture cleanup refused.");
      expect(f.calls, mode).toEqual([]); expect(f.managerPurge, mode).not.toHaveBeenCalled(); expect(residentPurge, mode).not.toHaveBeenCalled();
      expect([f.file, residentFile].map((file) => readFileSync(file, "utf8")), mode).toEqual(before);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  }
});
