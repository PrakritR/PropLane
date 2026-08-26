import { isDemoModeActive } from "@/lib/demo/demo-session";
import type { WorkAssignee } from "@/lib/work-assignment";
import {
  createManagerCharge,
  deleteHouseholdCharge,
  markHouseholdChargePaid,
  parseMoneyAmount,
  readChargesForManagerResident,
  updateHouseholdChargeAmount,
} from "@/lib/household-charges";
import { getPropertyById } from "@/lib/rental-application/data";

export const SERVICE_REQUESTS_EVENT = "axis:service-requests";
const KEY = "axis_service_requests_v1";

// TTL + in-flight guard so remounts/overlapping callers collapse into one
// network fetch, matching the other portal sync helpers.
const SERVICE_REQUESTS_SYNC_TTL_MS = 15_000;
let serviceRequestsLastSyncedAt = 0;
let serviceRequestsSyncPromise: Promise<ServiceRequest[]> | null = null;

export type ServiceRequestStatus = "pending" | "approved" | "denied" | "returned";

export const CUSTOM_SERVICE_REQUEST_OFFER_ID = "custom";

export function isCustomServiceRequest(req: Pick<ServiceRequest, "offerId">): boolean {
  return req.offerId === CUSTOM_SERVICE_REQUEST_OFFER_ID;
}

export type ServiceRequest = {
  id: string;
  // Offer snapshot at time of request
  offerId: string;
  offerName: string;
  offerDescription: string;
  price: string;
  /** Resident's max budget on custom requests — manager sets `price` before approval. */
  priceLimit?: string;
  deposit: string;
  // Participants
  residentEmail: string;
  residentName: string;
  managerUserId: string;
  propertyId: string;
  // Request details
  returnByDate: string;  // ISO date, empty if no deposit
  notes: string;
  requestedAt: string;
  status: ServiceRequestStatus;
  // Manager actions
  approvedAt?: string;
  deniedAt?: string;
  managerNote?: string;
  // Charge tracking (relevant when approved)
  servicePaid: boolean;
  depositPaid: boolean;
  servicePaidAt?: string;
  depositPaidAt?: string;
  serviceChargeId?: string;
  depositChargeId?: string;
  /**
   * Who is handling this — a co-manager or a vendor.
   *
   * Work orders already carry vendor DISPATCH (`vendorId` / `vendorName` /
   * `vendorAssignedAt`), which is a server-owned subsystem with its own lifecycle; this field
   * deliberately does not duplicate it. Add-on services had no assignment at all, so this is the
   * one place they get it, and `work-assignment.ts` decides who may be offered.
   */
  assignee?: WorkAssignee;
  // Return
  returnPhotoDataUrl?: string;
  returnedAt?: string;
  /** ISO timestamp of the resident's last manager reminder for this pending request. */
  residentReminderSentAt?: string;
};

