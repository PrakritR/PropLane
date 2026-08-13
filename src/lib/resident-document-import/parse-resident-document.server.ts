import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { DemoApplicantRow } from "@/data/demo-portal";
import type { TraceActor } from "@/lib/observability/langfuse";
import { normalizeManagerListingSubmissionV1, type ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { matchResidentFromApplications } from "@/lib/resident-document-import/match-resident";
import { extractResidentDocumentWithAi } from "@/lib/resident-document-import/parse-ai.server";
import {
  matchPropertyFromCatalog,
  matchRoomInProperty,
  propertyCatalogFromSubmission,
  type PropertyCatalogEntry,
} from "@/lib/resident-document-import/property-catalog";
import {
  firstEmail,
  firstIsoDate,
  firstMoneyAmount,
  firstPhone,
  firstUsDate,
  labeledValue,
  normalizeDocumentText,
} from "@/lib/resident-document-import/text-extract";
import type {
  ParsedFieldConfidence,
  ParsedResidentDocument,
  ParsedResidentDocumentField,
  ResidentDocumentKind,
} from "@/lib/resident-document-import/types";
import { dataUrlToPdfBytes, extractLeasePdfPages, parseUploadedLeasePdfBytes } from "@/lib/uploaded-lease-parse.server";
import { joinLeasePages } from "@/lib/uploaded-lease-extraction";

function field(
  key: string,
  label: string,
  value: string | null | undefined,
  source: ParsedResidentDocumentField["source"],
  confidence: ParsedFieldConfidence = "medium",
): ParsedResidentDocumentField | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return null;
  return { key, label, value: trimmed, confidence, source };
}

function mergeField(
  fields: Map<string, ParsedResidentDocumentField>,
  next: ParsedResidentDocumentField | null,
) {
  if (!next) return;
  const existing = fields.get(next.key);
  if (!existing || confidenceRank(next.confidence) > confidenceRank(existing.confidence)) {
    fields.set(next.key, next);
  }
}

function confidenceRank(c: ParsedFieldConfidence): number {
  return c === "high" ? 3 : c === "medium" ? 2 : 1;
}

function regexBaseline(text: string): ParsedResidentDocumentField[] {
  const fields: ParsedResidentDocumentField[] = [];
  const push = (f: ParsedResidentDocumentField | null) => {
    if (f) fields.push(f);
  };
  push(field("tenantEmail", "Email", firstEmail(text), "regex", "medium"));
  push(field("tenantPhone", "Phone", firstPhone(text), "regex", "low"));
  push(
    field(
      "tenantName",
      "Resident name",
      labeledValue(text, ["tenant", "resident", "lessee", "applicant name", "name of tenant"]),
      "regex",
      "low",
    ),
  );
  push(
    field(
      "propertyAddress",
      "Property address",
      labeledValue(text, ["premises", "property address", "address", "located at"]),
      "regex",
      "low",
    ),
  );
  push(field("monthlyRent", "Monthly rent", firstMoneyAmount(text), "regex", "low"));
  push(field("leaseStart", "Lease start", firstIsoDate(text) ?? firstUsDate(text), "regex", "low"));
  return fields;
}

async function loadManagerPropertyCatalog(
  db: SupabaseClient,
  managerUserId: string,
): Promise<PropertyCatalogEntry[]> {
  const { data, error } = await db
    .from("manager_property_records")
    .select("id, property_data, row_data")
    .eq("manager_user_id", managerUserId)
    .limit(500);
  if (error) throw new Error(error.message);
  const catalog: PropertyCatalogEntry[] = [];
  for (const row of data ?? []) {
    const propertyId = String(row.id ?? "").trim();
    if (!propertyId) continue;
    const propertyData = (row.property_data ?? row.row_data ?? {}) as Record<string, unknown>;
    const submissionRaw =
      (propertyData.listingSubmission as ManagerListingSubmissionV1 | undefined) ??
      (propertyData.submission as ManagerListingSubmissionV1 | undefined);
    if (!submissionRaw) continue;
    const sub = normalizeManagerListingSubmissionV1(submissionRaw);
    catalog.push(propertyCatalogFromSubmission(propertyId, sub));
  }
  return catalog;
}

async function loadManagerApplications(
  db: SupabaseClient,
  managerUserId: string,
): Promise<DemoApplicantRow[]> {
  const { data, error } = await db
    .from("manager_application_records")
    .select("id, row_data")
    .eq("manager_user_id", managerUserId)
    .limit(2000);
  if (error) throw new Error(error.message);
  return (data ?? [])
    .map((row) => row.row_data as DemoApplicantRow)
    .filter((row): row is DemoApplicantRow => Boolean(row && typeof row === "object"));
}

