/**
 * Portfolio import — deterministic header mapping.
 *
 * A rent-roll export names its columns however the source product feels like
 * ("Tenant", "Tenants", "Occupant", "Resident Name" all mean the same thing).
 * This module is the first, cheap pass: exact and synonym matches only. What
 * is left `unmapped` here is exactly what a separate server module hands to
 * the AI header mapper — never row data, only header text.
 *
 * Isomorphic: no server-only imports, no fetch, no database. Safe to call
 * from the wizard client, the assistant tools, and every server reader.
 */

import type {
  PortfolioImportCanonicalKey,
  PortfolioImportColumnMapping,
  PortfolioImportMatchConfidence,
  PortfolioImportSourcePreset,
} from "@/lib/portfolio-import/types";
import { PORTFOLIO_IMPORT_CANONICAL_KEYS } from "@/lib/portfolio-import/types";

/** Lowercase, strip everything but letters and digits — "Zip Code" and "ZIP-CODE" collide on purpose. */
function normalizeHeaderText(raw: string): string {
  return raw
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Synonyms a rent roll actually uses, per canonical key. Keep "Market Rent" and
 * "Deposit" out of `monthlyRent` on purpose — see the header-mapping tests.
 */
const SYNONYMS: Record<PortfolioImportCanonicalKey, string[]> = {
  propertyName: ["Property", "Property Name", "Building", "Building Name"],
  address: ["Address", "Street", "Property Address", "Street Address"],
  city: ["City"],
  state: ["State"],
  zip: ["Zip", "Zip Code", "Postal Code"],
  unitLabel: ["Unit", "Unit #", "Unit Number", "Apt", "Apartment", "Room", "Room #", "Bed"],
  beds: ["Beds", "Bedrooms", "BR"],
  baths: ["Baths", "Bathrooms", "BA"],
  sqft: ["Sq Ft", "Sqft", "Square Feet", "Size"],
  residentName: ["Tenant", "Tenant Name", "Tenants", "Resident", "Resident Name", "Name", "Occupant"],
  residentEmail: ["Email", "Tenant Email", "Resident Email", "E-mail"],
  residentPhone: ["Phone", "Mobile", "Cell", "Tenant Phone", "Phone Number"],
  monthlyRent: ["Rent", "Monthly Rent", "Rent Amount", "Lease Rent", "Current Rent"],
  securityDeposit: ["Deposit", "Security Deposit", "Deposits Held", "Deposit Held"],
  leaseStart: ["Lease Start", "Lease From", "Start Date", "Lease Begin"],
  leaseEnd: ["Lease End", "Lease To", "End Date", "Lease Expiration", "Expires"],
  moveIn: ["Move-in", "Move In", "Move In Date"],
  moveOut: ["Move-out", "Move Out", "Move Out Date"],
  occupancyStatus: ["Status", "Occupancy", "Occupancy Status", "Unit Status"],
  balance: ["Past Due", "Balance", "Balance Due", "Amount Owed", "Delinquent", "Outstanding"],
  notes: ["Notes", "Comments"],
};

/** normalized synonym text -> canonical key. Built once at module load. */
const SYNONYM_LOOKUP = new Map<string, PortfolioImportCanonicalKey>();
for (const key of PORTFOLIO_IMPORT_CANONICAL_KEYS) {
  for (const synonym of SYNONYMS[key]) {
    SYNONYM_LOOKUP.set(normalizeHeaderText(synonym), key);
  }
}

/** normalized literal canonical key text -> canonical key, for the "exact" tier. */
const EXACT_LOOKUP = new Map<string, PortfolioImportCanonicalKey>();
for (const key of PORTFOLIO_IMPORT_CANONICAL_KEYS) {
  EXACT_LOOKUP.set(key.toLowerCase(), key);
}

function matchCanonicalKey(header: string): { key: PortfolioImportCanonicalKey; confidence: PortfolioImportMatchConfidence } | null {
  const raw = header.trim().toLowerCase();
  const exact = EXACT_LOOKUP.get(raw);
  if (exact) return { key: exact, confidence: "exact" };

  const normalized = normalizeHeaderText(header);
  const synonym = SYNONYM_LOOKUP.get(normalized);
  if (synonym) return { key: synonym, confidence: "synonym" };

  return null;
}

/** AppFolio-flavored header signals: singular "Tenant", singular "Deposit", "Move-in". */
const APPFOLIO_SIGNALS = ["tenant", "leasefrom", "movein", "deposit"];
/** Buildium-flavored header signals: plural "Tenants", "Market Rent", "Deposits Held", "Square Feet". */
const BUILDIUM_SIGNALS = ["tenants", "marketrent", "depositsheld", "squarefeet", "monthlyrent"];

function detectPreset(headers: string[]): PortfolioImportSourcePreset {
  const normalized = headers.map(normalizeHeaderText);
  let appfolioScore = 0;
  let buildiumScore = 0;
  for (const h of normalized) {
    if (APPFOLIO_SIGNALS.includes(h)) appfolioScore += 1;
    if (BUILDIUM_SIGNALS.includes(h)) buildiumScore += 1;
  }
  if (buildiumScore > appfolioScore && buildiumScore > 0) return "buildium";
  if (appfolioScore > buildiumScore && appfolioScore > 0) return "appfolio";
  return "generic";
}

/**
 * Deterministic column mapping: exact match, then synonym match, everything
 * else comes back `unmapped` for the (separate) AI header mapper to try.
 */
export function mapPortfolioImportHeaders(
  headers: string[],
  samples: string[][],
  presetHint?: PortfolioImportSourcePreset,
): { columns: PortfolioImportColumnMapping[]; preset: PortfolioImportSourcePreset; unmapped: number[] } {
  const columns: PortfolioImportColumnMapping[] = headers.map((header, index) => {
    const match = matchCanonicalKey(header);
    const columnSamples = samples
      .map((row) => (row[index] ?? "").trim())
      .filter((cell) => cell.length > 0)
      .slice(0, 3);
    return {
      header,
      index,
      key: match?.key ?? null,
      confidence: match?.confidence ?? "unmapped",
      samples: columnSamples,
    };
  });

  const unmapped = columns.filter((c) => c.key === null).map((c) => c.index);
  const preset = presetHint ?? detectPreset(headers);

  return { columns, preset, unmapped };
}

/** The wizard's manual "Match columns" override — always wins over any auto match. */
export function applyManualColumnMapping(
  columns: PortfolioImportColumnMapping[],
  index: number,
  key: PortfolioImportCanonicalKey | null,
): PortfolioImportColumnMapping[] {
  return columns.map((column) =>
    column.index === index ? { ...column, key, confidence: key === null ? "unmapped" : "manual" } : column,
  );
}