function toPositiveDollarAmount(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parsed = parseMoneyAmount(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function resolvePropertyLabel(propertyId: string): string {
  const resolved = getPropertyById(propertyId.trim());
  if (!resolved) return "Property";
  const street = resolved.address.split(",")[0]?.trim();
  return street || resolved.buildingName || resolved.title || "Property";
}

function ensureServiceRequestPendingCharge(row: ServiceRequest): string | undefined {
  const serviceAmount = toPositiveDollarAmount(row.price);
  if (!serviceAmount) return row.serviceChargeId;

  const propertyLabel = resolvePropertyLabel(row.propertyId);
  const title = `${row.offerName} service fee`;

  if (row.serviceChargeId) {
    updateHouseholdChargeAmount(row.serviceChargeId, serviceAmount, row.managerUserId ?? null, title);
    return row.serviceChargeId;
  }

  const created = createManagerCharge({
    residentEmail: row.residentEmail,
    residentName: row.residentName,
    propertyId: row.propertyId,
    propertyLabel,
    managerUserId: row.managerUserId,
    title,
    amount: serviceAmount,
    blocksLeaseUntilPaid: false,
    initialStatus: "pending",
  });
  return created?.id;
}

/** True when the linked household charge is paid (or the request row is already marked paid). */
export function isServiceRequestFeePaid(req: ServiceRequest): boolean {
  if (req.servicePaid) return true;
  if (!req.serviceChargeId) return false;
  const charge = readChargesForManagerResident(req.residentEmail, req.managerUserId ?? null).find(
    (c) => c.id === req.serviceChargeId,
  );
  return charge?.status === "paid";
}

/** After a household charge is marked paid, mirror that on the linked service request. */
export function syncServiceRequestPaidFromCharge(chargeId: string): boolean {
  const all = readAll();
  const idx = all.findIndex((r) => r.serviceChargeId === chargeId && !r.servicePaid);
  if (idx === -1) return false;
  all[idx] = { ...all[idx]!, servicePaid: true, servicePaidAt: new Date().toISOString() };
  writeAll(all);
  mirrorServiceRequestToServerBestEffort(all[idx]!);
  return true;
}

function readAll(): ServiceRequest[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]") as ServiceRequest[];
  } catch {
    return [];
  }
}

function writeAll(requests: ServiceRequest[]): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(KEY, JSON.stringify(requests));
  window.dispatchEvent(new Event(SERVICE_REQUESTS_EVENT));
}

/** Demo seed: load service requests into the local store (local-only, no mirror). */
export function seedDemoServiceRequests(requests: ServiceRequest[]): void {
  writeAll(requests);
}

export type MirrorServiceRequestResult =
  | { ok: true; row: ServiceRequest }
  | { ok: false; error: string };

/**
 * Server mirroring. Service requests persist to `portal_service_request_records`
 * via the service-role API route so they survive across devices/browsers and so
 * the AI agent (which runs server-side and cannot read localStorage) can see
 * them. localStorage remains a fast local cache.
 */
async function mirrorServiceRequestToServer(row: ServiceRequest): Promise<MirrorServiceRequestResult> {
  if (typeof window === "undefined" || isDemoModeActive()) {
    return { ok: true, row };
  }
  try {
    const res = await fetch("/api/portal-service-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ action: "upsert", row }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return { ok: false, error: body?.error?.trim() || `Save failed (${res.status})` };
    }
    const body = (await res.json().catch(() => null)) as { row?: ServiceRequest } | null;
    return { ok: true, row: body?.row && typeof body.row === "object" ? body.row : row };
  } catch {
    return { ok: false, error: "Could not reach the server." };
  }
}

/** Fire-and-forget mirror for non-critical follow-up updates (paid flags, etc.). */
function mirrorServiceRequestToServerBestEffort(row: ServiceRequest): void {
  void mirrorServiceRequestToServer(row).then((result) => {
    if (!result.ok || result.row === row) return;
    const all = readAll();
    const idx = all.findIndex((r) => r.id === result.row.id);
    if (idx === -1) return;
    all[idx] = result.row;
    writeAll(all);
  });
}

function deleteServiceRequestFromServer(id: string): void {
  if (typeof window === "undefined" || isDemoModeActive()) return;
  void fetch("/api/portal-service-requests", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ action: "delete", id }),
  }).catch(() => undefined);
}

/** Pull the authoritative server set into the local cache and notify listeners. */
export async function syncServiceRequestsFromServer(opts?: { force?: boolean }): Promise<ServiceRequest[]> {
  if (typeof window === "undefined") return [];
  if (isDemoModeActive()) return readAll();
  const force = opts?.force === true;
  if (!force && serviceRequestsSyncPromise) return serviceRequestsSyncPromise;
  if (!force && serviceRequestsLastSyncedAt > 0 && Date.now() - serviceRequestsLastSyncedAt < SERVICE_REQUESTS_SYNC_TTL_MS) {
    return readAll();
  }
  try {
    serviceRequestsSyncPromise = (async () => {
      const res = await fetch("/api/portal-service-requests", { credentials: "include" });
      if (!res.ok) return readAll();
      const body = (await res.json()) as { rows?: ServiceRequest[] };
      const rows = Array.isArray(body.rows) ? body.rows : [];
      writeAll(rows);
      serviceRequestsLastSyncedAt = Date.now();
      return rows;
    })().catch(() => readAll());
    return await serviceRequestsSyncPromise;
  } catch {
    return readAll();
  } finally {
    serviceRequestsSyncPromise = null;
  }
}

