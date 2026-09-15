/**
 * Portfolio import — pure draft builder.
 *
 * Turns a `PortfolioImportSourceTable` (already read, never interpreted) plus
 * its column mapping into the one `PortfolioImportDraft` every entry point
 * shares: properties, units, residents grouped from rows; money and dates
 * parsed; issues and planned tasks derived. Nothing here touches the
 * database, React, or a file — isomorphic and pure so the wizard, the
 * assistant tools and this test suite all see identical behavior.
 *
 * `recomputeDraftAfterEdits` re-runs the *derived* half (issues, balances,
 * tasks, invite channels) after the wizard edits a resident/unit or toggles
 * `excluded`, without re-reading the source file. To make that safe without
 * the raw row text, issues split into two families:
 *  - structural (missing_property, summary_row_skipped, unmapped_column) and
 *    the parse-time invalid_email / invalid_phone pair are carried forward
 *    verbatim, except invalid_email/invalid_phone drop out once the field is
 *    fixed or the row is excluded;
 *  - everything else (missing_email, missing_phone, duplicate_resident,
 *    shared_unit, past_due_balance, vacant_unit, missing_rent) is fully
 *    regenerated from current field values every time.
 */

import { normalizeE164 } from "@/lib/phone-e164";
import type {
  PortfolioImportBalance,
  PortfolioImportCanonicalKey,
  PortfolioImportColumnMapping,
  PortfolioImportDraft,
  PortfolioImportIssue,
  PortfolioImportIssueCode,
  PortfolioImportIssueSeverity,
  PortfolioImportPlannedTask,
  PortfolioImportProperty,
  PortfolioImportResident,
  PortfolioImportSourceKind,
  PortfolioImportSourcePreset,
  PortfolioImportSourceRef,
  PortfolioImportSourceTable,
  PortfolioImportStatus,
  PortfolioImportSummary,
  PortfolioImportUnit,
} from "@/lib/portfolio-import/types";

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function normalizeAddress(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[.,#]/g, "")
    .replace(/\s+/g, " ");
}

function slugify(s: string): string {
  const slug = s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-+|-+$)/g, "");
  return slug || "x";
}

function uniqueKey(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let i = 2;
  while (used.has(`${base}-${i}`)) i++;
  const key = `${base}-${i}`;
  used.add(key);
  return key;
}

