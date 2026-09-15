import "server-only";

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { draftHasBlockingIssues } from "@/lib/portfolio-import/build-draft";
import {
  completeReceipt,
  failReceipt,
  loadPortfolioImport,
  prepareReceipt,
  setPortfolioImportStatus,
} from "@/lib/portfolio-import/store.server";
import type {
  PortfolioImportCommitResult,
  PortfolioImportProperty,
  PortfolioImportRecordKind,
  PortfolioImportResident,
  PortfolioImportUnit,
} from "@/lib/portfolio-import/types";
import {
  createNewListingWizardSubmission,
  emptyRoom,
  normalizeManagerListingSubmissionV1,
  type ManagerListingSubmissionV1,
  type ManagerRoomSubmission,
} from "@/lib/manager-listing-submission";
import type { AdminPropertyRow } from "@/lib/demo-admin-property-inventory";
import { sealApplicantRow } from "@/lib/security/applicant-identity";
import { runExistingResidentOnboarding } from "@/lib/existing-resident-onboarding.server";
import { buildImportedResidentRow } from "@/lib/resident-document-import/build-application-row";
import { upsertManagerCharges } from "@/lib/household-charges.server";
import type { HouseholdCharge } from "@/lib/household-charges";
import { loadManagerTasks, saveManagerTasks } from "@/lib/manager-tasks.server";
import type { ManagerTask } from "@/lib/manager-tasks";
import { track } from "@/lib/analytics/posthog";

/** Thrown when the draft still has unresolved `block`-severity issues. */
export class PortfolioImportBlockedError extends Error {
  constructor(message = "This import has issues that need to be resolved before it can be committed.") {
    super(message);
    this.name = "PortfolioImportBlockedError";
  }
}

export type PortfolioImportCommitActor = {
  userId: string;
  email: string | null;
  managerName?: string;
};

function slugify(s: string): string {
  const slug = s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-+|-+$)/g, "");
  return slug || "property";
}

/** Deterministic short suffix (not random) so a retry after a partial failure lands on the SAME canonical id instead of creating a duplicate. */
function shortHash(...parts: string[]): string {
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 6);
}

function isUnitExcluded(unit: PortfolioImportUnit, properties: Map<string, PortfolioImportProperty>): boolean {
  if (unit.excluded) return true;
  return !!properties.get(unit.propertyKey)?.excluded;
}

function isResidentExcluded(
  resident: PortfolioImportResident,
  units: Map<string, PortfolioImportUnit>,
  properties: Map<string, PortfolioImportProperty>,
): boolean {
  if (resident.excluded) return true;
  const unit = units.get(resident.unitKey);
  if (unit && isUnitExcluded(unit, properties)) return true;
  return !!properties.get(resident.propertyKey)?.excluded;
}

type StageAccumulator = { done: number; total: number; failed: number };
type Stages = Record<PortfolioImportRecordKind, StageAccumulator>;

function emptyStages(): Stages {
  return {
    property: { done: 0, total: 0, failed: 0 },
    room: { done: 0, total: 0, failed: 0 },
    resident: { done: 0, total: 0, failed: 0 },
    balance: { done: 0, total: 0, failed: 0 },
    task: { done: 0, total: 0, failed: 0 },
  };
}

/** Runs one record's create step, recording success/failure onto the receipt and the accumulators. */
async function attempt(
  db: SupabaseClient,
  importId: string,
  stages: Stages,
  failures: PortfolioImportCommitResult["failures"],
  recordKind: PortfolioImportRecordKind,
  sourceKey: string,
  fn: () => Promise<string>,
): Promise<string | null> {
  try {
    const id = await fn();
    stages[recordKind].done += 1;
    return id;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not import this record.";
    await failReceipt(db, importId, recordKind, sourceKey, message).catch(() => undefined);
    stages[recordKind].failed += 1;
    failures.push({ recordKind, sourceKey, message });
    return null;
  }
}

function skip(
  stages: Stages,
  failures: PortfolioImportCommitResult["failures"],
  recordKind: PortfolioImportRecordKind,
  sourceKey: string,
  message: string,
) {
  stages[recordKind].failed += 1;
  failures.push({ recordKind, sourceKey, message });
}