export async function createServiceRequest(
  req: Omit<ServiceRequest, "id" | "requestedAt" | "status" | "servicePaid" | "depositPaid">,
): Promise<{ request: ServiceRequest; mirrored: MirrorServiceRequestResult }> {
  const newReq: ServiceRequest = {
    ...req,
    id: `SR-${Date.now()}`,
    requestedAt: new Date().toISOString(),
    status: "pending",
    servicePaid: false,
    depositPaid: false,
  };
  writeAll([newReq, ...readAll()]);
  const mirrored = await mirrorServiceRequestToServer(newReq);
  if (mirrored.ok && mirrored.row.id === newReq.id) {
    // Prefer server-stamped manager/property so resident + manager lists agree.
    // The pending charge is created only AFTER the server stamps the row, so it
    // always carries the manager the request actually landed with.
    const stamped = mirrored.row;
    const serviceChargeId = ensureServiceRequestPendingCharge(stamped);
    const finalRow =
      serviceChargeId && serviceChargeId !== stamped.serviceChargeId
        ? { ...stamped, serviceChargeId }
        : stamped;
    const all = readAll();
    const idx = all.findIndex((r) => r.id === newReq.id);
    if (idx !== -1) {
      all[idx] = finalRow;
      writeAll(all);
    }
    if (finalRow !== stamped) mirrorServiceRequestToServerBestEffort(finalRow);
    return { request: finalRow, mirrored };
  }
  if (!mirrored.ok && !isDemoModeActive()) {
    // Roll back optimistic local row so resident UI doesn't show orphans the
    // manager will never see. No charge exists yet — it's created post-mirror.
    writeAll(readAll().filter((r) => r.id !== newReq.id));
  }
  return { request: newReq, mirrored };
}

export function readServiceRequestsForResident(residentEmail: string): ServiceRequest[] {
  const email = residentEmail.trim().toLowerCase();
  return readAll().filter((r) => r.residentEmail.trim().toLowerCase() === email);
}

/** Unfiltered local cache (manager UI applies `moduleRowVisibleToPortalUser`). */
export function readAllServiceRequests(): ServiceRequest[] {
  return readAll();
}

export function readServiceRequestsForManager(managerUserId: string): ServiceRequest[] {
  return readAll().filter((r) => r.managerUserId === managerUserId);
}

export function readServiceRequestsForProperty(propertyId: string): ServiceRequest[] {
  const propId = propertyId.trim().toLowerCase();
  return readAll().filter((r) => r.propertyId.trim().toLowerCase() === propId);
}

export function updateServiceRequest(id: string, updates: Partial<ServiceRequest>): void {
  const all = readAll();
  const idx = all.findIndex((r) => r.id === id);
  if (idx === -1) return;
  let next = { ...all[idx]!, ...updates };
  if (next.status === "pending" && (updates.price !== undefined || updates.offerName !== undefined)) {
    const serviceChargeId = ensureServiceRequestPendingCharge(next);
    if (serviceChargeId) next = { ...next, serviceChargeId };
  }
  all[idx] = next;
  writeAll(all);
  mirrorServiceRequestToServerBestEffort(all[idx]!);
}

