import { coercePhoneInput, normalizeE164 } from "@/lib/phone-e164";
import { maskPhoneInput } from "@/lib/rental-application/masks";

export type PhoneCountry = {
  iso: string;
  name: string;
  /** Dial prefix without `+`. */
  dial: string;
  nationalLength: number;
  format: "nanp" | "grouped";
};

export const DEFAULT_PHONE_COUNTRY_ISO = "US";

/** Common destinations; United States is first so +1 is the default extension. */
export const PHONE_COUNTRIES: readonly PhoneCountry[] = [
  { iso: "US", name: "United States", dial: "1", nationalLength: 10, format: "nanp" },
  { iso: "CA", name: "Canada", dial: "1", nationalLength: 10, format: "nanp" },
  { iso: "GB", name: "United Kingdom", dial: "44", nationalLength: 10, format: "grouped" },
  { iso: "AU", name: "Australia", dial: "61", nationalLength: 9, format: "grouped" },
  { iso: "NZ", name: "New Zealand", dial: "64", nationalLength: 9, format: "grouped" },
  { iso: "IE", name: "Ireland", dial: "353", nationalLength: 9, format: "grouped" },
  { iso: "IN", name: "India", dial: "91", nationalLength: 10, format: "grouped" },
  { iso: "MX", name: "Mexico", dial: "52", nationalLength: 10, format: "grouped" },
  { iso: "BR", name: "Brazil", dial: "55", nationalLength: 11, format: "grouped" },
  { iso: "DE", name: "Germany", dial: "49", nationalLength: 11, format: "grouped" },
  { iso: "FR", name: "France", dial: "33", nationalLength: 9, format: "grouped" },
  { iso: "ES", name: "Spain", dial: "34", nationalLength: 9, format: "grouped" },
  { iso: "IT", name: "Italy", dial: "39", nationalLength: 10, format: "grouped" },
  { iso: "NL", name: "Netherlands", dial: "31", nationalLength: 9, format: "grouped" },
  { iso: "SE", name: "Sweden", dial: "46", nationalLength: 9, format: "grouped" },
  { iso: "NO", name: "Norway", dial: "47", nationalLength: 8, format: "grouped" },
  { iso: "DK", name: "Denmark", dial: "45", nationalLength: 8, format: "grouped" },
  { iso: "FI", name: "Finland", dial: "358", nationalLength: 10, format: "grouped" },
  { iso: "CH", name: "Switzerland", dial: "41", nationalLength: 9, format: "grouped" },
  { iso: "AT", name: "Austria", dial: "43", nationalLength: 10, format: "grouped" },
  { iso: "BE", name: "Belgium", dial: "32", nationalLength: 9, format: "grouped" },
  { iso: "PT", name: "Portugal", dial: "351", nationalLength: 9, format: "grouped" },
  { iso: "PL", name: "Poland", dial: "48", nationalLength: 9, format: "grouped" },
  { iso: "JP", name: "Japan", dial: "81", nationalLength: 10, format: "grouped" },
  { iso: "KR", name: "South Korea", dial: "82", nationalLength: 10, format: "grouped" },
  { iso: "CN", name: "China", dial: "86", nationalLength: 11, format: "grouped" },
  { iso: "PH", name: "Philippines", dial: "63", nationalLength: 10, format: "grouped" },
  { iso: "SG", name: "Singapore", dial: "65", nationalLength: 8, format: "grouped" },
  { iso: "HK", name: "Hong Kong", dial: "852", nationalLength: 8, format: "grouped" },
  { iso: "AE", name: "United Arab Emirates", dial: "971", nationalLength: 9, format: "grouped" },
  { iso: "IL", name: "Israel", dial: "972", nationalLength: 9, format: "grouped" },
  { iso: "ZA", name: "South Africa", dial: "27", nationalLength: 9, format: "grouped" },
  { iso: "NG", name: "Nigeria", dial: "234", nationalLength: 10, format: "grouped" },
  { iso: "KE", name: "Kenya", dial: "254", nationalLength: 9, format: "grouped" },
  { iso: "CO", name: "Colombia", dial: "57", nationalLength: 10, format: "grouped" },
  { iso: "AR", name: "Argentina", dial: "54", nationalLength: 10, format: "grouped" },
  { iso: "CL", name: "Chile", dial: "56", nationalLength: 9, format: "grouped" },
];

const COUNTRY_BY_ISO = new Map(PHONE_COUNTRIES.map((country) => [country.iso, country]));

export function phoneCountryByIso(iso: string): PhoneCountry {
  return COUNTRY_BY_ISO.get(iso) ?? PHONE_COUNTRIES[0]!;
}

export function phoneCountrySelectOptions(): {
  value: string;
  label: string;
  triggerLabel: string;
}[] {
  return PHONE_COUNTRIES.map((country) => ({
    value: country.iso,
    label: `${country.name} +${country.dial}`,
    triggerLabel: `+${country.dial}`,
  }));
}

export function formatNationalPhoneDigits(digits: string, iso: string): string {
  const country = phoneCountryByIso(iso);
  const clipped = digits.replace(/\D/g, "").slice(0, country.nationalLength);
  if (country.format === "nanp") return maskPhoneInput("", clipped);
  return clipped.replace(/(\d{3,4})(?=\d)/g, "$1 ").trim();
}

export function composePhoneE164(iso: string, nationalDigits: string): string {
  const digits = nationalDigits.replace(/\D/g, "");
  if (!digits) return "";
  return `+${phoneCountryByIso(iso).dial}${digits}`;
}

export type ParsedPhoneField = {
  iso: string;
  nationalDigits: string;
};

/**
 * Read a stored phone (string, number, or empty) into country + national digits.
 * Bare 10-digit and +1 NANP values default to the United States.
 */
export function parsePhoneFieldValue(value: unknown): ParsedPhoneField {
  const raw = coercePhoneInput(value);
  if (!raw) return { iso: DEFAULT_PHONE_COUNTRY_ISO, nationalDigits: "" };

  const e164 = normalizeE164(raw);
  const digits = (e164 ?? raw).replace(/\D/g, "");
  if (!digits) return { iso: DEFAULT_PHONE_COUNTRY_ISO, nationalDigits: "" };

  if (digits.length === 10) {
    return { iso: DEFAULT_PHONE_COUNTRY_ISO, nationalDigits: digits };
  }
  if (digits.length === 11 && digits.startsWith("1")) {
    return { iso: DEFAULT_PHONE_COUNTRY_ISO, nationalDigits: digits.slice(1) };
  }

  const matches = PHONE_COUNTRIES.filter(
    (country) => digits.startsWith(country.dial) && digits.length > country.dial.length,
  ).sort((a, b) => {
    if (b.dial.length !== a.dial.length) return b.dial.length - a.dial.length;
    if (a.iso === DEFAULT_PHONE_COUNTRY_ISO) return -1;
    if (b.iso === DEFAULT_PHONE_COUNTRY_ISO) return 1;
    return 0;
  });
  const match = matches[0];
  if (match) {
    return {
      iso: match.iso,
      nationalDigits: digits.slice(match.dial.length).slice(0, match.nationalLength),
    };
  }

  return { iso: DEFAULT_PHONE_COUNTRY_ISO, nationalDigits: digits.slice(0, 10) };
}