// ---------------------------------------------------------------------------
// Property + room
// ---------------------------------------------------------------------------

async function commitOneProperty(
  db: SupabaseClient,
  importId: string,
  managerUserId: string,
  property: PortfolioImportProperty,
  activeUnits: PortfolioImportUnit[],
  fileName: string,
): Promise<string> {
  const payload = {
    name: property.name,
    address: property.address,
    city: property.city ?? null,
    state: property.state ?? null,
    zip: property.zip ?? null,
    units: activeUnits.map((u) => ({ label: u.label, rent: u.monthlyRent, beds: u.beds ?? null, baths: u.baths ?? null })),
  };
  const receipt = await prepareReceipt(db, {
    importId,
    managerUserId,
    recordKind: "property",
    sourceKey: property.key,
    payload,
  });
  if (receipt.status === "completed" && receipt.canonical_id) return receipt.canonical_id;

  const propertyId = `imp-${slugify(property.name || property.address || "property")}-${shortHash(importId, property.key)}`;

  const rents = activeUnits.map((u) => u.monthlyRent).filter((n): n is number => typeof n === "number" && n > 0);
  const monthlyRent = rents.length > 0 ? Math.min(...rents) : 0;
  const beds = activeUnits.reduce((sum, u) => sum + (u.beds ?? 0), 0) || property.beds;
  const baths = activeUnits.reduce((sum, u) => sum + (u.baths ?? 0), 0) || property.baths;

  const rooms: ManagerRoomSubmission[] = activeUnits.map((unit, index) => ({
    ...emptyRoom(index),
    id: `room-${index + 1}`,
    name: unit.label,
    monthlyRent: unit.monthlyRent ?? 0,
    availability: unit.occupancy === "vacant" ? "Available now" : "Occupied",
    moveInAvailableDate: new Date().toISOString().slice(0, 10),
    rentBasis: "monthly",
    ...(typeof unit.sqft === "number" ? { sizeSqft: unit.sqft } : {}),
    // A unit the file lists with several tenants ("Priya Nair & Tom Ellis") is
    // rented by the bed: the database's capacity guard admits one resident per
    // room unless the room says otherwise, so the second tenant would be refused
    // with "No bed is available". Capacity follows the tenants the file names.
    ...(unit.residentKeys.length > 1
      ? { occupancyCapacity: Math.min(20, unit.residentKeys.length), bedCount: Math.min(20, unit.residentKeys.length) }
      : {}),
  }));

  const submission: ManagerListingSubmissionV1 = normalizeManagerListingSubmissionV1({
    ...createNewListingWizardSubmission(),
    buildingName: property.name || property.address || "Imported property",
    address: property.address,
    zip: property.zip ?? "",
    city: property.city ?? "",
    state: property.state ?? "",
    tagline: `Imported from ${fileName}`,
    rooms,
  });

  const rowData: AdminPropertyRow = {
    adminRefId: propertyId,
    buildingName: submission.buildingName,
    unitLabel: rooms[0]?.name ?? "Unit 1",
    address: property.address,
    zip: property.zip ?? "",
    neighborhood: "",
    beds,
    baths,
    monthlyRent,
    petFriendly: false,
    tagline: `Imported from ${fileName}`,
    listingId: propertyId,
    managerUserId,
    submission,
  };

  const { error } = await db.from("manager_property_records").upsert(
    {
      id: propertyId,
      manager_user_id: managerUserId,
      status: "unlisted",
      row_data: rowData,
      property_data: null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id" },
  );
  if (error) throw new Error(error.message);

  await completeReceipt(db, importId, "property", property.key, propertyId);
  return propertyId;
}

/** Rooms are embedded in the property's own submission (written above) — this step is pure bookkeeping so a resident placement always has a stable room id to reference, even after a retry that skipped a property already created. */
async function commitOneRoom(
  db: SupabaseClient,
  importId: string,
  managerUserId: string,
  propertyId: string,
  unit: PortfolioImportUnit,
  index: number,
): Promise<string> {
  const receipt = await prepareReceipt(db, {
    importId,
    managerUserId,
    recordKind: "room",
    sourceKey: unit.key,
    payload: { propertyId, label: unit.label, rent: unit.monthlyRent, index },
  });
  if (receipt.status === "completed" && receipt.canonical_id) return receipt.canonical_id;
  const roomId = `room-${index + 1}`;
  await completeReceipt(db, importId, "room", unit.key, roomId);
  return roomId;
}

// ---------------------------------------------------------------------------
// Resident
// ---------------------------------------------------------------------------

async function commitOneResident(
  db: SupabaseClient,
  importId: string,
  managerUserId: string,
  actor: PortfolioImportCommitActor,
  resident: PortfolioImportResident,
  propertyId: string,
  propertyLabel: string,
  roomId: string,
): Promise<string> {
  const email = resident.email?.trim().toLowerCase() ?? "";
  const payload = {
    propertyId,
    roomId,
    name: resident.name,
    email,
    phone: resident.phone,
    leaseStart: resident.leaseStart,
    leaseEnd: resident.leaseEnd,
    rent: resident.monthlyRent,
    deposit: resident.securityDeposit,
    hasLeasePdf: Boolean(resident.leasePdf),
  };
  const receipt = await prepareReceipt(db, {
    importId,
    managerUserId,
    recordKind: "resident",
    sourceKey: resident.key,
    payload,
  });
  if (receipt.status === "completed" && receipt.canonical_id) return receipt.canonical_id;

  const applicationId = `PROPLANE-${shortHash(importId, resident.key, "resident").toUpperCase()}`;

  if (email) {
    const { data: conflicting } = await db
      .from("manager_application_records")
      .select("id")
      .eq("resident_email", email)
      .neq("manager_user_id", managerUserId)
      .limit(1)
      .maybeSingle();
    if (conflicting) {
      throw new Error(`A resident record with ${email} already belongs to another manager.`);
    }
  }

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
    rent: resident.monthlyRent,
    deposit: resident.securityDeposit,
    leasePdf: resident.leasePdf ?? null,
    managerUserId,
  });

  const { error } = await db.from("manager_application_records").upsert(
    {
      id: row.id,
      manager_user_id: managerUserId,
      resident_email: email || null,
      assigned_property_id: propertyId,
      property_id: propertyId,
      row_data: sealApplicantRow(row, row.id, managerUserId),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id" },
  );
  if (error) throw new Error(error.message);

  // A resident with no email can't be onboarded yet (no address to send the setup
  // link to) — the application row stays in place and a `add_resident_email` task
  // (from build-draft.ts) reminds the manager. Not an error: this is expected.
  if (email) {
    const result = await runExistingResidentOnboarding(
      db,
      { userId: actor.userId, email: actor.email, managerName: actor.managerName },
      row,
      { sendWelcomeEmail: false },
    );
    if (!result.ok) throw new Error(result.error);
  }

  await completeReceipt(db, importId, "resident", resident.key, applicationId);
  return applicationId;
}

