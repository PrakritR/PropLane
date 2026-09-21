import "server-only";

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { submissionFromImportedProperty } from "@/lib/property-import/to-submission";
import type { PropertyImportProperty, PropertyImportRoom } from "@/lib/property-import/types";
import { deriveLegacyFields } from "@/lib/demo-property-pipeline";
import { submissionToDraftAdminRow, mintManagerPropertyId } from "@/lib/demo-admin-property-inventory";
import { buildImportedResidentRow } from "@/lib/resident-document-import/build-application-row";
import { provisionApprovedResidentAccount } from "@/lib/auth/provision-approved-resident";
import { runExistingResidentOnboarding } from "@/lib/existing-resident-onboarding.server";
import type { ResidentWelcomeActor } from "@/lib/resident-welcome.server";
import { sealApplicantRow } from "@/lib/security/applicant-identity";
import { syncLedgerChargeEntry } from "@/lib/reports/ledger-sync";
import type { HouseholdCharge, HouseholdChargeKind } from "@/lib/household-charges";
import { createManagerTaskRow, loadManagerTasks } from "@/lib/manager-tasks.server";
import { placeholderImportEmail } from "@/lib/portfolio-import/placeholder-email";
import { loadImportProposal, setImportStatus, applyAnswersAndSkips } from "@/lib/portfolio-import/store.server";
import type {
  ImportChargeProposal,
  ImportPropertyProposal,
  ImportResidentProposal,
  ImportTaskProposal,
  PortfolioImportCreateCounts,
  PortfolioImportCreateFailure,
  PortfolioImportCreateRequest,
  PortfolioImportCreateResult,
} from "@/lib/portfolio-import/types";

/**
 * Portfolio import (rebuilt) — turns an approved proposal into real records,
 * through the SAME creation paths every other entry point uses:
 *
 *  - rooms/properties -> a listing DRAFT via `submissionFromImportedProperty`
 *    (src/lib/property-import/to-submission.ts, unchanged) and the exact row
 *    `saveManagerPropertyDraftToServer` would build — that function is
 *    browser-only (it round-trips through `fetch`), so this calls its two
 *    now-exported pure builders (`submissionToDraftAdminRow`,
 *    `mintManagerPropertyId`) directly and upserts `manager_property_records`
 *    itself, the same way `create_property` and every other server-side
 *    write tool bypasses the HTTP route rather than duplicating its quota /
 *    service-fee / workspace logic (AGENTS.md "tools never fetch() internal
 *    routes"). A draft never charges the plan's listing-slot quota
 *    (`manager-first-listing-onboarding.ts`), and the workspace trigger
 *    (`enforce_portal_workspace_limit`) assigns the manager's default
 *    workspace itself when none is given, enforcing the real 10-per-workspace
 *    cap even on this direct path.
 *  - residents -> `buildImportedResidentRow` (the exact sibling
 *    `build-application-row.ts` built for this), upserted into
 *    `manager_application_records`, then `provisionApprovedResidentAccount`
 *    (auth account) and `runExistingResidentOnboarding` (the lease stub +
 *    optional welcome) — the same three steps the manager-applications route
 *    runs for a manually-added existing resident.
 *  - leases -> created BY `runExistingResidentOnboarding` itself: a resident
 *    with no attached signed document gets a `bucket: "manager"` lease with
 *    `managerAttestedTenancyAt` set (establishes tenancy without fabricating
 *    a signature) — genuinely unsigned, which is why every imported resident
 *    also gets an `unsigned_lease` task.
 *  - charges -> a `HouseholdCharge` row upserted into
 *    `portal_household_charge_records`, then `syncLedgerChargeEntry` (the
 *    write-through ledger sync every other charge path calls next to its own
 *    insert — docs/agents/financials.md).
 *  - tasks -> `createManagerTaskRow` (src/lib/manager-tasks.server.ts).
 *
 * Every write is scoped to `actor.userId` (the authenticated manager from
 * context — never from the request body) and carries `source: "import"` plus
 * the originating file name (`HouseholdCharge.migrationSourceId`,
 * `ManagerTask.sourceId`, the resident row's own `manualResidentDetails`) —
 * see docs/agents/portfolio-import.md.
 *
 * ONE property at a time: ids inside a property (the draft, the resident row,
 * each charge) are deterministic — `shortHash(importId + proposal key)` — so
 * re-running create() after a partial failure upserts the SAME rows rather
 * than duplicating them. A property that throws partway is unwound with
 * best-effort compensating deletes of what THIS attempt created (the draft,
 * the application row, the lease row, the charge rows) before moving to the
 * next property; a provisioned auth account / profile is deliberately never
 * deleted on rollback (it may be shared with another property, and
 * `silent_migration` mode never emails or overwrites an existing one, so
 * leaving it is lower-risk than removing it). This is compensating rollback,
 * not a database transaction — there is no multi-table Postgres transaction
 * available from the service-role JS client without a dedicated RPC, and
 * every other write path in this codebase (see `commit.server.ts`'s
 * pre-rebuild history) uses the same idempotent-upsert-plus-compensation
 * shape rather than one. Manager TASKS are stored one JSON array per manager
 * (`manager-tasks.server.ts`) and `createManagerTaskRow` always appends
 * rather than upserting by id, so THIS module guards retry-safety itself:
 * `createTask` gives every import task a deterministic id
 * (`task_import_<shortHash(task.key)>`, same convention as charges) and
 * checks it against this manager's current tasks before calling
 * `createManagerTaskRow`, skipping the append when a task with that id
 * already exists — a literal retry of the same create() call therefore never
 * duplicates a task.
 */

