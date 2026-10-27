"use client";

import { forwardRef, useState } from "react";
import { codeDigitsFrom } from "@/lib/auth/phone-code-input";

const LENGTH = 6;

/**
 * Six code boxes backed by ONE real input. The input sits over the boxes (transparent) so the OS keyboard suggestion,
 * SMS autofill (`autocomplete="one-time-code"`), paste and the caret all behave like a plain field; the boxes only draw it.
 */
export const PhoneCodeInput = forwardRef<HTMLInputElement, {
  id: string;
  value: string;
  onChange: (digits: string) => void;
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
}>(function PhoneCodeInput({ id, value, onChange, disabled, invalid, describedBy }, ref) {
  const [focused, setFocused] = useState(false);
  const active = Math.min(value.length, LENGTH - 1);
  return (
    <div className="relative" data-testid="phone-code-boxes">
      <div className="flex gap-2" aria-hidden="true">
        {Array.from({ length: LENGTH }, (_, index) => (
          <span
            key={index}
            className={`flex h-12 min-w-0 flex-1 items-center justify-center rounded-2xl border bg-auth-input-bg text-xl font-semibold text-foreground transition-[border-color,box-shadow] duration-150 ${
              invalid ? "border-danger" : focused && index === active ? "border-primary/60 ring-4 ring-primary/10" : "border-border"
            } ${disabled ? "opacity-50" : ""}`}
          >
            {value[index] ?? ""}
          </span>
        ))}
      </div>
      <input
        ref={ref}
        id={id}
        name="code"
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        aria-label="Verification code"
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(codeDigitsFrom(event.target.value, LENGTH))}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        className="absolute inset-0 h-full w-full cursor-text bg-transparent text-transparent opacity-0 caret-transparent outline-none"
      />
    </div>
  );
});
