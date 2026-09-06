import { migrationDate } from "@/lib/sales-migration/model";
import { readDateCell } from "@/lib/sales-workbook-roster";

/** Bounded RFC4180 reader. Formulas remain inert text; malformed quoting is rejected. */
export function parseStatementCsv(text: string): { lineDate: string; description: string; amountCents: number }[] {
  if (text.length > 2_000_000) throw new Error("CSV must be under 2 MB");
  const rows: string[][] = []; let row: string[] = [], cell = "", quoted = false, closed = false;
  const pushCell = () => { row.push(cell); cell = ""; closed = false; };
  const pushRow = () => { pushCell(); if (row.some(c => c.trim())) rows.push(row); row = []; if (rows.length > 1001) throw new Error("Import at most 1,000 statement lines at once"); };
  const raw = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (quoted) { if (c === '"') { if (raw[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; closed = true; } } else cell += c; continue; }
    if (c === ',') pushCell();
    else if (c === '\n' || c === '\r') { if (c === '\r' && raw[i + 1] === '\n') i++; pushRow(); }
    else if (c === '"' && !cell && !closed) quoted = true;
    else { if (closed || c === '"') throw new Error("Invalid CSV quoting"); cell += c; }
  }
  if (quoted) throw new Error("Unclosed CSV field");
  if (cell || row.length || closed) pushRow();
  const headers = rows.shift()?.map(h => h.trim().toLowerCase()) ?? [];
  if (new Set(headers).size !== headers.length) throw new Error("Duplicate CSV columns");
  const dateCol = headers.indexOf("date"), descriptionCol = headers.indexOf("description"), amountCol = headers.indexOf("amount");
  const debitCol = headers.indexOf("debit"), creditCol = headers.indexOf("credit");
  if (dateCol < 0 || descriptionCol < 0 || (amountCol < 0 && (debitCol < 0 || creditCol < 0)) || (amountCol >= 0 && (debitCol >= 0 || creditCol >= 0))) throw new Error("Use Date, Description, Amount columns, or Date, Description, Debit, Credit");
  function money(value: string) {
    const s = value.trim().replace(/[$,]/g, "").replace(/^\((.*)\)$/, "-$1");
    if (!/^-?\d+(\.\d{1,2})?$/.test(s)) throw new Error("Amounts must be numbers with at most two decimal places");
    const amount = Math.round(Number(s) * 100);
    if (!Number.isSafeInteger(amount) || Math.abs(amount) > 1_000_000_000) throw new Error("Amount out of range");
    return amount;
  }
  if (!rows.length) throw new Error("CSV contains no statement lines");
  return rows.map((r, i) => {
    if (r.length !== headers.length) throw new Error(`CSV row ${i + 2} has a different number of columns`);
    const rawDate = r[dateCol]!.trim();
    const lineDate = migrationDate.parse(/^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : readDateCell(rawDate).iso);
    const description = r[descriptionCol]!.trim();
    if (!description || description.length > 1000) throw new Error(`Check description on row ${i + 2}`);
    let amountCents: number;
    if (amountCol >= 0) amountCents = money(r[amountCol]!);
    else {
      const debit = r[debitCol]!.trim() ? money(r[debitCol]!) : 0, credit = r[creditCol]!.trim() ? money(r[creditCol]!) : 0;
      if (debit < 0 || credit < 0 || (debit > 0 && credit > 0)) throw new Error(`Use one positive debit or credit on row ${i + 2}`);
      amountCents = credit - debit;
    }
    return { lineDate, description, amountCents };
  });
}

export function statementMatchSuggestions(line: { lineDate: string; amountCents: number }, candidates: { id: string; kind: "income" | "expense"; date: string; amountCents: number }[]) {
  const time = Date.parse(migrationDate.parse(line.lineDate));
  return candidates.filter(c => c.amountCents === Math.abs(line.amountCents) && (line.amountCents >= 0 ? c.kind === "income" : c.kind === "expense") && Math.abs(Date.parse(c.date) - time) <= 3 * 86_400_000)
    .map(c => ({ id: c.id, kind: c.kind, date: c.date, amountCents: c.amountCents }));
}


/** Review all lines together: one candidate cannot settle two bank movements. */
export function statementMatchReview(
  lines: { id: string; lineDate: string; amountCents: number }[],
  candidates: Parameters<typeof statementMatchSuggestions>[1],
) {
  const reviews = lines.map(line => ({
    lineId: line.id,
    date: line.lineDate,
    amountCents: line.amountCents,
    candidates: statementMatchSuggestions(line, candidates),
  }));
  const candidateLines = new Map<string, Set<string>>();
  for (const review of reviews) {
    for (const candidate of review.candidates) {
      const key = `${candidate.kind}:${candidate.id}`;
      const ids = candidateLines.get(key) ?? new Set<string>();
      ids.add(review.lineId);
      candidateLines.set(key, ids);
    }
  }
  return reviews.map(review => {
    const competingLineIds = new Set<string>();
    for (const candidate of review.candidates) {
      for (const id of candidateLines.get(`${candidate.kind}:${candidate.id}`) ?? []) {
        if (id !== review.lineId) competingLineIds.add(id);
      }
    }
    return { ...review, ambiguous: review.candidates.length > 1 || competingLineIds.size > 0,
      competingLineIds: [...competingLineIds].sort() };
  });
}