export class PortfolioImportNotFoundError extends Error {
  constructor() {
    super("No import with that id belongs to this manager.");
    this.name = "PortfolioImportNotFoundError";
  }
}

function shortHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 12);
}

function slug(s: string, max = 24): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, max) || "resident";
}

/**
 * `ImportPropertyProposal` (the contract the review UI reads) deliberately
 * carries only `address` + rooms, not the full city/state/zip/property-type
 * richness `PropertyImportUnderstanding` read — that richness lives in the
 * FIRST model pass and is not re-derivable from the proposal alone. The
 * created draft starts with address + room rents/names filled and everything
 * else at `createDefaultListingSubmission()`'s defaults, exactly like a
 * manager who typed a new listing and has not reached Basics' other fields
 * yet — they finish it in the wizard, same as any other draft.
 */
function toPropertyImportProperty(property: ImportPropertyProposal): PropertyImportProperty {
  const rooms: PropertyImportRoom[] = property.rooms.map((r) => ({
    label: r.name,
    rent: r.rent,
    deposit: null,
    sourceRow: r.source.rows?.[0] ?? null,
  }));
  const rentByRoom = rooms.length > 1;
  return {
    key: property.key,
    name: property.address,
    address: property.address,
    city: "",
    state: "",
    zip: "",
    propertyType: "house",
    rentByRoom,
    bedrooms: Math.max(1, rooms.length || 1),
    bathrooms: null,
    monthlyRent: !rentByRoom ? (rooms[0]?.rent ?? null) : null,
    deposit: null,
    rooms,
    sourceSheet: property.source.sheet ?? "",
    sourceRows: property.source.rows ?? [],
    needsLook: [],
    confidence: "medium",
  };
}

async function createPropertyDraft(
  db: SupabaseClient,
  landlordId: string,
  property: ImportPropertyProposal,
): Promise<{ propertyId: string; roomIdByKey: Map<string, string>; wholePlaceRoomId: string | undefined }> {
  const importedProperty = toPropertyImportProperty(property);
  const submission = submissionFromImportedProperty(importedProperty);
  const legacy = deriveLegacyFields(submission);
  const propertyId = mintManagerPropertyId(legacy);
  const row = submissionToDraftAdminRow(submission, landlordId, propertyId, {});

  const { error } = await db
    .from("manager_property_records")
    .upsert(
      { id: propertyId, manager_user_id: landlordId, status: "draft", row_data: row, updated_at: new Date().toISOString() },
      { onConflict: "id" },
    );
  if (error) throw new Error(error.message);

  const roomIdByKey = new Map<string, string>();
  property.rooms.forEach((r, i) => {
    const roomId = submission.rooms[i]?.id;
    if (roomId) roomIdByKey.set(r.key, roomId);
  });
  // A whole-place property the file never broke into rooms proposes zero
  // `ImportRoomProposal`s (nothing to name), but `submissionFromImportedProperty`
  // still creates at least one room slot with a REAL, randomly generated id
  // (`emptyRoom`/`rid("room")` — never a predictable "room-1"). Residents with
  // no `roomKey` fall back to that slot's actual id, never a guessed string.
  const wholePlaceRoomId = submission.rooms[0]?.id;
  return { propertyId, roomIdByKey, wholePlaceRoomId };
}

type ResidentCreateResult = {
  applicationId: string;
  leaseId: string;
  email: string;
  residentUserId: string | null;
  welcomeSent: boolean;
};

