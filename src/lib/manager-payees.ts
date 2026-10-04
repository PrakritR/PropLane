/**
 * Payees: who a manager pays outside the vendor-invoice flow (a mortgage lender, a utility, an
 * insurer, a tax office, an HOA, an owner, a teammate). Pure vocabulary + validation shared by the
 * route (`/api/manager/payees`), the "Add payment" modal and the outgoing list. Server I/O lives in
 * `manager-payees.server.ts`.
 *
 * A payee NEVER carries a bank account or routing number. `accountReference` is the lender or
 * utility account / loan number exactly as printed on the bill; lists show only its last four.
 */

export const PAYEE_KINDS = ["vendor", "teammate", "other"] as const;
export type PayeeKind = (typeof PAYEE_KINDS)[number];

export const PAYEE_TYPES = ["mortgage", "utility", "insurance", "tax", "hoa", "owner", "management", "other"] as const;
export type PayeeType = (typeof PAYEE_TYPES)[number];

export const PAY_METHODS = ["bank_transfer", "check", "card", "online", "autopay", "cash"] as const;
export type PayMethod = (typeof PAY_METHODS)[number];

/** Types a manager can pick for "Someone else" (management is the teammate type, not a pick). */
export const PICKABLE_PAYEE_TYPES: readonly PayeeType[] = ["mortgage", "utility", "insurance", "tax", "hoa", "owner", "other"];

export const PAYEE_TYPE_LABEL: Record<PayeeType, string> = {
  mortgage: "Mortgage lender",
  utility: "Utility",
  insurance: "Insurance",
  tax: "Tax office",
  hoa: "HOA",
  owner: "Owner",
  management: "Management",
  other: "Other",
};

/** Short label for a list row ("Mortgage · 1200 Cascade Ave"). */
export const PAYEE_TYPE_SHORT_LABEL: Record<PayeeType, string> = {
  mortgage: "Mortgage",
  utility: "Utility",
  insurance: "Insurance",
  tax: "Tax",
  hoa: "HOA",
  owner: "Owner",
  management: "Management",
  other: "Other",
};

export const PAY_METHOD_LABEL: Record<PayMethod, string> = {
  bank_transfer: "Bank transfer",
  check: "Check",
  card: "Card",
  online: "Online portal",
  autopay: "Autopay",
  cash: "Cash",
};

export const TEAMMATE_PAYMENT_REASONS = ["Reimbursement", "Management fee", "Other"] as const;

/** The reference prefix a list shows: a mortgage account is a loan, anything else an account. */
export function payeeReferenceNoun(type: PayeeType | null | undefined): string {
  return type === "mortgage" ? "Loan" : "Account";
}

/** Chart-of-accounts code a payment to this kind of payee books to (the manager can change it). */
export function payeeCategoryCode(kind: PayeeKind, type: PayeeType | null | undefined): string {
  if (kind === "teammate") return "management";
  switch (type) {
    case "mortgage":
      return "mortgage";
    case "utility":
      return "utilities";
    case "insurance":
      return "insurance";
    case "tax":
      return "property_tax";
    case "management":
      return "management";
    default:
      // HOA has no chart account of its own; an owner payment and "other" are plain other expense.
      return "other_expense";
  }
}

/** "••4821" — only the last four characters of an account or loan reference. Empty when none. */
export function maskAccountReference(reference: string | null | undefined): string {
  const compact = String(reference ?? "").replace(/\s+/g, "");
  if (!compact) return "";
  return `••${compact.slice(-4)}`;
}

export type ManagerPayee = {
  id: string;
  kind: PayeeKind;
  payeeType: PayeeType | null;
  name: string;
  accountReference: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  payMethod: PayMethod | null;
  notes: string | null;
  vendorDirectoryId: string | null;
  teammateUserId: string | null;
  archivedAt: string | null;
};

export type ManagerTeammate = { userId: string; name: string; email: string | null; roleLabel: string | null };

export function payeeFromRow(row: Record<string, unknown>): ManagerPayee {
  const text = (value: unknown) => (typeof value === "string" && value.trim() ? value : null);
  return {
    id: String(row.id),
    kind: row.kind as PayeeKind,
    payeeType: (text(row.payee_type) as PayeeType | null) ?? null,
    name: String(row.name ?? ""),
    accountReference: text(row.account_reference),
    email: text(row.email),
    phone: text(row.phone),
    address: text(row.address),
    payMethod: (text(row.pay_method) as PayMethod | null) ?? null,
    notes: text(row.notes),
    vendorDirectoryId: text(row.vendor_directory_id),
    teammateUserId: text(row.teammate_user_id),
    archivedAt: text(row.archived_at),
  };
}