export async function parseResidentDocumentPdf(args: {
  db: SupabaseClient;
  managerUserId: string;
  kind: ResidentDocumentKind;
  dataUrl: string;
  fileName: string;
  preferredPropertyId?: string | null;
  actor: TraceActor;
}): Promise<ParsedResidentDocument> {
  const bytes = dataUrlToPdfBytes(args.dataUrl);
  const pages = await extractLeasePdfPages(bytes);
  const joined = joinLeasePages(pages);
  const text = normalizeDocumentText(joined.text);
  const warnings: string[] = [];

  const [catalog, applications] = await Promise.all([
    loadManagerPropertyCatalog(args.db, args.managerUserId),
    loadManagerApplications(args.db, args.managerUserId),
  ]);

  const fieldMap = new Map<string, ParsedResidentDocumentField>();
  for (const baseline of regexBaseline(text)) mergeField(fieldMap, baseline);

  const ai = await extractResidentDocumentWithAi({
    kind: args.kind,
    text,
    fileName: args.fileName,
    catalog,
    preferredPropertyId: args.preferredPropertyId,
    actor: args.actor,
  });

  if (ai) {
    warnings.push(...ai.warnings);
    const conf = (key: string): ParsedFieldConfidence => ai.fieldConfidence[key] ?? "medium";
    mergeField(fieldMap, field("tenantName", "Resident name", ai.tenantName, "ai", conf("tenantName")));
    mergeField(fieldMap, field("tenantEmail", "Email", ai.tenantEmail, "ai", conf("tenantEmail")));
    mergeField(fieldMap, field("tenantPhone", "Phone", ai.tenantPhone, "ai", conf("tenantPhone")));
    mergeField(fieldMap, field("propertyAddress", "Property address", ai.propertyAddress, "ai", conf("propertyAddress")));
    mergeField(fieldMap, field("unitOrRoom", "Room / unit", ai.unitOrRoom, "ai", conf("unitOrRoom")));
    mergeField(fieldMap, field("leaseStart", "Lease start", ai.leaseStart, "ai", conf("leaseStart")));
    mergeField(fieldMap, field("leaseEnd", "Lease end", ai.leaseEnd, "ai", conf("leaseEnd")));
    mergeField(fieldMap, field("leaseTerm", "Lease term", ai.leaseTerm, "ai", conf("leaseTerm")));
    mergeField(fieldMap, field("monthlyRent", "Monthly rent", ai.monthlyRent, "ai", conf("monthlyRent")));
    mergeField(fieldMap, field("securityDeposit", "Security deposit", ai.securityDeposit, "ai", conf("securityDeposit")));
    mergeField(fieldMap, field("monthlyUtilities", "Monthly utilities", ai.monthlyUtilities, "ai", conf("monthlyUtilities")));
  } else if (process.env.NODE_ENV !== "test") {
    warnings.push("AI extraction was unavailable — review the pre-filled fields carefully.");
  }

  let leaseParse = null;
  if (args.kind === "lease") {
    leaseParse = await parseUploadedLeasePdfBytes({ bytes, fileName: args.fileName });
    for (const leaseField of leaseParse.fields) {
      if (leaseField.status !== "extracted" || !leaseField.value.trim()) continue;
      const keyMap: Record<string, string> = {
        tenantName: "tenantName",
        propertyAddress: "propertyAddress",
        leaseStart: "leaseStart",
        leaseEnd: "leaseEnd",
        monthlyRent: "monthlyRent",
        securityDeposit: "securityDeposit",
      };
      const key = keyMap[leaseField.key];
      if (!key) continue;
      mergeField(
        fieldMap,
        field(key, leaseField.label, leaseField.value, "deterministic", leaseField.status === "extracted" ? "high" : "medium"),
      );
    }
  }

  const fields = [...fieldMap.values()];
  const tenantEmail = fields.find((f) => f.key === "tenantEmail")?.value ?? null;
  const tenantName = fields.find((f) => f.key === "tenantName")?.value ?? null;
  const residentMatch = matchResidentFromApplications(applications, { email: tenantEmail, name: tenantName }, args.managerUserId);

  const propertyAddress = fields.find((f) => f.key === "propertyAddress")?.value ?? "";
  const unitOrRoom = fields.find((f) => f.key === "unitOrRoom")?.value ?? "";
  const propertyHit = matchPropertyFromCatalog(catalog, {
    propertyId: args.preferredPropertyId ?? undefined,
    addressText: propertyAddress,
    unitText: unitOrRoom,
  });
  const roomHit = propertyHit ? matchRoomInProperty(propertyHit, unitOrRoom) : null;

  const leaseSignatures = ai?.leaseSignatures ?? undefined;
  const fullyExecuted =
    leaseSignatures?.fullyExecuted === true ||
    (leaseSignatures?.managerSigned === true && leaseSignatures?.residentSigned === true);
  const documentComplete = ai?.documentComplete === true || fullyExecuted;

  const suggestedApplicationBucket: ParsedResidentDocument["suggestedApplicationBucket"] =
    documentComplete || args.kind === "lease" ? "approved" : "pending";
  const suggestedLeaseBucket: ParsedResidentDocument["suggestedLeaseBucket"] = fullyExecuted
    ? "signed"
    : leaseSignatures?.residentSigned
      ? "signed"
      : leaseSignatures?.managerSigned
        ? "resident"
        : "manager";

  return {
    kind: args.kind,
    fileName: args.fileName,
    extractedCharacterCount: text.length,
    fields,
    residentMatch,
    propertyMatch: propertyHit
      ? {
          propertyId: propertyHit.propertyId,
          propertyLabel: propertyHit.label,
          roomId: roomHit?.roomId,
          roomLabel: roomHit?.roomLabel,
          confidence: propertyHit.confidence,
        }
      : args.preferredPropertyId
        ? {
            propertyId: args.preferredPropertyId,
            propertyLabel:
              catalog.find((row) => row.propertyId === args.preferredPropertyId)?.label ??
              args.preferredPropertyId,
            confidence: "medium",
          }
        : null,
    leaseSignatures,
    suggestedApplicationBucket,
    suggestedLeaseBucket,
    leaseParse,
    warnings,
  };
}
