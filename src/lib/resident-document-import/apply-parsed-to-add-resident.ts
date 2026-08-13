import type { ParsedResidentDocument } from "@/lib/resident-document-import/types";

/** Normalize parsed dates for `<input type="date">`. */
export function normalizeParsedDateForInput(raw: string | undefined | null): string {
  const value = (raw ?? "").trim();
  if (!value) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toISOString().slice(0, 10);
}

function stripMoney(raw: string | undefined | null): string {
  const value = (raw ?? "").trim();
  if (!value) return "";
  const n = Number.parseFloat(value.replace(/[^0-9.]+/g, ""));
  return Number.isFinite(n) ? String(n) : value.replace(/^\$/, "");
}

export type AddResidentParsedApplyInput = {
  fields: Record<string, string>;
  parse?: ParsedResidentDocument | null;
  leaseTermPresetValues?: string[];
};

export type AddResidentParsedApplyResult = {
  name?: string;
  email?: string;
  phone?: string;
  propertyId?: string;
  roomId?: string;
  leaseTerm?: string;
  leaseTermCustomMode?: boolean;
  moveInDate?: string;
  moveOutDate?: string;
  rent?: string;
  utilities?: string;
  moveInFee?: string;
  securityDeposit?: string;
};

/** Map merged PDF parse fields onto the manager Add resident form shape. */
export function mapParsedFieldsToAddResidentForm(
  input: AddResidentParsedApplyInput,
): AddResidentParsedApplyResult {
  const { fields, parse, leaseTermPresetValues = [] } = input;
  const out: AddResidentParsedApplyResult = {};

  if (fields.tenantName?.trim()) out.name = fields.tenantName.trim();
  if (fields.tenantEmail?.trim()) out.email = fields.tenantEmail.trim();
  if (fields.tenantPhone?.trim()) out.phone = fields.tenantPhone.trim();

  const propertyId = parse?.propertyMatch?.propertyId?.trim() || fields.propertyId?.trim();
  if (propertyId) out.propertyId = propertyId;
  const roomId = parse?.propertyMatch?.roomId?.trim() || fields.roomId?.trim();
  if (roomId) out.roomId = roomId;

  const leaseTerm = fields.leaseTerm?.trim();
  if (leaseTerm) {
    if (leaseTermPresetValues.includes(leaseTerm)) {
      out.leaseTerm = leaseTerm;
      out.leaseTermCustomMode = false;
    } else {
      out.leaseTerm = leaseTerm;
      out.leaseTermCustomMode = true;
    }
  }

  const moveIn = normalizeParsedDateForInput(fields.leaseStart);
  if (moveIn) out.moveInDate = moveIn;
  const moveOut = normalizeParsedDateForInput(fields.leaseEnd);
  if (moveOut) out.moveOutDate = moveOut;

  const rent = stripMoney(fields.monthlyRent);
  if (rent) out.rent = rent;
  const utilities = stripMoney(fields.monthlyUtilities);
  if (utilities) out.utilities = utilities;
  const moveInFee = stripMoney(fields.moveInFee);
  if (moveInFee) out.moveInFee = moveInFee;
  const deposit = stripMoney(fields.securityDeposit);
  if (deposit) out.securityDeposit = deposit;

  return out;
}
