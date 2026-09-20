/**
 * Portfolio import — pure merge of the two model passes into one proposal.
 *
 * `understandPropertyImport` (src/lib/property-import/understand.server.ts)
 * already answers properties + rooms; `understandResidents`
 * (understand-residents.server.ts) answers who lives where. Neither pass
 * knows about the other's output, so this module ties a resident to the
 * property its row citations best match, then derives charges (current rent,
 * a recorded deposit, a recorded balance — only what the file states) and
 * tasks (a missing end date, every imported lease being unsigned, move-in
 * photos, a missing contact) per resident. Nothing here reads a file or
 * calls a model — pure and unit-testable in isolation.
 */

import type { PropertyImportProperty, PropertyImportUnderstanding } from "@/lib/property-import/types";
import type { UnderstoodResident } from "@/lib/portfolio-import/understand-residents.server";
import { placeholderImportEmail } from "@/lib/portfolio-import/placeholder-email";
import type {
  ImportChargeProposal,
  ImportGap,
  ImportItemStatus,
  ImportPropertyProposal,
  ImportResidentProposal,
  ImportRoomProposal,
  ImportSource,
  ImportTaskProposal,
  PortfolioImportFileKind,
  PortfolioImportProposal,
} from "@/lib/portfolio-import/types";

function slug(s: string, max = 40): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, max) || "x";
}