function splitResidentNames(raw: string): string[] {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return [];
  return trimmed
    .split(/\s*(?:&|,|;|\/|\band\b)\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseMoney(raw: string): number | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  let negative = false;
  let s = trimmed;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[$,\s]/g, "");
  if (s.startsWith("-")) {
    negative = true;
    s = s.slice(1);
  }
  if (!s || !/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

function parseIntSafe(raw: string): number | undefined {
  const cleaned = (raw ?? "").replace(/[^\d.-]/g, "");
  if (!cleaned) return undefined;
  const n = parseInt(cleaned, 10);
  return Number.isFinite(n) ? n : undefined;
}

function parseFloatSafe(raw: string): number | undefined {
  const cleaned = (raw ?? "").replace(/[^\d.-]/g, "");
  if (!cleaned) return undefined;
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : undefined;
}

const MONTH_MAP: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

function isValidYMD(y: number, mo: number, d: number): boolean {
  return mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && y >= 1000 && y <= 9999;
}

function isoDate(y: number, mo: number, d: number): string {
  return `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function twoDigitYear(y: number): number {
  return y + (y <= 68 ? 2000 : 1900);
}

/** Accepts YYYY-MM-DD, M/D/YYYY, MM/DD/YY, "Mar 1, 2026", "1-Mar-26". */
function parseDateField(raw: string): { value: string | null; rawNote?: string } {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { value: null };

  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(trimmed);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (isValidYMD(y, mo, d)) return { value: isoDate(y, mo, d) };
  }

  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(trimmed);
  if (m) {
    const mo = Number(m[1]);
    const d = Number(m[2]);
    const year = m[3].length <= 2 ? twoDigitYear(Number(m[3])) : Number(m[3]);
    if (isValidYMD(year, mo, d)) return { value: isoDate(year, mo, d) };
  }

  m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(trimmed);
  if (m) {
    const mo = MONTH_MAP[m[1].slice(0, 3).toLowerCase()];
    const d = Number(m[2]);
    const y = Number(m[3]);
    if (mo && isValidYMD(y, mo, d)) return { value: isoDate(y, mo, d) };
  }

  m = /^(\d{1,2})-([A-Za-z]{3,9})-(\d{2,4})$/.exec(trimmed);
  if (m) {
    const mo = MONTH_MAP[m[2].slice(0, 3).toLowerCase()];
    const d = Number(m[1]);
    const year = m[3].length <= 2 ? twoDigitYear(Number(m[3])) : Number(m[3]);
    if (mo && isValidYMD(year, mo, d)) return { value: isoDate(year, mo, d) };
  }

  return { value: null, rawNote: trimmed };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseEmailField(raw: string): { value: string | null; invalid: boolean } {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { value: null, invalid: false };
  const lower = trimmed.toLowerCase();
  if (!EMAIL_RE.test(lower)) return { value: null, invalid: true };
  return { value: lower, invalid: false };
}

function parsePhoneField(raw: string): { value: string | null; invalid: boolean } {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { value: null, invalid: false };
  const e164 = normalizeE164(trimmed);
  if (!e164) return { value: null, invalid: true };
  return { value: e164, invalid: false };
}

function parseISODate(iso: string): Date {
  const [y, mo, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, d));
}

function formatISO(date: Date): string {
  const y = date.getUTCFullYear();
  const mo = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${d}`;
}

function addDaysISO(date: Date, days: number): string {
  return formatISO(new Date(date.getTime() + days * 86_400_000));
}

function diffInDays(a: Date, b: Date): number {
  return Math.round((a.getTime() - b.getTime()) / 86_400_000);
}

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatMonthDay(date: Date): string {
  return `${MONTH_ABBR[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

/** Normalizes any given `Date` to UTC midnight of its own Y/M/D. Defaults to now. */
function resolveToday(explicit?: Date): Date {
  const d = explicit ?? new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function makeIssue(
  code: PortfolioImportIssueCode,
  severity: PortfolioImportIssueSeverity,
  message: string,
  detail: string | undefined,
  refs: {
    propertyKey?: string;
    unitKey?: string;
    residentKey?: string;
    source?: PortfolioImportSourceRef;
    idSuffix?: string;
  },
): PortfolioImportIssue {
  const idParts = [
    code,
    refs.propertyKey,
    refs.unitKey,
    refs.residentKey,
    refs.source ? `${refs.source.sheet ?? ""}r${refs.source.row}` : undefined,
    refs.idSuffix,
  ].filter((v): v is string => v !== undefined && v !== "");
  return {
    id: idParts.join(":"),
    code,
    severity,
    message,
    detail,
    propertyKey: refs.propertyKey,
    unitKey: refs.unitKey,
    residentKey: refs.residentKey,
    source: refs.source,
  };
}

function buildKeyToIndex(
  columns: PortfolioImportColumnMapping[],
): Partial<Record<PortfolioImportCanonicalKey, number>> {
  const map: Partial<Record<PortfolioImportCanonicalKey, number>> = {};
  for (const col of columns) {
    if (col.key && map[col.key] === undefined) map[col.key] = col.index;
  }
  return map;
}

// ---------------------------------------------------------------------------
// Exclusion — cascades property -> unit -> resident
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Dynamic derivation — issues, balances, tasks, invite channels
// ---------------------------------------------------------------------------

const DYNAMIC_ISSUE_CODES = new Set<PortfolioImportIssueCode>([
  "missing_email",
  "missing_phone",
  "duplicate_resident",
  "shared_unit",
  "past_due_balance",
  "vacant_unit",
  "missing_rent",
]);

/** Structural issues + the parse-time invalid_email/invalid_phone pair, minus anything now stale. */
function carryForwardIssues(
  oldIssues: PortfolioImportIssue[],
  residents: Map<string, PortfolioImportResident>,
  units: Map<string, PortfolioImportUnit>,
  properties: Map<string, PortfolioImportProperty>,
): PortfolioImportIssue[] {
  return oldIssues
    .filter((issue) => !DYNAMIC_ISSUE_CODES.has(issue.code))
    .filter((issue) => {
      if (issue.code !== "invalid_email" && issue.code !== "invalid_phone") return true;
      const resident = issue.residentKey ? residents.get(issue.residentKey) : undefined;
      if (!resident) return false;
      if (isResidentExcluded(resident, units, properties)) return false;
      return issue.code === "invalid_email" ? resident.email === null : resident.phone === null;
    });
}

function generateDynamicIssuesBalancesTasks(
  properties: Map<string, PortfolioImportProperty>,
  units: Map<string, PortfolioImportUnit>,
  residents: PortfolioImportResident[],
  opts: {
    today: Date;
    existingEmails: Set<string>;
    sourceKind: PortfolioImportSourceKind;
    /** Residents already covered by an invalid_email/invalid_phone issue — skip the softer missing_* check for them. */
    invalidEmailResidentKeys?: Set<string>;
    invalidPhoneResidentKeys?: Set<string>;
  },
): {
  issues: PortfolioImportIssue[];
  balances: PortfolioImportBalance[];
  tasks: PortfolioImportPlannedTask[];
  residents: PortfolioImportResident[];
} {
  const issues: PortfolioImportIssue[] = [];
  const balances: PortfolioImportBalance[] = [];
  const tasks: PortfolioImportPlannedTask[] = [];
  const seenEmails = new Set(opts.existingEmails);

  for (const unit of units.values()) {
    if (isUnitExcluded(unit, properties)) continue;
    const property = properties.get(unit.propertyKey);
    if (unit.occupancy === "vacant") {
      issues.push(
        makeIssue("vacant_unit", "info", `${unit.label} at ${property?.name ?? "the property"} is vacant.`, undefined, {
          propertyKey: unit.propertyKey,
          unitKey: unit.key,
          source: unit.source,
        }),
      );
    }
    if (unit.residentKeys.length > 1) {
      issues.push(
        makeIssue(
          "shared_unit",
          "review",
          `${unit.label} has ${unit.residentKeys.length} residents sharing the lease.`,
          "Rent is recorded once on the unit, not per resident.",
          { propertyKey: unit.propertyKey, unitKey: unit.key, source: unit.source },
        ),
      );
    }
    if (unit.monthlyRent === null) {
      issues.push(
        makeIssue("missing_rent", "review", `${unit.label} has no rent amount.`, undefined, {
          propertyKey: unit.propertyKey,
          unitKey: unit.key,
          source: unit.source,
        }),
      );
    }
  }

  for (const property of properties.values()) {
    if (property.excluded) continue;
    tasks.push({
      key: `add_photos:${property.key}`,
      kind: "add_photos",
      title: `Add photos and details — ${property.name}`,
      propertyKey: property.key,
      dueDate: addDaysISO(opts.today, 7),
      taskType: "house",
      urgency: "scheduled",
    });
    if (opts.sourceKind === "pdf") {
      tasks.push({
        key: `verify_imported_data:${property.key}`,
        kind: "verify_imported_data",
        title: `Verify imported data — ${property.name}`,
        propertyKey: property.key,
        dueDate: addDaysISO(opts.today, 3),
        taskType: "general",
        urgency: "urgent",
      });
    }
  }

  tasks.push({
    key: "connect_payouts",
    kind: "connect_payouts",
    title: "Connect payouts to collect rent in PropLane",
    dueDate: addDaysISO(opts.today, 7),
    taskType: "general",
    urgency: "scheduled",
  });

  const invalidEmailResidentKeys = opts.invalidEmailResidentKeys ?? new Set<string>();
  const invalidPhoneResidentKeys = opts.invalidPhoneResidentKeys ?? new Set<string>();

  const updatedResidents = residents.map((resident) => {
    if (isResidentExcluded(resident, units, properties)) return resident;

    const inviteChannels = { email: !!resident.email, text: !!resident.phone };
    const next: PortfolioImportResident = { ...resident, inviteChannels };

    // On a shared unit only the primary (first-listed) resident is checked for a
    // missing email at block severity — a co-resident with no email of their own
    // does not stop the import; they still get the softer missing_phone info check.
    const unit = units.get(resident.unitKey);
    const isPrimary = !unit || unit.residentKeys[0] === resident.key;

    if (resident.email === null) {
      // An invalid (as opposed to blank) email already has its own invalid_email
      // block issue — never double up with missing_email for the same resident.
      if (isPrimary && !invalidEmailResidentKeys.has(resident.key)) {
        issues.push(
          makeIssue(
            "missing_email",
            "block",
            `${resident.name} has no email.`,
            "They can still be imported, but not invited by email. Add one, exclude the row, or continue and a task will remind you.",
            { propertyKey: resident.propertyKey, unitKey: resident.unitKey, residentKey: resident.key, source: resident.source },
          ),
        );
        tasks.push({
          key: `add_resident_email:${resident.key}`,
          kind: "add_resident_email",
          title: `Add an email address — ${resident.name}`,
          propertyKey: resident.propertyKey,
          unitKey: resident.unitKey,
          residentKey: resident.key,
          dueDate: addDaysISO(opts.today, 3),
          taskType: "general",
          urgency: "urgent",
        });
      }
    } else {
      const emailKey = resident.email;
      if (seenEmails.has(emailKey)) {
        issues.push(
          makeIssue(
            "duplicate_resident",
            "review",
            `${resident.name}'s email (${resident.email}) is already used by another resident.`,
            undefined,
            { propertyKey: resident.propertyKey, unitKey: resident.unitKey, residentKey: resident.key, source: resident.source },
          ),
        );
      }
      seenEmails.add(emailKey);
    }

    if (resident.phone === null && !invalidPhoneResidentKeys.has(resident.key)) {
      issues.push(
        makeIssue("missing_phone", "info", `${resident.name} has no phone number.`, undefined, {
          propertyKey: resident.propertyKey,
          unitKey: resident.unitKey,
          residentKey: resident.key,
          source: resident.source,
        }),
      );
    }

    if (resident.balance !== null && resident.balance > 0) {
      issues.push(
        makeIssue(
          "past_due_balance",
          "review",
          `${resident.name} has a past-due balance of $${resident.balance.toFixed(2)}.`,
          undefined,
          { propertyKey: resident.propertyKey, unitKey: resident.unitKey, residentKey: resident.key, source: resident.source },
        ),
      );
      balances.push({ key: `balance:${resident.key}`, residentKey: resident.key, amount: resident.balance, create: true });
    }

    if (!resident.leasePdf) {
      tasks.push({
        key: `upload_signed_lease:${resident.key}`,
        kind: "upload_signed_lease",
        title: `Upload signed lease — ${resident.name}`,
        propertyKey: resident.propertyKey,
        unitKey: resident.unitKey,
        residentKey: resident.key,
        dueDate: addDaysISO(opts.today, 14),
        taskType: "general",
        urgency: "scheduled",
      });
    }

    if (resident.leaseEnd) {
      const leaseEndDate = parseISODate(resident.leaseEnd);
      const diffDays = diffInDays(leaseEndDate, opts.today);
      if (diffDays <= 60) {
        let due = addDaysISO(leaseEndDate, -30);
        if (parseISODate(due).getTime() < opts.today.getTime()) due = formatISO(opts.today);
        tasks.push({
          key: `lease_ending:${resident.key}`,
          kind: "lease_ending",
          title: `Lease ends ${formatMonthDay(leaseEndDate)} — renew or plan move-out: ${resident.name}`,
          propertyKey: resident.propertyKey,
          unitKey: resident.unitKey,
          residentKey: resident.key,
          dueDate: due,
          taskType: "general",
          urgency: "deadline",
        });
      }
    }

    return next;
  });

  return { issues, balances, tasks, residents: updatedResidents };
}