export const PAYEE_FIELD_LIMITS = {
  name: 120,
  accountReference: 64,
  email: 254,
  phone: 40,
  address: 300,
  notes: 1000,
} as const;

export type PayeeInput = {
  kind?: unknown;
  payeeType?: unknown;
  name?: unknown;
  accountReference?: unknown;
  email?: unknown;
  phone?: unknown;
  address?: unknown;
  payMethod?: unknown;
  notes?: unknown;
  vendorDirectoryId?: unknown;
  teammateUserId?: unknown;
};

/** A validated, trimmed payee write. Every key is present only when the caller supplied it. */
export type PayeeWrite = {
  kind?: PayeeKind;
  payee_type?: PayeeType | null;
  name?: string;
  account_reference?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  pay_method?: PayMethod | null;
  notes?: string | null;
  vendor_directory_id?: string | null;
  teammate_user_id?: string | null;
};

export type PayeeValidation = { ok: true; value: PayeeWrite } | { ok: false; error: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function oneOf<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (list as readonly string[]).includes(value);
}

/**
 * Validate a create (`partial: false`) or an update (`partial: true`). Enums are closed, text is
 * trimmed and length-capped, and an empty optional string clears the column. Anything that is not
 * a string is refused rather than coerced.
 */
export function validatePayeeInput(input: PayeeInput, options: { partial: boolean }): PayeeValidation {
  const out: PayeeWrite = {};
  const { partial } = options;

  if (input.kind !== undefined || !partial) {
    if (!oneOf(PAYEE_KINDS, input.kind)) return { ok: false, error: "Invalid payee kind." };
    out.kind = input.kind;
  }

  if (input.payeeType !== undefined) {
    if (input.payeeType === null || input.payeeType === "") out.payee_type = null;
    else if (oneOf(PAYEE_TYPES, input.payeeType)) out.payee_type = input.payeeType;
    else return { ok: false, error: "Invalid payee type." };
  }

  if (input.payMethod !== undefined) {
    if (input.payMethod === null || input.payMethod === "") out.pay_method = null;
    else if (oneOf(PAY_METHODS, input.payMethod)) out.pay_method = input.payMethod;
    else return { ok: false, error: "Invalid pay method." };
  }

  const textFields: Array<[keyof PayeeInput, keyof PayeeWrite, number, string]> = [
    ["accountReference", "account_reference", PAYEE_FIELD_LIMITS.accountReference, "Account reference"],
    ["email", "email", PAYEE_FIELD_LIMITS.email, "Email"],
    ["phone", "phone", PAYEE_FIELD_LIMITS.phone, "Phone"],
    ["address", "address", PAYEE_FIELD_LIMITS.address, "Address"],
    ["notes", "notes", PAYEE_FIELD_LIMITS.notes, "Notes"],
  ];
  for (const [key, column, max, label] of textFields) {
    const raw = input[key];
    if (raw === undefined) continue;
    if (raw === null) {
      (out as Record<string, unknown>)[column] = null;
      continue;
    }
    if (typeof raw !== "string") return { ok: false, error: `${label} must be text.` };
    const trimmed = raw.trim();
    if (trimmed.length > max) return { ok: false, error: `${label} is too long.` };
    (out as Record<string, unknown>)[column] = trimmed || null;
  }
  if (out.email && !EMAIL_RE.test(out.email)) return { ok: false, error: "Enter a valid email." };

  if (input.name !== undefined || !partial) {
    if (typeof input.name !== "string") return { ok: false, error: "Name required." };
    const name = input.name.trim();
    if (!name) return { ok: false, error: "Name required." };
    if (name.length > PAYEE_FIELD_LIMITS.name) return { ok: false, error: "Name is too long." };
    out.name = name;
  }

  for (const [key, column] of [
    ["teammateUserId", "teammate_user_id"],
    ["vendorDirectoryId", "vendor_directory_id"],
  ] as const) {
    const raw = input[key];
    if (raw === undefined) continue;
    if (raw === null || raw === "") {
      out[column] = null;
      continue;
    }
    if (typeof raw !== "string" || raw.length > 200) return { ok: false, error: "Invalid reference." };
    if (column === "teammate_user_id" && !UUID_RE.test(raw)) return { ok: false, error: "Invalid teammate." };
    out[column] = raw;
  }

  if (!partial) {
    if (out.kind === "other" && !out.payee_type) return { ok: false, error: "Choose a payee type." };
    if (out.kind === "teammate" && !out.teammate_user_id) return { ok: false, error: "Choose a teammate." };
    if (out.kind === "vendor" && !out.vendor_directory_id) return { ok: false, error: "Choose a vendor." };
  }
  return { ok: true, value: out };
}
