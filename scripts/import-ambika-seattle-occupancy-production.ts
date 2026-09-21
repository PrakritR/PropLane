/**
 * PLAN-0918-1909 — Ambika Seattle occupancy, signed PDFs, paid history, Bookings, onboard.
 *
 * Named production waiver:
 *   docs/waivers/2026-09-18-ambika-seattle-occupancy-import.md
 *
 * Dry-run (default):
 *   node --env-file=.env.production.local \
 *     scripts/import-ambika-seattle-occupancy-production.mjs
 *
 * Apply:
 *   ALLOW_PRODUCTION_AMBIKA_SEATTLE_OCCUPANCY=1 \
 *     node --env-file=.env.production.local \
 *       scripts/import-ambika-seattle-occupancy-production.mjs --apply
 *
 * Slim lease list payloads (same waiver; PDFs stay in Documents):
 *   ALLOW_PRODUCTION_AMBIKA_SEATTLE_OCCUPANCY=1 \
 *     node --env-file=.env.production.local \
 *       scripts/import-ambika-seattle-occupancy-production.mjs --slim-payloads --apply
 *
 * Never writes manager_property_records or locked seed listing ids.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import type { DemoApplicantRow } from "@/data/demo-portal";
import {
  AMBIKA_MANAGER_EMAIL,
  AMBIKA_MANAGER_ID,
  AMBIKA_SEATTLE_BOOKINGS,
  AMBIKA_SEATTLE_RESIDENTS,
  PRODUCTION_PROJECT_REF,
  ambikaSeattlePropertyId,
  exclusiveCheckoutAfterLastNight,
  isLockedLiveListingId,
  leasePdfFileNameFor,
  residentEmailFor,
  roomIdForNumber,
  type AmbikaSeattleResident,
} from "@/lib/ambika-seattle-occupancy";
import { IMPORTED_AIRBNB_REASON } from "@/lib/channel-calendar/property-bookings";
import { provisionApprovedResidentAccount } from "@/lib/auth/provision-approved-resident";
import { runExistingResidentOnboarding } from "@/lib/existing-resident-onboarding.server";
import { normalizeLeasePipelineRow } from "@/lib/lease-pipeline-storage";
import { normalizeApplicationAxisId } from "@/lib/manager-applications-storage";
import { paidLeaseHistoryMonths } from "@/lib/import-paid-lease-history";
import type { HouseholdCharge } from "@/lib/household-charges";
import { LISTING_ROOM_CHOICE_SEP } from "@/lib/rental-application/data";
import { createInitialRentalWizardState } from "@/lib/rental-application/state";
import { roomDateBlockRecordId } from "@/lib/portal-schedule-record-scope";
import { ROOM_DATE_BLOCK_RECORD_TYPE } from "@/lib/portal-schedule-record-scope";
import { syncLedgerChargeEntry } from "@/lib/reports/ledger-sync";
import { deliverExistingResidentWelcome, isPlaceholderResidentEmail } from "@/lib/resident-welcome.server";
import { openApplicantRow, sealApplicantRow } from "@/lib/security/applicant-identity";

const APPLY = process.argv.includes("--apply");
const SLIM = process.argv.includes("--slim-payloads");
const RESTORE_DOCS = process.argv.includes("--restore-documents");
const DOWNLOADS = process.env.AMBIKA_LEASE_PDF_DIR?.trim() || "/Users/prakrit/Downloads";

function stripQuotes(value: string): string {
  return value.replace(/^"|"$/g, "").trim();
}

function todayIso(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
}

function uuidFrom(...parts: string[]): string {
  const h = createHash("sha256").update(parts.join(":")).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function importAxisId(key: string): string {
  const suffix = key.replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 24);
  return `PROPLANE-AMBIKA${suffix}`;
}

function pdfDataUrl(fileName: string | undefined): { dataUrl: string; fileName: string } | null {
  if (!fileName) return null;
  const path = join(DOWNLOADS, fileName);
  if (!existsSync(path)) return null;
  const buf = readFileSync(path);
  return { dataUrl: `data:application/pdf;base64,${buf.toString("base64")}`, fileName };
}

function targetFromUrl(raw: string): string {
  try {
    const host = new URL(raw).host;
    const hosted = /^([a-z0-9-]+)\.supabase\.(co|in|red)$/i.exec(host);
    return hosted ? hosted[1]! : host;
  } catch {
    return "";
  }
}

function check(error: { message: string } | null) {
  if (error) throw new Error(error.message);
}

function isRoomCapacityError(error: { message?: string } | null): error is { message: string } {
  const message = error?.message ?? "";
  return /room is blocked|No bed is available|statement timeout/i.test(message);
}

function namesOverlap(a: string, b: string): boolean {
  const left = a.trim().toLowerCase();
  const right = b.trim().toLowerCase();
  if (!left || !right) return false;
  return left === right || left.includes(right) || right.includes(left);
}

const url = stripQuotes(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
const key = stripQuotes(process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const ref = targetFromUrl(url);
if (ref !== PRODUCTION_PROJECT_REF) {
  console.error(`Refusing: expected production project ${PRODUCTION_PROJECT_REF}, got ${ref || "(none)"}`);
  process.exit(1);
}
if (APPLY && process.env.ALLOW_PRODUCTION_AMBIKA_SEATTLE_OCCUPANCY !== "1") {
  console.error("Set ALLOW_PRODUCTION_AMBIKA_SEATTLE_OCCUPANCY=1 with --apply (see docs/waivers/…).");
  process.exit(2);
}

const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

type ListingRoom = { id: string; name: string };
type PropertySnap = { id: string; label: string; rooms: ListingRoom[] };

function submissionRooms(propertyData: Record<string, unknown> | null): ListingRoom[] {
  const submission = propertyData?.listingSubmission as { rooms?: { id?: string; name?: string }[] } | undefined;
  if (!Array.isArray(submission?.rooms)) return [];
  return submission.rooms.map((r) => ({ id: String(r.id ?? ""), name: String(r.name ?? "") }));
}

function buildResidentRow(
  stay: AmbikaSeattleResident,
  property: PropertySnap,
  roomId: string,
  existing: DemoApplicantRow | null,
): DemoApplicantRow {
  const email = (
    existing?.email?.trim() ||
    stay.email?.trim() ||
    residentEmailFor(stay)
  ).toLowerCase();
  const choice = `${property.id}${LISTING_ROOM_CHOICE_SEP}${roomId}`;
  const roomLabel = property.rooms.find((r) => r.id === roomId)?.name ?? `Room ${stay.roomNumber}`;
  const rent = stay.rentCents != null ? stay.rentCents / 100 : undefined;
  const utilities = stay.utilitiesCents != null ? stay.utilitiesCents / 100 : undefined;
  const id = existing?.id?.trim() || importAxisId(stay.key);
  const base = createInitialRentalWizardState();
  return {
    ...(existing ?? {}),
    id,
    name: stay.name,
    email,
    property: property.label,
    propertyId: property.id,
    assignedPropertyId: property.id,
    assignedRoomChoice: choice,
    managerUserId: AMBIKA_MANAGER_ID,
    bucket: "approved",
    stage: "Existing resident",
    detail: existing ? "Updated from Seattle occupancy import" : "Imported Seattle occupancy — current resident",
    manuallyAdded: true,
    signedMonthlyRent: rent,
    residentUserId: existing?.residentUserId ?? null,
    manualResidentDetails: {
      ...existing?.manualResidentDetails,
      phone: stay.phone ?? existing?.manualResidentDetails?.phone,
      moveInDate: stay.start,
      moveOutDate: stay.end,
      monthlyUtilities: utilities,
      roomNumber: roomLabel,
      leaseTerm: stay.monthToMonth ? "Month to month" : "Fixed term",
      notes: "PLAN-0918-1909 Ambika Seattle occupancy",
    },
    application: {
      ...(existing?.application ?? base),
      ...base,
      ...(existing?.application ?? {}),
      fullLegalName: stay.name,
      email,
      phone: stay.phone ?? existing?.application?.phone ?? "",
      propertyId: property.id,
      roomChoice1: choice,
      leaseStart: stay.start,
      leaseEnd: stay.end ?? "",
      leaseTerm: stay.monthToMonth ? "Month to month" : "12-Month",
      rentalType: "standard",
      managerRentOverride: rent != null ? String(rent) : existing?.application?.managerRentOverride ?? "",
      managerUtilitiesOverride:
        utilities != null ? String(utilities) : existing?.application?.managerUtilitiesOverride ?? "",
    },
  };
}

type LeaseRowData = {
  residentName?: string;
  generatedHtml?: string | null;
  documentOmitted?: boolean;
  managerUploadedPdf?: {
    dataUrl?: string;
    originalDataUrl?: string;
    fileName?: string;
    uploadedAt?: string;
    omitted?: boolean;
    libraryDocumentId?: string | null;
  } | null;
  signedLeaseSnapshots?: Array<{
    generatedHtml?: string | null;
    managerUploadedPdf?: LeaseRowData["managerUploadedPdf"];
  }>;
};

function pdfMeta(pdf: LeaseRowData["managerUploadedPdf"]): LeaseRowData["managerUploadedPdf"] {
  if (!pdf) return null;
  return {
    fileName: pdf.fileName ?? "Uploaded lease.pdf",
    uploadedAt: pdf.uploadedAt ?? "",
    dataUrl: "",
    omitted: true,
    ...(pdf.libraryDocumentId ? { libraryDocumentId: pdf.libraryDocumentId } : {}),
  };
}

function leasePayloadBytes(row: LeaseRowData): number {
  let bytes = (row.generatedHtml?.length ?? 0) + (row.managerUploadedPdf?.dataUrl?.length ?? 0) + (row.managerUploadedPdf?.originalDataUrl?.length ?? 0);
  for (const snap of row.signedLeaseSnapshots ?? []) {
    bytes += (snap.generatedHtml?.length ?? 0) + (snap.managerUploadedPdf?.dataUrl?.length ?? 0) + (snap.managerUploadedPdf?.originalDataUrl?.length ?? 0);
  }
  return bytes;
}

function slimLeaseRowData(row: LeaseRowData): LeaseRowData {
  return {
    ...row,
    generatedHtml: row.generatedHtml ? "" : row.generatedHtml,
    documentOmitted: true,
    managerUploadedPdf: pdfMeta(row.managerUploadedPdf),
    signedLeaseSnapshots: (row.signedLeaseSnapshots ?? []).map((snap) => ({
      ...snap,
      generatedHtml: snap.generatedHtml ? "" : snap.generatedHtml,
      managerUploadedPdf: pdfMeta(snap.managerUploadedPdf),
    })),
  };
}

async function slimAmbikaLeasePayloads() {
  const { data: profile, error: pErr } = await db
    .from("profiles")
    .select("id, email")
    .eq("id", AMBIKA_MANAGER_ID)
    .maybeSingle();
  check(pErr);
  if (!profile || String(profile.email ?? "").trim().toLowerCase() !== AMBIKA_MANAGER_EMAIL) {
    throw new Error(`Manager identity mismatch: expected ${AMBIKA_MANAGER_EMAIL}, got ${profile?.email}`);
  }

  const { data, error } = await db
    .from("portal_lease_pipeline_records")
    .select("id, manager_user_id, row_data")
    .eq("manager_user_id", AMBIKA_MANAGER_ID);
  check(error);

  let heavy = 0;
  for (const rec of data ?? []) {
    if (String(rec.manager_user_id ?? "") !== AMBIKA_MANAGER_ID) {
      throw new Error(`Refusing lease ${rec.id}: manager_user_id mismatch`);
    }
    const row = (rec.row_data && typeof rec.row_data === "object" ? rec.row_data : {}) as LeaseRowData;
    const bytes = leasePayloadBytes(row);
    if (bytes < 4_000) continue;
    heavy += 1;
    console.log(`${APPLY ? "SLIM" : "DRY"} ${rec.id} ${row.residentName ?? "—"} ${(bytes / 1_000_000).toFixed(2)}MB`);
    if (!APPLY) continue;
    const { error: updErr } = await db
      .from("portal_lease_pipeline_records")
      .update({ row_data: slimLeaseRowData(row), updated_at: new Date().toISOString() })
      .eq("id", rec.id)
      .eq("manager_user_id", AMBIKA_MANAGER_ID);
    check(updErr);
  }
  console.log(`${APPLY ? "Slimmed" : "Would slim"} ${heavy} lease row(s). PDFs remain in Documents.`);

  const { data: apps, error: appErr } = await db
    .from("manager_application_records")
    .select("id, manager_user_id, row_data")
    .eq("manager_user_id", AMBIKA_MANAGER_ID);
  check(appErr);
  let heavyApps = 0;
  for (const rec of apps ?? []) {
    if (String(rec.manager_user_id ?? "") !== AMBIKA_MANAGER_ID) {
      throw new Error(`Refusing application ${rec.id}: manager_user_id mismatch`);
    }
    const row = (rec.row_data && typeof rec.row_data === "object" ? rec.row_data : {}) as {
      name?: string;
      manualResidentDetails?: { signedLeaseDataUrl?: string; signedLeaseFileName?: string };
    };
    const dataUrl = row.manualResidentDetails?.signedLeaseDataUrl ?? "";
    if (dataUrl.length < 4_000) continue;
    heavyApps += 1;
    console.log(
      `${APPLY ? "SLIM-APP" : "DRY-APP"} ${rec.id} ${row.name ?? "—"} ${(dataUrl.length / 1_000_000).toFixed(2)}MB`,
    );
    if (!APPLY) continue;
    const next = {
      ...row,
      manualResidentDetails: {
        ...row.manualResidentDetails,
        signedLeaseDataUrl: "",
      },
    };
    const { error: updErr } = await db
      .from("manager_application_records")
      .update({ row_data: next, updated_at: new Date().toISOString() })
      .eq("id", rec.id)
      .eq("manager_user_id", AMBIKA_MANAGER_ID);
    check(updErr);
  }
  console.log(`${APPLY ? "Slimmed" : "Would slim"} ${heavyApps} application row(s).`);
}

async function restoreAmbikaLeaseDocuments() {
  const { data: profile, error: pErr } = await db
    .from("profiles")
    .select("id, email")
    .eq("id", AMBIKA_MANAGER_ID)
    .maybeSingle();
  check(pErr);
  if (!profile || String(profile.email ?? "").trim().toLowerCase() !== AMBIKA_MANAGER_EMAIL) {
    throw new Error(`Manager identity mismatch: expected ${AMBIKA_MANAGER_EMAIL}, got ${profile?.email}`);
  }

  const { data, error } = await db
    .from("portal_lease_pipeline_records")
    .select("id, manager_user_id, resident_email, property_id, row_data")
    .eq("manager_user_id", AMBIKA_MANAGER_ID);
  check(error);

  let filed = 0;
  for (const rec of data ?? []) {
    if (String(rec.manager_user_id ?? "") !== AMBIKA_MANAGER_ID) {
      throw new Error(`Refusing lease ${rec.id}: manager_user_id mismatch`);
    }
    const row = (rec.row_data && typeof rec.row_data === "object" ? rec.row_data : {}) as LeaseRowData;
    if (row.managerUploadedPdf?.libraryDocumentId) {
      console.log(`KEEP ${rec.id} ${row.residentName ?? "—"} already filed`);
      continue;
    }
    const fileName = leasePdfFileNameFor(String(row.residentName ?? ""), rec.resident_email);
    if (!fileName) {
      console.log(`SKIP ${rec.id} ${row.residentName ?? "—"} no local PDF`);
      continue;
    }
    const path = join(DOWNLOADS, fileName);
    if (!existsSync(path)) {
      console.log(`SKIP ${rec.id} ${row.residentName ?? "—"} missing ${fileName}`);
      continue;
    }
    const bytes = readFileSync(path);
    console.log(`${APPLY ? "FILE" : "DRY"} ${rec.id} ${row.residentName ?? "—"} ${fileName} ${(bytes.length / 1_000_000).toFixed(2)}MB`);
    if (!APPLY) continue;
    const objectId = randomUUID();
    const storagePath = `manager/${AMBIKA_MANAGER_ID}/${objectId}.pdf`;
    const { error: upErr } = await db.storage.from("manager-documents").upload(storagePath, bytes, {
      contentType: "application/pdf",
      upsert: false,
    });
    check(upErr);
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const now = new Date().toISOString();
    const email = String(rec.resident_email ?? "").trim().toLowerCase() || null;
    const { data: doc, error: docErr } = await db
      .from("manager_documents")
      .insert({
        manager_user_id: AMBIKA_MANAGER_ID,
        display_name: `Lease — ${row.residentName ?? "Resident"}`,
        original_filename: fileName,
        mime_type: "application/pdf",
        size_bytes: bytes.length,
        checksum,
        storage_path: storagePath,
        category: "lease",
        property_id: rec.property_id ?? null,
        lease_id: rec.id,
        resident_email: email,
        visibility: email ? "resident" : "manager",
        uploaded_by: AMBIKA_MANAGER_ID,
        updated_at: now,
      })
      .select("id")
      .single();
    if (docErr) {
      await db.storage.from("manager-documents").remove([storagePath]);
      throw new Error(docErr.message);
    }
    const libraryDocumentId = String(doc.id);
    const next = {
      ...row,
      documentOmitted: true,
      managerUploadedPdf: {
        ...pdfMeta(row.managerUploadedPdf),
        fileName,
        uploadedAt: row.managerUploadedPdf?.uploadedAt ?? now,
        libraryDocumentId,
      },
    };
    const { error: updErr } = await db
      .from("portal_lease_pipeline_records")
      .update({ row_data: next, updated_at: now })
      .eq("id", rec.id)
      .eq("manager_user_id", AMBIKA_MANAGER_ID);
    check(updErr);
    filed += 1;
  }
  console.log(`${APPLY ? "Filed" : "Would file"} ${filed} lease PDF(s) into Documents.`);
}

async function main() {
  if (SLIM) {
    await slimAmbikaLeasePayloads();
    return;
  }
  if (RESTORE_DOCS) {
    await restoreAmbikaLeaseDocuments();
    return;
  }

  const { data: profile, error: pErr } = await db
    .from("profiles")
    .select("id, email, full_name")
    .eq("id", AMBIKA_MANAGER_ID)
    .maybeSingle();
  check(pErr);
  if (!profile || String(profile.email ?? "").trim().toLowerCase() !== AMBIKA_MANAGER_EMAIL) {
    throw new Error(`Manager identity mismatch: expected ${AMBIKA_MANAGER_EMAIL}, got ${profile?.email}`);
  }

  const propertyIds = [...new Set(Object.values({
    "5257": ambikaSeattlePropertyId("5257"),
    "5259": ambikaSeattlePropertyId("5259"),
    "4709A": ambikaSeattlePropertyId("4709A"),
  }))];
  for (const id of propertyIds) {
    if (isLockedLiveListingId(id)) throw new Error(`Refusing locked seed listing id ${id}`);
  }

  const { data: propertyRows, error: propErr } = await db
    .from("manager_property_records")
    .select("id, manager_user_id, property_data, row_data")
    .eq("manager_user_id", AMBIKA_MANAGER_ID)
    .in("id", propertyIds);
  check(propErr);

  const properties = new Map<string, PropertySnap>();
  for (const row of propertyRows ?? []) {
    if (isLockedLiveListingId(row.id)) throw new Error(`Refusing locked seed listing id ${row.id}`);
    const propertyData = (row.property_data ?? {}) as Record<string, unknown>;
    const rooms = submissionRooms(propertyData);
    const label =
      String(propertyData.buildingName ?? "").trim() ||
      String((propertyData.listingSubmission as { propertyName?: string } | undefined)?.propertyName ?? "").trim() ||
      row.id;
    properties.set(row.id, { id: row.id, label, rooms });
  }

  const { data: apps, error: appErr } = await db
    .from("manager_application_records")
    .select("id, resident_email, row_data")
    .eq("manager_user_id", AMBIKA_MANAGER_ID);
  check(appErr);
  const existingRows: DemoApplicantRow[] = [];
  const byEmail = new Map<string, { id: string; row: DemoApplicantRow }>();
  for (const app of apps ?? []) {
    const row = openApplicantRow(app.row_data, app.id, true) as DemoApplicantRow;
    existingRows.push(row);
    const email = String(row.email ?? app.resident_email ?? "").trim().toLowerCase();
    if (email) byEmail.set(email, { id: app.id, row });
  }

  function existingFor(stay: AmbikaSeattleResident, propertyId: string, roomId: string): DemoApplicantRow | null {
    const email = residentEmailFor(stay);
    const byInbox = byEmail.get(email)?.row;
    if (byInbox) return byInbox;
    if (stay.email) {
      const real = byEmail.get(stay.email.trim().toLowerCase())?.row;
      if (real) return real;
    }
    const choice = `${propertyId}${LISTING_ROOM_CHOICE_SEP}${roomId}`;
    return (
      existingRows.find((row) => {
        const assigned = String(row.assignedRoomChoice ?? row.application?.roomChoice1 ?? "");
        const sameRoom = assigned === choice;
        return sameRoom && namesOverlap(String(row.name ?? row.application?.fullLegalName ?? ""), stay.name);
      }) ?? null
    );
  }

  const throughDate = todayIso();
  const planned: string[] = [];
  const warnings: string[] = [];

  type ResidentPlan = {
    stay: AmbikaSeattleResident;
    property: PropertySnap;
    roomId: string;
    existing: DemoApplicantRow | null;
    next: DemoApplicantRow;
    months: ReturnType<typeof paidLeaseHistoryMonths>;
    welcome: string;
    pdf: string;
  };
  const residentPlans: ResidentPlan[] = [];

  for (const stay of AMBIKA_SEATTLE_RESIDENTS) {
    const propertyId = ambikaSeattlePropertyId(stay.house);
    if (isLockedLiveListingId(propertyId)) {
      warnings.push(`REFUSED locked listing ${propertyId} (${stay.name})`);
      continue;
    }
    const property = properties.get(propertyId);
    if (!property) {
      warnings.push(`Missing property ${propertyId} (${stay.name})`);
      continue;
    }
    const roomId = roomIdForNumber(property.rooms, stay.roomNumber);
    if (!roomId) {
      warnings.push(`No room ${stay.roomNumber} on ${property.label} (${stay.name})`);
      continue;
    }
    const existing = existingFor(stay, property.id, roomId);
    const next = buildResidentRow(stay, property, roomId, existing);
    const email = next.email ?? residentEmailFor(stay);
    const months = stay.skipCharges || stay.rentCents == null
      ? []
      : paidLeaseHistoryMonths({
          start: stay.start,
          end: stay.end,
          throughDate,
          rentCents: stay.rentCents,
          utilitiesCents: stay.utilitiesCents,
          monthToMonth: stay.monthToMonth,
        });
    const pdf = stay.pdfFileName
      ? existsSync(join(DOWNLOADS, stay.pdfFileName))
        ? stay.pdfFileName
        : `MISSING ${stay.pdfFileName}`
      : "(none)";
    let welcome = "skip";
    if (stay.onboard) {
      if (email && !isPlaceholderResidentEmail(email)) welcome = `email ${email}`;
      else if (stay.phone) welcome = `SMS ${stay.phone}`;
      else welcome = "WARN no email/phone — file only";
    }
    planned.push(
      `${existing ? "UPDATE" : "ADD"} ${stay.name} · ${stay.house} R${stay.roomNumber} · ${email} · ${stay.start}→${stay.end ?? "MTM"} · charges ${months.filter((m) => m.status === "paid").length} paid / ${months.filter((m) => m.status === "pending").length} pending · pdf ${pdf} · ${welcome}`,
    );
    if (welcome.startsWith("WARN")) warnings.push(`${stay.name}: ${welcome}`);
    if (pdf.startsWith("MISSING")) warnings.push(`${stay.name}: ${pdf}`);
    residentPlans.push({ stay, property, roomId, existing, next, months, welcome, pdf });
  }

  type BookingPlan = { key: string; propertyId: string; roomId: string; name: string; checkIn: string; checkOut: string; reason: string; id: string };
  const bookingPlans: BookingPlan[] = [];
  for (const stay of AMBIKA_SEATTLE_BOOKINGS) {
    const propertyId = ambikaSeattlePropertyId(stay.house);
    if (isLockedLiveListingId(propertyId)) {
      warnings.push(`REFUSED locked listing ${propertyId} (${stay.name} booking)`);
      continue;
    }
    const property = properties.get(propertyId);
    if (!property) {
      warnings.push(`Missing property ${propertyId} (${stay.name} booking)`);
      continue;
    }
    const roomId = roomIdForNumber(property.rooms, stay.roomNumber);
    if (!roomId) {
      warnings.push(`No room ${stay.roomNumber} on ${property.label} (${stay.name} booking)`);
      continue;
    }
    const id = roomDateBlockRecordId(AMBIKA_MANAGER_ID, `ambika_${stay.key}`);
    const checkOut = exclusiveCheckoutAfterLastNight(stay.end);
    bookingPlans.push({
      key: stay.key,
      propertyId,
      roomId,
      name: stay.name,
      checkIn: stay.start,
      checkOut,
      reason: stay.reason === "Airbnb" ? IMPORTED_AIRBNB_REASON : "Booking",
      id,
    });
    planned.push(
      `BOOKING ${stay.name} · ${stay.house} R${stay.roomNumber} · ${stay.start}→${stay.end} · ${stay.reason} · no onboard`,
    );
  }

  console.log(`Target: production ${ref} · Ambika ${AMBIKA_MANAGER_EMAIL}`);
  console.log(`Through: ${throughDate} (Pacific)`);
  console.log(`Residents: ${residentPlans.length} · Bookings: ${bookingPlans.length}`);
  for (const line of planned) console.log(`  ${line}`);
  for (const w of warnings) console.log(`  WARN: ${w}`);

  if (!APPLY) {
    console.log("\nDRY RUN — pass --apply with ALLOW_PRODUCTION_AMBIKA_SEATTLE_OCCUPANCY=1 to write.");
    console.log("No manager_property_records writes. Listing advertised rent is not touched.");
    return;
  }

  const actor = { userId: AMBIKA_MANAGER_ID, email: AMBIKA_MANAGER_EMAIL, managerName: String(profile.full_name ?? "Ambika Mago") };

  for (const plan of residentPlans) {
    const { stay, property, next, months, existing } = plan;
    try {
    const sealed = sealApplicantRow(next, next.id, AMBIKA_MANAGER_ID);
    if (existing) {
      const { error } = await db
        .from("manager_application_records")
        .update({
          row_data: sealed,
          resident_email: next.email,
          property_id: property.id,
          assigned_property_id: property.id,
          updated_at: new Date().toISOString(),
        })
        .eq("id", next.id)
        .eq("manager_user_id", AMBIKA_MANAGER_ID);
      if (isRoomCapacityError(error)) {
        warnings.push(`${stay.name}: skipped — ${error?.message ?? "room capacity conflict"}`);
        continue;
      }
      check(error);
    } else {
      const { error } = await db.from("manager_application_records").insert({
        id: next.id,
        manager_user_id: AMBIKA_MANAGER_ID,
        resident_email: next.email,
        property_id: property.id,
        assigned_property_id: property.id,
        row_data: sealed,
      });
      if (isRoomCapacityError(error)) {
        warnings.push(`${stay.name}: skipped — ${error?.message ?? "room capacity conflict"}`);
        continue;
      }
      check(error);
    }

    const provisioned = await provisionApprovedResidentAccount(db, next, { mode: "silent_migration" });
    if (!provisioned.ok) {
      warnings.push(`${stay.name}: provision ${provisioned.error}`);
    } else {
      next.residentUserId = provisioned.userId;
      const { error: linkErr } = await db
        .from("manager_application_records")
        .update({
          row_data: sealApplicantRow(next, next.id, AMBIKA_MANAGER_ID),
          updated_at: new Date().toISOString(),
        })
        .eq("id", next.id)
        .eq("manager_user_id", AMBIKA_MANAGER_ID);
      check(linkErr);
    }

    const alreadyWelcomed = Boolean(existing?.manualResidentDetails?.onboardingWelcomeSentAt);
    const onboarding = await runExistingResidentOnboarding(db, actor, next, {
      sendWelcomeEmail: stay.onboard && !existing && !alreadyWelcomed,
      preserveExistingLease: Boolean(existing),
    });
    if (!onboarding.ok) warnings.push(`${stay.name}: onboarding ${onboarding.error}`);

    if (stay.onboard && existing && !alreadyWelcomed) {
      const welcome = await deliverExistingResidentWelcome(db, actor, {
        to: next.email!,
        residentName: stay.name,
        axisId: next.id,
        propertyLabel: property.label,
        residentPhone: stay.phone,
      });
      if (!welcome.ok) warnings.push(`${stay.name}: welcome ${welcome.error}`);
    }

    const pdf = pdfDataUrl(stay.pdfFileName);
    if (pdf) {
      const iso = new Date().toISOString();
      const axisId = normalizeApplicationAxisId(next.id);
      const leaseId = `lease_app_${axisId}`;
      const { data: leaseExisting } = await db
        .from("portal_lease_pipeline_records")
        .select("id, row_data")
        .eq("id", leaseId)
        .maybeSingle();
      const prev = (leaseExisting?.row_data ?? {}) as Record<string, unknown>;
      const leaseRow = normalizeLeasePipelineRow({
        ...prev,
        id: leaseId,
        residentName: stay.name,
        residentEmail: next.email,
        unit: property.label,
        bucket: "signed",
        axisId: next.id,
        propertyId: property.id,
        managerUserId: AMBIKA_MANAGER_ID,
        roomChoice: next.assignedRoomChoice,
        application: next.application,
        managerUploadedPdf: {
          dataUrl: pdf.dataUrl,
          fileName: pdf.fileName,
          uploadedAt: iso,
          originalDataUrl: pdf.dataUrl,
        },
        managerSignature: { role: "manager", name: actor.managerName, signedAtIso: iso },
        residentSignature: { role: "resident", name: stay.name, signedAtIso: iso },
        signatureName: stay.name,
        signedAtIso: iso,
        fullySignedAt: iso,
        externallySignedLease: true,
      });
      const { error: leaseErr } = await db.from("portal_lease_pipeline_records").upsert(
        {
          id: leaseId,
          manager_user_id: AMBIKA_MANAGER_ID,
          resident_email: next.email,
          resident_user_id: next.residentUserId ?? null,
          property_id: property.id,
          status: "signed",
          row_data: leaseRow,
          updated_at: iso,
        },
        { onConflict: "id" },
      );
      if (leaseErr) warnings.push(`${stay.name}: lease pdf ${leaseErr.message}`);
    }

    for (const month of months) {
      const id = uuidFrom(AMBIKA_MANAGER_ID, stay.key, month.yearMonth);
      const paid = month.status === "paid";
      const amountLabel = `$${(month.amountCents / 100).toFixed(2)}`;
      const charge: HouseholdCharge = {
        id,
        migrationSourceId: id,
        createdAt: `${month.dueDate}T12:00:00Z`,
        applicationId: next.id,
        residentEmail: next.email!,
        residentName: stay.name,
        residentUserId: next.residentUserId ?? null,
        propertyId: property.id,
        propertyLabel: property.label,
        managerUserId: AMBIKA_MANAGER_ID,
        kind: "rent",
        title: month.title,
        amountLabel,
        balanceLabel: paid ? "$0.00" : amountLabel,
        status: paid ? "paid" : "pending",
        paidAt: paid ? `${month.dueDate}T12:00:00Z` : undefined,
        paidAmountCents: paid ? month.amountCents : 0,
        blocksLeaseUntilPaid: false,
        dueDateLabel: month.dueDate,
        rentMonth: month.yearMonth,
        cancelledReminders: ["7d", "5d", "3d", "12h", "overdue_daily"],
      };
      const existingCharge = await db
        .from("portal_household_charge_records")
        .select("id")
        .eq("id", id)
        .eq("manager_user_id", AMBIKA_MANAGER_ID)
        .maybeSingle();
      check(existingCharge.error);
      if (!existingCharge.data) {
        const { error } = await db.from("portal_household_charge_records").insert({
          id,
          manager_user_id: AMBIKA_MANAGER_ID,
          resident_email: next.email,
          resident_user_id: next.residentUserId ?? null,
          property_id: property.id,
          status: charge.status,
          row_data: charge,
          updated_at: new Date().toISOString(),
        });
        check(error);
      }
      await syncLedgerChargeEntry(db, charge);
    }
    } catch (err) {
      warnings.push(`${stay.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  for (const booking of bookingPlans) {
    const { data: existing } = await db
      .from("portal_schedule_records")
      .select("id")
      .eq("id", booking.id)
      .maybeSingle();
    if (existing) continue;
    const createdAt = new Date().toISOString();
    const { error } = await db.from("portal_schedule_records").insert({
      id: booking.id,
      manager_user_id: AMBIKA_MANAGER_ID,
      property_id: booking.propertyId,
      record_type: ROOM_DATE_BLOCK_RECORD_TYPE,
      row_data: {
        id: booking.id,
        recordType: ROOM_DATE_BLOCK_RECORD_TYPE,
        propertyId: booking.propertyId,
        roomId: booking.roomId,
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
        reason: booking.reason,
        residentName: booking.name,
        createdAt,
        startsAt: `${booking.checkIn}T00:00:00`,
        endsAt: `${booking.checkOut}T00:00:00`,
      },
      updated_at: createdAt,
    });
    if (error) warnings.push(`${booking.name} booking: ${error.message}`);
  }

  console.log("\nAPPLY complete.");
  for (const w of warnings) console.log(`  WARN: ${w}`);
  console.log("Check Ambika Current, Payments, Bookings. House listing rent must still be the advertised numbers.");
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