// ---------------------------------------------------------------------------
// buildPortfolioImportDraft
// ---------------------------------------------------------------------------

export function buildPortfolioImportDraft(input: {
  table: PortfolioImportSourceTable;
  columns: PortfolioImportColumnMapping[];
  sourceKind: PortfolioImportSourceKind;
  preset: PortfolioImportSourcePreset;
  fileName: string;
  today?: Date;
  aiMappedHeaders?: boolean;
  existingEmails?: string[];
}): PortfolioImportDraft {
  const { table, columns, sourceKind, preset, fileName } = input;
  const today = resolveToday(input.today);
  const aiMappedHeaders = input.aiMappedHeaders ?? false;
  const existingEmails = new Set((input.existingEmails ?? []).map((e) => e.toLowerCase().trim()).filter(Boolean));
  const keyToIndex = buildKeyToIndex(columns);

  const properties = new Map<string, PortfolioImportProperty>();
  const units = new Map<string, PortfolioImportUnit>();
  const residents: PortfolioImportResident[] = [];
  const usedResidentKeys = new Set<string>();
  const structuralIssues: PortfolioImportIssue[] = [];
  let missingPropertyIssueAdded = false;

  const get = (row: PortfolioImportSourceTable["rows"][number], key: PortfolioImportCanonicalKey): string => {
    const idx = keyToIndex[key];
    return idx === undefined ? "" : (row.cells[idx] ?? "").trim();
  };

  for (const row of table.rows) {
    const addressRaw = get(row, "address");
    const propertyNameRaw = get(row, "propertyName");
    const cityRaw = get(row, "city");
    const stateRaw = get(row, "state");
    const zipRaw = get(row, "zip");
    const unitLabelRaw = get(row, "unitLabel");
    const bedsRaw = get(row, "beds");
    const bathsRaw = get(row, "baths");
    const sqftRaw = get(row, "sqft");
    const residentNameRaw = get(row, "residentName");
    const residentEmailRaw = get(row, "residentEmail");
    const residentPhoneRaw = get(row, "residentPhone");
    const monthlyRentRaw = get(row, "monthlyRent");
    const securityDepositRaw = get(row, "securityDeposit");
    const leaseStartRaw = get(row, "leaseStart");
    const leaseEndRaw = get(row, "leaseEnd");
    const moveInRaw = get(row, "moveIn");
    const moveOutRaw = get(row, "moveOut");
    const occupancyStatusRaw = get(row, "occupancyStatus");
    const balanceRaw = get(row, "balance");
    const notesRaw = get(row, "notes");

    let propertyGroupBasis = addressRaw || propertyNameRaw;
    if (!propertyGroupBasis) {
      if (!missingPropertyIssueAdded) {
        structuralIssues.push(
          makeIssue(
            "missing_property",
            "block",
            "This file has no property name or address column.",
            "Rows can't be grouped into properties until one is mapped.",
            { source: row.source, idSuffix: "file" },
          ),
        );
        missingPropertyIssueAdded = true;
      }
      propertyGroupBasis = "unassigned property";
    }

    const propertyKey = slugify(normalizeAddress(propertyGroupBasis));
    let property = properties.get(propertyKey);
    if (!property) {
      property = {
        key: propertyKey,
        name: propertyNameRaw || addressRaw || "Property",
        address: addressRaw,
        city: cityRaw || undefined,
        state: stateRaw || undefined,
        zip: zipRaw || undefined,
        beds: 0,
        baths: 0,
        inventoryKind: "unit",
        unitKeys: [],
        source: row.source,
      };
      properties.set(propertyKey, property);
    }

    const unitLabel = unitLabelRaw || "Unit 1";
    const unitKey = `${propertyKey}__${slugify(unitLabel)}`;
    let unit = units.get(unitKey);
    const monthlyRent = parseMoney(monthlyRentRaw);
    const securityDeposit = parseMoney(securityDepositRaw);
    const beds = bedsRaw ? parseIntSafe(bedsRaw) : undefined;
    const baths = bathsRaw ? parseFloatSafe(bathsRaw) : undefined;
    const sqft = sqftRaw ? parseIntSafe(sqftRaw) : undefined;
    if (!unit) {
      unit = {
        key: unitKey,
        propertyKey,
        label: unitLabel,
        monthlyRent,
        securityDeposit,
        beds,
        baths,
        sqft,
        occupancy: "unknown",
        residentKeys: [],
        source: row.source,
      };
      units.set(unitKey, unit);
      property.unitKeys.push(unitKey);
      property.beds += beds ?? 0;
      property.baths += baths ?? 0;
    }

    const isVacantStatus = /\b(vacant|available|empty)\b/i.test(occupancyStatusRaw);
    const names = splitResidentNames(residentNameRaw);
    if (names.length === 0 || isVacantStatus) {
      unit.occupancy = "vacant";
      continue;
    }
    unit.occupancy = "occupied";

    const { value: leaseStart, rawNote: leaseStartNote } = parseDateField(leaseStartRaw);
    const { value: leaseEnd, rawNote: leaseEndNote } = parseDateField(leaseEndRaw);
    const { value: moveIn, rawNote: moveInNote } = parseDateField(moveInRaw);

    const sharedNotes: string[] = [];
    if (notesRaw) sharedNotes.push(notesRaw);
    if (leaseStartNote) sharedNotes.push(`Lease start (unparsed): ${leaseStartNote}`);
    if (leaseEndNote) sharedNotes.push(`Lease end (unparsed): ${leaseEndNote}`);
    if (moveInNote) sharedNotes.push(`Move-in (unparsed): ${moveInNote}`);
    if (moveOutRaw) sharedNotes.push(`Move-out: ${moveOutRaw}`);

    names.forEach((name, idx) => {
      const residentKey = uniqueKey(`${unitKey}__${slugify(name)}`, usedResidentKeys);
      const { value: email, invalid: emailInvalid } = parseEmailField(idx === 0 ? residentEmailRaw : "");
      const { value: phone, invalid: phoneInvalid } = parsePhoneField(idx === 0 ? residentPhoneRaw : "");
      const balance = idx === 0 ? parseMoney(balanceRaw) : null;

      if (emailInvalid) {
        structuralIssues.push(
          makeIssue("invalid_email", "block", `${name}'s email couldn't be read.`, undefined, {
            propertyKey,
            unitKey,
            residentKey,
            source: row.source,
          }),
        );
      }
      if (phoneInvalid) {
        structuralIssues.push(
          makeIssue("invalid_phone", "review", `${name}'s phone number couldn't be read.`, undefined, {
            propertyKey,
            unitKey,
            residentKey,
            source: row.source,
          }),
        );
      }

      const notes: string[] = [...sharedNotes];
      if (emailInvalid && residentEmailRaw) notes.push(`Email (unparsed): ${residentEmailRaw}`);
      if (phoneInvalid && residentPhoneRaw) notes.push(`Phone (unparsed): ${residentPhoneRaw}`);

      const resident: PortfolioImportResident = {
        key: residentKey,
        propertyKey,
        unitKey,
        name,
        email,
        phone,
        leaseStart,
        leaseEnd,
        moveIn,
        monthlyRent,
        securityDeposit,
        balance,
        notes: notes.length > 0 ? notes.join(" | ") : undefined,
        inviteChannels: { email: !!email, text: !!phone },
        source: row.source,
      };
      residents.push(resident);
      unit!.residentKeys.push(residentKey);
    });
  }

  for (const property of properties.values()) {
    const labels = property.unitKeys.map((k) => units.get(k)!.label);
    const roomish = labels.filter((l) => /room|bed/i.test(l)).length;
    property.inventoryKind = labels.length > 0 && roomish > labels.length / 2 ? "room" : "unit";
  }

  const unmappedColumnIssues = columns
    .filter((c) => c.confidence === "unmapped")
    .map((c) =>
      makeIssue(
        "unmapped_column",
        "info",
        `Column "${c.header}" wasn't recognized and will be kept as a note.`,
        undefined,
        { idSuffix: String(c.index) },
      ),
    );
  const summaryRowIssues = table.skippedRows.map((ref) =>
    makeIssue("summary_row_skipped", "info", `Row ${ref.row} looked like a summary or blank row and was skipped.`, undefined, {
      source: ref,
    }),
  );

  const invalidEmailResidentKeys = new Set(
    structuralIssues.filter((i) => i.code === "invalid_email" && i.residentKey).map((i) => i.residentKey!),
  );
  const invalidPhoneResidentKeys = new Set(
    structuralIssues.filter((i) => i.code === "invalid_phone" && i.residentKey).map((i) => i.residentKey!),
  );
  const dyn = generateDynamicIssuesBalancesTasks(properties, units, residents, {
    today,
    existingEmails,
    sourceKind,
    invalidEmailResidentKeys,
    invalidPhoneResidentKeys,
  });

  return {
    version: 1,
    sourceKind,
    preset,
    fileName,
    rowCount: table.rows.length,
    columns,
    properties: Array.from(properties.values()),
    units: Array.from(units.values()),
    residents: dyn.residents,
    balances: dyn.balances,
    tasks: dyn.tasks,
    issues: [...structuralIssues, ...unmappedColumnIssues, ...summaryRowIssues, ...dyn.issues],
    aiMappedHeaders,
  };
}

