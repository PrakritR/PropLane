/**
 * The owner's and the vendor's statement, folded from their payable lines in the party ledger. Pure: the ledger lines (joined to
 * their journals) go in, a statement comes out. Nothing here recomputes money; it labels what was posted. Rows are signed from the
 * party's side (a credit to them is positive).
 */

export type StatementLine = {
  journalId: string;
  amountCents: number; // the ledger's signed amount: debit positive, credit negative
  availableOn: string | null;
  postedAt: string;
  kind: string;
  detail: Record<string, unknown>;
  sourceType: string | null;
  sourceId: string | null;
};

export type StatementRowKind =
  | "rent" | "fee" | "refund" | "fee_returned" | "vendor_charge" | "dispute_hold" | "dispute_release" | "withdrawal" | "withdrawal_returned"
  | "bill" | "adjustment";

export type StatementRow = {
  id: string;
  date: string;
  kind: StatementRowKind;
  label: string;
  /** From the party's side: credit positive, debit negative. */
  amountCents: number;
  availableOn?: string | null;
  href?: string | null;
  propertyId?: string | null;
};

export type Statement = {
  fromIso: string;
  toIso: string;
  beginningCents: number;
  rows: StatementRow[];
  totals: {
    rentGrossCents: number;
    feeCents: number;
    vendorChargesCents: number;
    otherCents: number;
    netCents: number;
    withdrawalsCents: number;
  };
  endingCents: number;
};

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
};
const text = (v: unknown): string => (typeof v === "string" ? v : "");

/** Fold ledger lines into an OWNER statement for `[fromIso, toIso)`. `lines` must hold every owner_payable line, oldest first. */
export function buildOwnerStatement(lines: readonly StatementLine[], fromIso: string, toIso: string): Statement {
  let beginning = 0;
  let ending = 0;
  const rows: StatementRow[] = [];
  for (const line of lines) {
    const credit = -line.amountCents;
    if (line.postedAt < toIso) ending += credit;
    if (line.postedAt < fromIso) {
      beginning += credit;
      continue;
    }
    if (line.postedAt >= toIso) continue;
    const d = line.detail;
    const date = line.postedAt;
    const id = `${line.journalId}`;
    switch (line.kind) {
      case "rent_capture": {
        const owner = num(d.owner_cents);
        const fee = num(d.fee_cents);
        rows.push({ id: `${id}:rent`, date, kind: "rent", label: "Rent collected", amountCents: owner + fee, availableOn: line.availableOn });
        if (fee > 0) rows.push({ id: `${id}:fee`, date, kind: "fee", label: "PropLane fee", amountCents: -fee });
        break;
      }
      case "refund": {
        const owner = num(d.owner_cents);
        const fee = num(d.fee_cents);
        rows.push({ id: `${id}:refund`, date, kind: "refund", label: "Refund to resident", amountCents: -(owner + fee) });
        if (fee > 0) rows.push({ id: `${id}:feeback`, date, kind: "fee_returned", label: "PropLane fee returned", amountCents: fee });
        break;
      }
      case "vendor_bill":
        rows.push({
          id: `${id}:bill`, date, kind: "vendor_charge", amountCents: credit,
          label: [text(d.title) || "Service", text(d.vendor_label)].filter(Boolean).join(" · "),
          href: text(d.job_href) || null, propertyId: text(d.property_id) || null,
        });
        break;
      case "dispute_opened":
        rows.push({ id: `${id}:hold`, date, kind: "dispute_hold", label: "Held for a payment dispute", amountCents: credit });
        break;
      case "dispute_won":
        rows.push({ id: `${id}:release`, date, kind: "dispute_release", label: "Dispute won, released", amountCents: credit });
        break;
      case "withdrawal_reserve":
        rows.push({ id: `${id}:wd`, date, kind: "withdrawal", label: "Withdrawal to your bank", amountCents: credit });
        break;
      case "withdrawal_failed":
        rows.push({ id: `${id}:wdback`, date, kind: "withdrawal_returned", label: "Withdrawal returned", amountCents: credit });
        break;
      default:
        rows.push({ id: `${id}:adj`, date, kind: "adjustment", label: text(d.reason) || "Adjustment", amountCents: credit });
    }
  }
  return finish(fromIso, toIso, beginning, ending, rows);
}

/** Fold ledger lines into a VENDOR statement (vendor_payable lines, oldest first). */
export function buildVendorStatement(lines: readonly StatementLine[], fromIso: string, toIso: string): Statement {
  let beginning = 0;
  let ending = 0;
  const rows: StatementRow[] = [];
  for (const line of lines) {
    const credit = -line.amountCents;
    if (line.postedAt < toIso) ending += credit;
    if (line.postedAt < fromIso) {
      beginning += credit;
      continue;
    }
    if (line.postedAt >= toIso) continue;
    const d = line.detail;
    const id = line.journalId;
    if (line.kind === "vendor_bill") {
      rows.push({ id: `${id}:bill`, date: line.postedAt, kind: "bill", amountCents: credit, label: text(d.title) || "Service", href: null });
    } else if (line.kind === "withdrawal_reserve") {
      rows.push({ id: `${id}:wd`, date: line.postedAt, kind: "withdrawal", amountCents: credit, label: "Withdrawal to your bank" });
    } else if (line.kind === "withdrawal_failed") {
      rows.push({ id: `${id}:wdback`, date: line.postedAt, kind: "withdrawal_returned", amountCents: credit, label: "Withdrawal returned" });
    } else {
      rows.push({ id: `${id}:adj`, date: line.postedAt, kind: "adjustment", amountCents: credit, label: text(d.reason) || "Adjustment" });
    }
  }
  return finish(fromIso, toIso, beginning, ending, rows);
}

function finish(fromIso: string, toIso: string, beginning: number, ending: number, rows: StatementRow[]): Statement {
  const sum = (kinds: StatementRowKind[]) => rows.filter((r) => kinds.includes(r.kind)).reduce((s, r) => s + r.amountCents, 0);
  const rentGross = sum(["rent", "refund"]);
  const fee = sum(["fee", "fee_returned"]);
  const vendor = sum(["vendor_charge"]);
  const bills = sum(["bill"]);
  const other = sum(["dispute_hold", "dispute_release", "adjustment"]);
  const withdrawals = sum(["withdrawal", "withdrawal_returned"]);
  return {
    fromIso, toIso, beginningCents: beginning, rows,
    totals: {
      rentGrossCents: rentGross, feeCents: fee, vendorChargesCents: vendor + bills, otherCents: other,
      netCents: rentGross + fee + vendor + bills + other, withdrawalsCents: withdrawals,
    },
    endingCents: ending,
  };
}

/** The identity every statement must satisfy: beginning + net + withdrawals == ending. */
export function statementReconciles(s: Statement): boolean {
  return s.beginningCents + s.totals.netCents + s.totals.withdrawalsCents === s.endingCents;
}