export function approveServiceRequest(id: string, managerNote?: string): void {
  const all = readAll();
  const idx = all.findIndex((r) => r.id === id);
  if (idx === -1) return;
  const row = all[idx]!;
  const serviceChargeId = ensureServiceRequestPendingCharge(row) ?? row.serviceChargeId;

  all[idx] = {
    ...row,
    status: "approved",
    approvedAt: new Date().toISOString(),
    managerNote: managerNote?.trim() || row.managerNote,
    serviceChargeId,
  };
  writeAll(all);
  mirrorServiceRequestToServerBestEffort(all[idx]!);
}

export function denyServiceRequest(id: string, managerNote?: string): void {
  const all = readAll();
  const idx = all.findIndex((r) => r.id === id);
  if (idx === -1) return;
  const row = all[idx]!;
  if (row.serviceChargeId && !row.servicePaid) {
    deleteHouseholdCharge(row.serviceChargeId, row.managerUserId ?? null);
  }
  all[idx] = {
    ...row,
    status: "denied",
    deniedAt: new Date().toISOString(),
    managerNote: managerNote?.trim() || row.managerNote,
  };
  writeAll(all);
  mirrorServiceRequestToServerBestEffort(all[idx]!);
}

export function markServiceRequestServicePaid(id: string): void {
  const all = readAll();
  const idx = all.findIndex((r) => r.id === id);
  if (idx === -1) return;
  const row = all[idx]!;
  if (row.serviceChargeId) {
    markHouseholdChargePaid(row.serviceChargeId, row.managerUserId ?? null);
  }
  all[idx] = { ...row, servicePaid: true, servicePaidAt: new Date().toISOString() };
  writeAll(all);
  mirrorServiceRequestToServerBestEffort(all[idx]!);
}

export function markServiceRequestDepositPaid(id: string): void {
  const all = readAll();
  const idx = all.findIndex((r) => r.id === id);
  if (idx === -1) return;
  all[idx] = { ...all[idx]!, depositPaid: true, depositPaidAt: new Date().toISOString() };
  writeAll(all);
  mirrorServiceRequestToServerBestEffort(all[idx]!);
}

export function deleteServiceRequest(id: string): void {
  const all = readAll();
  const target = all.find((r) => r.id === id);
  if (target?.serviceChargeId && !target.servicePaid) {
    deleteHouseholdCharge(target.serviceChargeId, target.managerUserId ?? null);
  }
  const next = all.filter((r) => r.id !== id);
  if (next.length === all.length) return;
  writeAll(next);
  deleteServiceRequestFromServer(id);
}

export function deleteServiceRequestsForResident(residentEmail: string): number {
  const email = residentEmail.trim().toLowerCase();
  if (!email) return 0;
  const all = readAll();
  const removedRows = all.filter((r) => r.residentEmail.trim().toLowerCase() === email);
  const next = all.filter((r) => r.residentEmail.trim().toLowerCase() !== email);
  const removed = all.length - next.length;
  if (removed > 0) {
    writeAll(next);
    for (const row of removedRows) deleteServiceRequestFromServer(row.id);
  }
  return removed;
}

export function submitReturnPhoto(id: string, photoDataUrl: string): void {
  const all = readAll();
  const idx = all.findIndex((r) => r.id === id);
  if (idx === -1) return;
  const row = all[idx]!;
  if (row.serviceChargeId && !isServiceRequestFeePaid(row)) {
    markHouseholdChargePaid(row.serviceChargeId, row.managerUserId ?? null);
  }
  all[idx] = {
    ...row,
    status: "returned",
    returnPhotoDataUrl: photoDataUrl,
    returnedAt: new Date().toISOString(),
    servicePaid: true,
    servicePaidAt: row.servicePaidAt ?? new Date().toISOString(),
  };
  writeAll(all);
  mirrorServiceRequestToServerBestEffort(all[idx]!);
}

export function hasDeposit(deposit: string): boolean {
  const trimmed = deposit.trim();
  if (!trimmed) return false;
  const n = parseFloat(trimmed.replace(/[^\d.]/g, ""));
  if (Number.isNaN(n)) return true; // non-numeric but present, treat as has deposit
  return n > 0;
}
