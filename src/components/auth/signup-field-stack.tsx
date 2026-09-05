"use client";

import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";

/**
 * The one set of account-creation fields, shared by resident, vendor and
 * manager signup.
 *
 * These three forms each carried their own copy — around 1,100 lines between
 * them — and had drifted: vendor was missing Full name and Phone entirely, so
 * the same product asked different questions depending on which link you
 * arrived through. One component means they cannot drift again.
 */
export type SignupFieldValues = {
  fullName: string;
  email: string;
  phone: string;
  password: string;
};

export function SignupFieldStack({
  values,
  onChange,
  disabled = false,
  emailDisabled = false,
  onSubmit,
}: {
  values: SignupFieldValues;
  onChange: (patch: Partial<SignupFieldValues>) => void;
  disabled?: boolean;
  /** Vendor invites pin the address the invite was sent to. */
  emailDisabled?: boolean;
  onSubmit?: () => void;
}) {
  const enterSubmits = (e: { key: string }) => {
    if (e.key === "Enter") onSubmit?.();
  };

  return (
    <>
      <Input
        type="text"
        autoComplete="name"
        placeholder="Full name"
        value={values.fullName}
        onChange={(e) => onChange({ fullName: e.target.value })}
        disabled={disabled}
      />
      <Input
        type="email"
        autoComplete="email"
        // iOS/macOS autocapitalise the first letter by default, which used to
        // make Manager@… a different account from manager@… (PRP-196).
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        placeholder="Email"
        value={values.email}
        onChange={(e) => onChange({ email: e.target.value })}
        disabled={disabled || emailDisabled}
      />
      <Input
        type="tel"
        inputMode="tel"
        autoComplete="tel"
        placeholder="Phone (optional)"
        value={values.phone}
        onChange={(e) => onChange({ phone: e.target.value })}
        disabled={disabled}
      />
      <PasswordInput
        autoComplete="new-password"
        placeholder="Password (8+ characters)"
        value={values.password}
        onChange={(e) => onChange({ password: e.target.value })}
        disabled={disabled}
        onKeyDown={enterSubmits}
      />
    </>
  );
}