// ---------------------------------------------------------------------------
// recomputeDraftAfterEdits
// ---------------------------------------------------------------------------

export function recomputeDraftAfterEdits(draft: PortfolioImportDraft): PortfolioImportDraft {
  const properties = new Map(draft.properties.map((p) => [p.key, p]));
  const units = new Map(draft.units.map((u) => [u.key, u]));
  const residentsByKey = new Map(draft.residents.map((r) => [r.key, r]));

  const carried = carryForwardIssues(draft.issues, residentsByKey, units, properties);
  const invalidEmailResidentKeys = new Set(
    carried.filter((i) => i.code === "invalid_email" && i.residentKey).map((i) => i.residentKey!),
  );
  const invalidPhoneResidentKeys = new Set(
    carried.filter((i) => i.code === "invalid_phone" && i.residentKey).map((i) => i.residentKey!),
  );
  const dyn = generateDynamicIssuesBalancesTasks(properties, units, draft.residents, {
    today: resolveToday(),
    existingEmails: new Set<string>(),
    sourceKind: draft.sourceKind,
    invalidEmailResidentKeys,
    invalidPhoneResidentKeys,
  });

  return {
    ...draft,
    residents: dyn.residents,
    balances: dyn.balances,
    tasks: dyn.tasks,
    issues: [...carried, ...dyn.issues],
  };
}