// ---------------------------------------------------------------------------
// Balance
// ---------------------------------------------------------------------------

async function commitOneBalance(
  db: SupabaseClient,
  importId: string,
  managerUserId: string,
  balanceKey: string,
  amount: number,
  applicationId: string,
  resident: PortfolioImportResident,
  propertyId: string,
  propertyLabel: string,
): Promise<string> {
  const chargeId = `charge_import_${importId}_${resident.key}`;
  const receipt = await prepareReceipt(db, {
    importId,
    managerUserId,
    recordKind: "balance",
    sourceKey: balanceKey,
    payload: { chargeId, amount },
  });
  if (receipt.status === "completed" && receipt.canonical_id) return receipt.canonical_id;

  const amountLabel = `$${amount.toFixed(2)}`;
  const charge: HouseholdCharge = {
    id: chargeId,
    createdAt: new Date().toISOString(),
    applicationId,
    residentEmail: resident.email ?? "",
    residentName: resident.name,
    residentUserId: null,
    propertyId,
    propertyLabel,
    managerUserId,
    kind: "other_cost",
    title: "Opening balance (imported)",
    amountLabel,
    balanceLabel: amountLabel,
    status: "pending",
    dueDateLabel: new Date().toISOString().slice(0, 10),
    blocksLeaseUntilPaid: false,
    migrationSourceId: `${importId}:${resident.key}`,
  };

  await upsertManagerCharges(db, managerUserId, [charge as unknown as Record<string, unknown>]);
  await completeReceipt(db, importId, "balance", balanceKey, chargeId);
  return chargeId;
}

