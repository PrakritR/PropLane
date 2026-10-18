import "server-only";

import {
  ENTRY_CODE_PROBLEM_MESSAGE,
  entryCodeCallToAction,
  entryCodeSmsLink,
  type EntryCodeProblem,
} from "@/lib/one-number/entry-codes";
import type { EntryCodeError, EntryCodeRecord } from "@/lib/one-number/entry-codes.server";

export const ENTRY_CODE_ERROR_STATUS: Record<EntryCodeError, number> = {
  invalid_format: 400,
  needs_letter: 400,
  reserved: 400,
  taken: 409,
  too_many: 409,
  property_not_found: 404,
  not_found: 404,
  unavailable: 503,
};

export function entryCodeErrorMessage(error: EntryCodeError): string {
  if (error in ENTRY_CODE_PROBLEM_MESSAGE) return ENTRY_CODE_PROBLEM_MESSAGE[error as EntryCodeProblem];
  if (error === "taken") return "That code is taken. Pick another.";
  if (error === "too_many") return "This house already has five live codes. Turn one off first.";
  if (error === "property_not_found" || error === "not_found") return "Not found.";
  return "Codes are unavailable right now.";
}

export function presentEntryCode(record: EntryCodeRecord, sharedNumber: string | null) {
  return {
    code: record.code,
    propertyId: record.propertyId,
    active: record.active,
    callToAction: entryCodeCallToAction(record.code, sharedNumber),
    smsLink: entryCodeSmsLink(record.code, sharedNumber),
  };
}