// ---------------------------------------------------------------------------
// summarizePortfolioImportDraft / draftHasBlockingIssues
// ---------------------------------------------------------------------------

function isIssueRowExcluded(issue: PortfolioImportIssue, draft: PortfolioImportDraft): boolean {
  if (issue.residentKey) {
    const r = draft.residents.find((x) => x.key === issue.residentKey);
    if (!r) return true;
    const u = draft.units.find((x) => x.key === r.unitKey);
    const p = draft.properties.find((x) => x.key === r.propertyKey);
    return !!r.excluded || !!u?.excluded || !!p?.excluded;
  }
  if (issue.unitKey) {
    const u = draft.units.find((x) => x.key === issue.unitKey);
    if (!u) return true;
    const p = draft.properties.find((x) => x.key === u.propertyKey);
    return !!u.excluded || !!p?.excluded;
  }
  if (issue.propertyKey) {
    const p = draft.properties.find((x) => x.key === issue.propertyKey);
    return !p || !!p.excluded;
  }
  return false;
}

export function draftHasBlockingIssues(draft: PortfolioImportDraft): boolean {
  return draft.issues.some((i) => i.severity === "block" && !i.resolved && !isIssueRowExcluded(i, draft));
}

export function summarizePortfolioImportDraft(
  draft: PortfolioImportDraft,
  meta: { importId: string; status: PortfolioImportStatus; createdAt: string; committedAt: string | null },
): PortfolioImportSummary {
  const units = new Map(draft.units.map((u) => [u.key, u]));
  const properties = new Map(draft.properties.map((p) => [p.key, p]));

  const activeProperties = draft.properties.filter((p) => !p.excluded);
  const activeUnits = draft.units.filter((u) => !isUnitExcluded(u, properties));
  const activeResidents = draft.residents.filter((r) => !isResidentExcluded(r, units, properties));

  const blockingIssueCount = draft.issues.filter(
    (i) => i.severity === "block" && !i.resolved && !isIssueRowExcluded(i, draft),
  ).length;
  const reviewIssueCount = draft.issues.filter(
    (i) => i.severity === "review" && !i.resolved && !isIssueRowExcluded(i, draft),
  ).length;

  return {
    importId: meta.importId,
    status: meta.status,
    fileName: draft.fileName,
    sourceKind: draft.sourceKind,
    preset: draft.preset,
    propertyCount: activeProperties.length,
    unitCount: activeUnits.length,
    residentCount: activeResidents.length,
    balanceCount: draft.balances.length,
    balanceTotal: draft.balances.reduce((sum, b) => sum + b.amount, 0),
    taskCount: draft.tasks.length,
    blockingIssueCount,
    reviewIssueCount,
    invitableByEmail: activeResidents.filter((r) => r.inviteChannels.email).length,
    invitableByText: activeResidents.filter((r) => r.inviteChannels.text).length,
    createdAt: meta.createdAt,
    committedAt: meta.committedAt,
  };
}