// ---------------------------------------------------------------------------
// commitPortfolioImport
// ---------------------------------------------------------------------------

export async function commitPortfolioImport(input: {
  db: SupabaseClient;
  managerUserId: string;
  actor: PortfolioImportCommitActor;
  importId: string;
}): Promise<PortfolioImportCommitResult> {
  const { db, managerUserId, actor, importId } = input;
  const row = await loadPortfolioImport(db, managerUserId, importId);
  if (!row || !row.draft) throw new Error("Import not found.");
  const draft = row.draft.draft;
  if (draftHasBlockingIssues(draft)) throw new PortfolioImportBlockedError();

  await setPortfolioImportStatus(db, managerUserId, importId, "committing");

  const properties = new Map(draft.properties.map((p) => [p.key, p]));
  const units = new Map(draft.units.map((u) => [u.key, u]));

  const stages = emptyStages();
  const propertyIds: string[] = [];
  const residentApplicationIds: string[] = [];
  const taskIds: string[] = [];
  const balanceChargeIds: string[] = [];
  const failures: PortfolioImportCommitResult["failures"] = [];

  // ---- property + room ----
  const propertyCanonicalId = new Map<string, string>();
  const roomCanonicalId = new Map<string, string>();

  for (const property of draft.properties) {
    if (property.excluded) continue;
    stages.property.total += 1;
    const activeUnitKeys = property.unitKeys.filter((key) => {
      const unit = units.get(key);
      return !!unit && !isUnitExcluded(unit, properties);
    });

    const propertyId = await attempt(db, importId, stages, failures, "property", property.key, () =>
      commitOneProperty(db, importId, managerUserId, property, activeUnitKeys.map((key) => units.get(key)!), draft.fileName),
    );
    if (propertyId) {
      propertyCanonicalId.set(property.key, propertyId);
      propertyIds.push(propertyId);
    }

    for (let index = 0; index < activeUnitKeys.length; index++) {
      const unitKey = activeUnitKeys[index];
      stages.room.total += 1;
      if (!propertyId) {
        skip(stages, failures, "room", unitKey, "Skipped — the property import failed.");
        continue;
      }
      const roomId = await attempt(db, importId, stages, failures, "room", unitKey, () =>
        commitOneRoom(db, importId, managerUserId, propertyId, units.get(unitKey)!, index),
      );
      if (roomId) roomCanonicalId.set(unitKey, roomId);
    }
  }

  // ---- resident ----
  const residentApplicationIdByKey = new Map<string, string>();
  for (const resident of draft.residents) {
    if (isResidentExcluded(resident, units, properties)) continue;
    stages.resident.total += 1;
    const property = properties.get(resident.propertyKey);
    const propertyId = propertyCanonicalId.get(resident.propertyKey);
    const roomId = roomCanonicalId.get(resident.unitKey);
    if (!property || !propertyId || !roomId) {
      skip(stages, failures, "resident", resident.key, "Skipped — the property or unit import failed.");
      continue;
    }
    const applicationId = await attempt(db, importId, stages, failures, "resident", resident.key, () =>
      commitOneResident(db, importId, managerUserId, actor, resident, propertyId, property.name, roomId),
    );
    if (applicationId) {
      residentApplicationIds.push(applicationId);
      residentApplicationIdByKey.set(resident.key, applicationId);
    }
  }

  // ---- balance ----
  for (const balance of draft.balances) {
    if (balance.create === false) continue;
    const resident = draft.residents.find((r) => r.key === balance.residentKey);
    if (!resident || isResidentExcluded(resident, units, properties)) continue;
    stages.balance.total += 1;
    const applicationId = residentApplicationIdByKey.get(resident.key);
    const property = properties.get(resident.propertyKey);
    const propertyId = propertyCanonicalId.get(resident.propertyKey);
    if (!applicationId || !property || !propertyId) {
      skip(stages, failures, "balance", balance.key, "Skipped — the resident import failed.");
      continue;
    }
    const chargeId = await attempt(db, importId, stages, failures, "balance", balance.key, () =>
      commitOneBalance(db, importId, managerUserId, balance.key, balance.amount, applicationId, resident, propertyId, property.name),
    );
    if (chargeId) balanceChargeIds.push(chargeId);
  }

  // ---- task ----
  const existingTasks = await loadManagerTasks(db, managerUserId);
  const existingDedupeKeys = new Set(existingTasks.map((t) => t.dedupKey).filter((k): k is string => Boolean(k)));
  const newTasks: ManagerTask[] = [];
  const now = new Date().toISOString();

  for (const task of draft.tasks) {
    if (task.residentKey) {
      const resident = draft.residents.find((r) => r.key === task.residentKey);
      if (resident && isResidentExcluded(resident, units, properties)) continue;
    } else if (task.unitKey) {
      const unit = units.get(task.unitKey);
      if (unit && isUnitExcluded(unit, properties)) continue;
    } else if (task.propertyKey && properties.get(task.propertyKey)?.excluded) {
      continue;
    }

    stages.task.total += 1;
    const dedupKey = `import:${task.kind}:${importId}:${task.key}`;
    if (existingDedupeKeys.has(dedupKey)) {
      stages.task.done += 1;
      continue;
    }

    const propertyId = task.propertyKey ? propertyCanonicalId.get(task.propertyKey) : undefined;
    if (task.propertyKey && !propertyId) {
      skip(stages, failures, "task", task.key, "Skipped — the property import failed.");
      continue;
    }

    const taskId = `task_import_${importId}_${task.key}`;
    newTasks.push({
      id: taskId,
      title: task.title,
      notes: task.notes,
      propertyId,
      propertyTitle: task.propertyKey ? properties.get(task.propertyKey)?.name : undefined,
      roomLabel: task.unitKey ? units.get(task.unitKey)?.label : undefined,
      dueDate: task.dueDate,
      completed: false,
      taskType: task.taskType,
      urgency: task.urgency,
      templateKey: `import:${task.kind}`,
      sourceId: importId,
      dedupKey,
      createdAt: now,
      updatedAt: now,
    });
    taskIds.push(taskId);
    existingDedupeKeys.add(dedupKey);
    stages.task.done += 1;
  }

  if (newTasks.length > 0) {
    await saveManagerTasks(db, managerUserId, [...existingTasks, ...newTasks]);
  }

  // ---- finish ----
  const totalAttempted = Object.values(stages).reduce((sum, s) => sum + s.total, 0);
  const totalFailed = failures.length;
  const status: PortfolioImportCommitResult["status"] =
    totalFailed === 0 ? "completed" : totalFailed >= totalAttempted && totalAttempted > 0 ? "failed" : "partial";

  const result: PortfolioImportCommitResult = {
    status,
    progress: (Object.keys(stages) as PortfolioImportRecordKind[]).map((stage) => ({ stage, ...stages[stage] })),
    propertyIds,
    residentApplicationIds,
    taskIds,
    balanceChargeIds,
    failures,
  };

  // A partial commit stays re-runnable: the row is "partial", never "completed",
  // so the commit route runs the prepared records again instead of handing back
  // the stored result, and committed_at is set only once everything is in.
  await setPortfolioImportStatus(db, managerUserId, importId, status, {
    result,
    ...(status === "completed" ? { committedAt: new Date().toISOString() } : {}),
  });

  track("portfolio_import_committed", managerUserId, {
    source: draft.sourceKind,
    propertyCount: propertyIds.length,
    unitCount: stages.room.done,
    residentCount: residentApplicationIds.length,
    taskCount: taskIds.length,
  });

  return result;
}