function normalizeLabel(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function rowsOverlap(a: number[], b: number[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const set = new Set(a);
  return b.some((n) => set.has(n));
}

function rowsDistance(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) return Number.POSITIVE_INFINITY;
  const aMid = a.reduce((s, n) => s + n, 0) / a.length;
  const bMid = b.reduce((s, n) => s + n, 0) / b.length;
  return Math.abs(aMid - bMid);
}

/** Which property a resident's own row citations best match. Never drops a resident silently. */
function matchProperty(resident: UnderstoodResident, properties: PropertyImportProperty[]): PropertyImportProperty | null {
  if (properties.length === 0) return null;
  if (properties.length === 1) return properties[0]!;

  const sameSheet = properties.filter((p) => p.sourceSheet === resident.sourceSheet);
  const overlapping = sameSheet.filter((p) => rowsOverlap(p.sourceRows, resident.sourceRows));
  if (overlapping.length === 1) return overlapping[0]!;

  if (resident.roomLabel) {
    const normResident = normalizeLabel(resident.roomLabel);
    const byRoomLabel = (sameSheet.length ? sameSheet : properties).filter((p) =>
      p.rooms.some((r) => normalizeLabel(r.label) === normResident),
    );
    if (byRoomLabel.length === 1) return byRoomLabel[0]!;
  }

  if (overlapping.length > 1) {
    // Several properties on the same sheet share a row — take the closest.
    return overlapping.reduce((best, p) => (rowsDistance(p.sourceRows, resident.sourceRows) < rowsDistance(best.sourceRows, resident.sourceRows) ? p : best));
  }

  const pool = sameSheet.length ? sameSheet : properties;
  return pool.reduce((best, p) => (rowsDistance(p.sourceRows, resident.sourceRows) < rowsDistance(best.sourceRows, resident.sourceRows) ? p : best));
}

function matchRoom(resident: UnderstoodResident, rooms: ImportRoomProposal[]): ImportRoomProposal | null {
  if (!resident.roomLabel) return rooms.length === 1 ? rooms[0]! : null;
  const norm = normalizeLabel(resident.roomLabel);
  return rooms.find((r) => normalizeLabel(r.name) === norm) ?? (rooms.length === 1 ? rooms[0]! : null);
}

export function residentGaps(resident: Pick<ImportResidentProposal, "name" | "leaseEnd" | "email" | "phone" | "rent" | "roomKey">, hasMultipleRooms: boolean): ImportGap[] {
  const gaps: ImportGap[] = [];
  const who = resident.name || "this resident";
  if (!resident.leaseEnd) gaps.push({ field: "leaseEnd", question: `When does ${who}'s lease end?` });
  if (!resident.email && !resident.phone) gaps.push({ field: "contact", question: `What's the best email or phone for ${who}?` });
  if (resident.rent == null) gaps.push({ field: "rent", question: `What does ${who} pay in rent?` });
  if (!resident.roomKey && hasMultipleRooms) gaps.push({ field: "room", question: `Which room does ${who} live in?` });
  return gaps;
}

function residentTasks(residentKey: string, resident: Pick<ImportResidentProposal, "leaseEnd" | "email" | "phone">, source: ImportSource): ImportTaskProposal[] {
  const tasks: ImportTaskProposal[] = [];
  if (!resident.leaseEnd) {
    tasks.push({ key: `${residentKey}:task:missing_end_date`, residentKey, title: "Confirm when this lease ends", kind: "missing_end_date", source });
  }
  // Every imported lease becomes an uploaded lease record with no signature
  // (create.server.ts attests tenancy — a signature is never fabricated), so
  // every resident gets this follow-up.
  tasks.push({ key: `${residentKey}:task:unsigned_lease`, residentKey, title: "Generate or upload this resident's lease for signature", kind: "unsigned_lease", source });
  tasks.push({ key: `${residentKey}:task:move_in_photos`, residentKey, title: "Add move-in photos", kind: "move_in_photos", source });
  if (!resident.email && !resident.phone) {
    tasks.push({ key: `${residentKey}:task:missing_contact`, residentKey, title: "Add a way to reach this resident", kind: "missing_contact", source });
  }
  return tasks;
}

function residentCharges(residentKey: string, resident: Pick<ImportResidentProposal, "name" | "rent" | "deposit" | "balance">, source: ImportSource): ImportChargeProposal[] {
  const charges: ImportChargeProposal[] = [];
  if (resident.rent != null && resident.rent > 0) {
    charges.push({ key: `${residentKey}:charge:rent`, residentKey, kind: "rent", amount: resident.rent, dueDate: null, label: "Rent", source });
  }
  if (resident.deposit != null && resident.deposit > 0) {
    charges.push({ key: `${residentKey}:charge:deposit`, residentKey, kind: "deposit", amount: resident.deposit, dueDate: null, label: "Security deposit", source });
  }
  if (resident.balance != null && resident.balance > 0) {
    charges.push({ key: `${residentKey}:charge:balance`, residentKey, kind: "balance", amount: resident.balance, dueDate: null, label: "Past-due balance", source });
  }
  return charges;
}

function fileKindFor(u: PropertyImportUnderstanding): PortfolioImportFileKind {
  if (u.sourceKind === "pdf") return "rent_roll_pdf";
  return "spreadsheet";
}

export function proposePortfolioImport(input: {
  importId: string;
  files: { name: string; kind: PortfolioImportFileKind }[];
  understandings: PropertyImportUnderstanding[];
  residentsByFile: UnderstoodResident[][];
}): PortfolioImportProposal {
  const properties: ImportPropertyProposal[] = [];

  input.understandings.forEach((understanding, fileIndex) => {
    const fileName = understanding.fileName;
    const residents = input.residentsByFile[fileIndex] ?? [];
    const unmatched: UnderstoodResident[] = [];

    for (const property of understanding.properties) {
      const propertyKey = property.key;
      const source: ImportSource = { file: fileName, sheet: property.sourceSheet, rows: property.sourceRows };

      const rooms: ImportRoomProposal[] = property.rooms.map((room, i) => ({
        key: `${propertyKey}:room:${i}:${slug(room.label, 24)}`,
        name: room.name ?? room.label,
        rent: room.rent,
        source: { file: fileName, sheet: property.sourceSheet, rows: room.sourceRow != null ? [room.sourceRow] : property.sourceRows },
      }));

      const propertyResidents = residents.filter((r) => matchProperty(r, understanding.properties) === property);
      const hasMultipleRooms = rooms.length > 1;

      const residentProposals: ImportResidentProposal[] = propertyResidents.map((r, i) => {
        const room = matchRoom(r, rooms);
        const residentKey = `${propertyKey}:resident:${i}:${slug(r.name, 24)}`;
        const email = r.email || (r.name ? placeholderImportEmail(slug(r.name, 24), residentKey.slice(-8)) : null);
        const base = { name: r.name, leaseEnd: r.leaseEnd, email, phone: r.phone, rent: r.rent, roomKey: room?.key ?? null };
        const gaps = residentGaps(base, hasMultipleRooms);
        const status: ImportItemStatus = gaps.length > 0 ? "needs" : "ready";
        return {
          key: residentKey,
          roomKey: room?.key ?? null,
          name: r.name,
          email,
          phone: r.phone,
          leaseStart: r.leaseStart,
          leaseEnd: r.leaseEnd,
          rent: r.rent,
          deposit: r.deposit,
          balance: r.balance,
          status,
          gaps,
          source: { file: fileName, sheet: r.sourceSheet, rows: r.sourceRows, page: r.sourcePage ?? undefined },
        };
      });

      const charges = residentProposals.flatMap((r) => residentCharges(r.key, r, r.source));
      const tasks = residentProposals.flatMap((r) => residentTasks(r.key, r, r.source));
      const status: ImportItemStatus = residentProposals.length === 0 && rooms.length === 0 ? "skip" : residentProposals.some((r) => r.status === "needs") ? "needs" : "ready";

      properties.push({ key: propertyKey, address: property.address || property.name, source, rooms, residents: residentProposals, charges, tasks, status });
    }

    for (const r of residents) {
      if (matchProperty(r, understanding.properties) == null) unmatched.push(r);
    }
    // A resident whose row citations matched no property in this file is
    // recorded nowhere real to create it under — this only happens when the
    // model reported a resident for a file with zero recognized properties,
    // which `understand.server.ts` already treats as "no properties found."
    // Nothing is fabricated to hold them; they are simply absent from the
    // proposal, same as a property understanding with zero properties is.
    void unmatched;
  });

  return { importId: input.importId, files: input.files, properties, summary: summaryOf(properties) };
}

export function summaryOf(properties: ImportPropertyProposal[]): PortfolioImportProposal["summary"] {
  let rooms = 0;
  let residents = 0;
  let charges = 0;
  let tasks = 0;
  let gaps = 0;
  for (const property of properties) {
    rooms += property.rooms.length;
    residents += property.residents.length;
    charges += property.charges.length;
    tasks += property.tasks.length;
    gaps += property.residents.reduce((n, r) => n + r.gaps.length, 0);
  }
  return { properties: properties.length, rooms, residents, charges, tasks, gaps };
}

export { fileKindFor };
