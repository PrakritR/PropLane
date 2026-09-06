"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { Input } from "@/components/ui/input";
import {
  composePhoneE164,
  DEFAULT_PHONE_COUNTRY_ISO,
  formatNationalPhoneDigits,
  parsePhoneFieldValue,
  phoneCountryByIso,
  phoneCountrySelectOptions,
} from "@/lib/phone-number-field";

const COUNTRY_OPTIONS = phoneCountrySelectOptions();

/**
 * Country-code dropdown (US +1 by default) plus a numeric box that auto-formats
 * the national number. `onChange` always receives a string — never a number —
 * so Communication settings cannot hit `x.trim is not a function`.
 */
export function PhoneNumberField({
  id,
  value,
  onChange,
  disabled = false,
  placeholder,
  autoComplete = "tel",
  name,
  dataAttr,
  className = "",
  inputClassName = "",
}: {
  id?: string;
  value: unknown;
  onChange: (e164: string) => void;
  disabled?: boolean;
  placeholder?: string;
  autoComplete?: string;
  name?: string;
  dataAttr?: string;
  className?: string;
  inputClassName?: string;
}) {
  const parsed = useMemo(() => parsePhoneFieldValue(value), [value]);
  const [iso, setIso] = useState(parsed.iso);
  const [digits, setDigits] = useState(parsed.nationalDigits);
  const lastEmitted = useRef(composePhoneE164(parsed.iso, parsed.nationalDigits));

  useEffect(() => {
    const next = parsePhoneFieldValue(value);
    const incoming = composePhoneE164(next.iso, next.nationalDigits);
    if (incoming === lastEmitted.current) return;
    lastEmitted.current = incoming;
    setIso(next.iso);
    setDigits(next.nationalDigits);
  }, [value]);

  const country = phoneCountryByIso(iso);
  const display = formatNationalPhoneDigits(digits, iso);
  const numberPlaceholder =
    placeholder ?? (country.format === "nanp" ? "(206) 555-0123" : "Phone number");

  const emit = (nextIso: string, nextDigits: string) => {
    const clipped = nextDigits.replace(/\D/g, "").slice(0, phoneCountryByIso(nextIso).nationalLength);
    const e164 = composePhoneE164(nextIso, clipped);
    lastEmitted.current = e164;
    setIso(nextIso);
    setDigits(clipped);
    onChange(e164);
  };

  return (
    <div className={`flex min-w-0 items-stretch ${className}`.trim()} data-attr={dataAttr}>
      <FieldSingleSelect
        hideLabel
        variant="pill"
        label="Country code"
        value={COUNTRY_OPTIONS.some((option) => option.value === iso) ? iso : DEFAULT_PHONE_COUNTRY_ISO}
        options={COUNTRY_OPTIONS}
        onChange={(next) => emit(next, digits)}
        disabled={disabled}
        dataAttr={id ? `${id}-country` : "phone-country"}
        wrapperClassName="shrink-0"
        triggerClassName="min-w-[4.75rem] rounded-r-none border-r-0 px-3"
      />
      <Input
        id={id}
        name={name}
        type="tel"
        inputMode="numeric"
        autoComplete={autoComplete}
        autoCorrect="off"
        spellCheck={false}
        placeholder={numberPlaceholder}
        value={display}
        disabled={disabled}
        className={`min-w-0 flex-1 rounded-l-none ${inputClassName}`.trim()}
        data-attr={id ? `${id}-number` : "phone-number"}
        onChange={(event) => emit(iso, event.target.value)}
      />
    </div>
  );
}