async function createResident(
  db: SupabaseClient,
  actor: ResidentWelcomeActor & { managerName?: string },
  fileName: string,
  propertyId: string,
  propertyLabel: string,
  roomId: string,
  resident: ImportResidentProposal,
  opts: { sendInvites: boolean },
): Promise<ResidentCreateResult> {
  const email = resident.email || placeholderImportEmail(slug(resident.name), shortHash(resident.key).slice(0, 8));
  const applicationId = `PROPLANE-IMP${shortHash(resident.key).toUpperCase()}`;

  const row = buildImportedResidentRow({
    id: applicationId,
    name: resident.name,
    email,
    phone: resident.phone,
    propertyId,
    propertyLabel,
    roomId,
    leaseStart: resident.leaseStart,
    leaseEnd: resident.leaseEnd,
    rent: resident.rent,
    deposit: resident.deposit,
    leasePdf: null,
    managerUserId: actor.userId,
  });
  // `DemoApplicantRow.detail` is a free-text note surfaced on the resident's
  // card; stamping it is the cheapest honest "where this came from" — the
  // type has no dedicated import-source field the way `HouseholdCharge` does
  // (`migrationSourceId`) or `ManagerTask` does (`sourceId`).
  row.detail = `Imported from ${fileName}.`;

  const sealed = sealApplicantRow(row, row.id, actor.userId);
  const { error: upsertError } = await db.from("manager_application_records").upsert(
    {
      id: row.id,
      manager_user_id: actor.userId,
      resident_email: email,
      property_id: propertyId,
      assigned_property_id: propertyId,
      row_data: sealed,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id" },
  );
  if (upsertError) throw new Error(upsertError.message);

  const provision = await provisionApprovedResidentAccount(db, row, { mode: "silent_migration" });
  if (!provision.ok) throw new Error(provision.error);

  const onboarding = await runExistingResidentOnboarding(db, actor, row, { sendWelcomeEmail: opts.sendInvites });
  if (!onboarding.ok) throw new Error(onboarding.error);

  return { applicationId: row.id, leaseId: onboarding.leaseId, email, residentUserId: provision.userId, welcomeSent: onboarding.welcomeEmailSent };
}

async function createCharge(
  db: SupabaseClient,
  landlordId: string,
  propertyId: string,
  propertyLabel: string,
  resident: { email: string; name: string; userId: string | null },
  charge: ImportChargeProposal,
): Promise<string> {
  const kind: HouseholdChargeKind = charge.kind === "rent" ? "rent" : charge.kind === "deposit" ? "security_deposit" : "other_cost";
  const id = `chg_import_${shortHash(charge.key)}`;
  const amountLabel = `$${charge.amount.toFixed(2)}`;
  const chargeRow: HouseholdCharge = {
    migrationSourceId: charge.source.file,
    id,
    createdAt: new Date().toISOString(),
    residentEmail: resident.email,
    residentName: resident.name,
    residentUserId: resident.userId,
    propertyId,
    propertyLabel,
    managerUserId: landlordId,
    kind,
    title: charge.label,
    amountLabel,
    balanceLabel: amountLabel,
    status: "pending",
    blocksLeaseUntilPaid: false,
  };
  const { error } = await db.from("portal_household_charge_records").upsert(
    {
      id,
      manager_user_id: landlordId,
      resident_user_id: resident.userId,
      resident_email: resident.email,
      property_id: propertyId,
      kind,
      status: "pending",
      row_data: chargeRow,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id" },
  );
  if (error) throw new Error(error.message);
  await syncLedgerChargeEntry(db, chargeRow);
  return id;
}

/**
 * Creates one imported task, unless a task with this deterministic id was
 * already created by an earlier call (a retry of the same `create()` call on
 * this import) — `existingTaskIds` is loaded once per `createPortfolioImportRecords`
 * call and updated in place so two tasks in the SAME call never race each
 * other either. Returns whether a task was actually created (for the caller's
 * count).
 */
async function createTask(
  db: SupabaseClient,
  landlordId: string,
  propertyId: string,
  propertyLabel: string,
  importId: string,
  task: ImportTaskProposal,
  existingTaskIds: Set<string>,
): Promise<boolean> {
  const id = `task_import_${shortHash(task.key)}`;
  if (existingTaskIds.has(id)) return false;
  await createManagerTaskRow(db, landlordId, {
    id,
    title: task.title,
    propertyId,
    propertyTitle: propertyLabel,
    taskType: "general",
    assignee: { type: "team", id: landlordId, name: "" },
    sourceId: `portfolio-import:${importId}`,
    dedupKey: `portfolio-import:${task.key}`,
    notes: `Imported from ${task.source.file}${task.source.sheet ? ` (${task.source.sheet})` : ""}.`,
  });
  existingTaskIds.add(id);
  return true;
}

async function rollbackProperty(db: SupabaseClient, landlordId: string, undo: Array<() => Promise<void>>): Promise<void> {
  for (const step of undo.reverse()) {
    await step().catch(() => undefined);
  }
  void landlordId;
}

export async function createPortfolioImportRecords(
  db: SupabaseClient,
  actor: ResidentWelcomeActor & { managerName?: string },
  importId: string,
  request: PortfolioImportCreateRequest,
): Promise<PortfolioImportCreateResult> {
  const loaded = await loadImportProposal(db, actor.userId, importId);
  if (!loaded) throw new PortfolioImportNotFoundError();
  const proposal = applyAnswersAndSkips(loaded.proposal, request);

  await setImportStatus(db, actor.userId, importId, "committing");

  const created: PortfolioImportCreateCounts = { properties: 0, rooms: 0, residents: 0, leases: 0, charges: 0, tasks: 0, invites: 0 };
  const failures: PortfolioImportCreateFailure[] = [];
  // Loaded ONCE, up front, and kept current in place by `createTask` — see
  // `createTask`'s own comment and this module's header for why tasks (never
  // properties, residents, or charges) need this instead of a deterministic
  // upsert.
  const existingTaskIds = new Set((await loadManagerTasks(db, actor.userId)).map((t) => t.id));

  for (const property of proposal.properties) {
    if (property.status === "skip") continue;
    const residentsToCreate = property.residents.filter((r) => r.status !== "skip");
    const blocking = residentsToCreate.find((r) => r.status === "needs");
    if (blocking) {
      failures.push({
        propertyKey: property.key,
        address: property.address,
        row: property.source.rows?.[0],
        message: `${blocking.name || "A resident"} still has unanswered questions — answer or skip them before creating.`,
      });
      continue;
    }

    const undo: Array<() => Promise<void>> = [];
    const local: PortfolioImportCreateCounts = { properties: 0, rooms: 0, residents: 0, leases: 0, charges: 0, tasks: 0, invites: 0 };
    try {
      const fileName = property.source.file;
      const { propertyId, roomIdByKey, wholePlaceRoomId } = await createPropertyDraft(db, actor.userId, property);
      undo.push(async () => {
        await db.from("manager_property_records").delete().eq("id", propertyId).eq("manager_user_id", actor.userId);
      });
      local.properties += 1;
      local.rooms += property.rooms.length;

      const fallbackRoomId = (property.rooms[0] ? roomIdByKey.get(property.rooms[0].key) : undefined) ?? wholePlaceRoomId;

      for (const resident of residentsToCreate) {
        const roomId = (resident.roomKey && roomIdByKey.get(resident.roomKey)) || fallbackRoomId;
        if (!roomId) throw new Error("Could not resolve a room for this resident.");
        const result = await createResident(db, actor, fileName, propertyId, property.address, roomId, resident, {
          sendInvites: request.sendInvites,
        });
        undo.push(async () => {
          await db.from("manager_application_records").delete().eq("id", result.applicationId).eq("manager_user_id", actor.userId);
          await db.from("portal_lease_pipeline_records").delete().eq("id", result.leaseId).eq("manager_user_id", actor.userId);
        });
        local.residents += 1;
        local.leases += 1;
        if (request.sendInvites && result.welcomeSent) local.invites += 1;

        for (const charge of property.charges.filter((c) => c.residentKey === resident.key)) {
          const chargeId = await createCharge(
            db,
            actor.userId,
            propertyId,
            property.address,
            { email: result.email, name: resident.name, userId: result.residentUserId },
            charge,
          );
          undo.push(async () => {
            await db.from("portal_household_charge_records").delete().eq("id", chargeId).eq("manager_user_id", actor.userId);
          });
          local.charges += 1;
        }

        for (const task of property.tasks.filter((t) => t.residentKey === resident.key)) {
          const wasCreated = await createTask(db, actor.userId, propertyId, property.address, importId, task, existingTaskIds);
          if (wasCreated) local.tasks += 1;
        }
      }

      created.properties += local.properties;
      created.rooms += local.rooms;
      created.residents += local.residents;
      created.leases += local.leases;
      created.charges += local.charges;
      created.tasks += local.tasks;
      created.invites += local.invites;
    } catch (err) {
      await rollbackProperty(db, actor.userId, undo);
      const message = err instanceof Error ? err.message : "Could not create this property.";
      failures.push({ propertyKey: property.key, address: property.address, row: property.source.rows?.[0], message });
    }
  }

  const status = failures.length === 0 ? "completed" : created.properties > 0 ? "partial" : "failed";
  await setImportStatus(db, actor.userId, importId, status, {
    result: { created, failures },
    committedAt: new Date().toISOString(),
  });

  return { created, failures };
}
