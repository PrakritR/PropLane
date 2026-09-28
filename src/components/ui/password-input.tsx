"use client";

import { useId, useState, type InputHTMLAttributes } from "react";
import { Input } from "@/components/ui/input";
import { PasswordStrengthMeter } from "@/components/ui/motion/password-strength-meter";

export type PasswordInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & {
  /**
   * M011 — shows the segment-by-segment strength meter under the field.
   * Opt-in and scoped to sign-up / reset (create account, resident/vendor/
   * manager signup, reset-password) — never a plain sign-in or a "confirm
   * password" field next to the one already showing it.
   */
  showStrength?: boolean;
};

function EyeIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden>
      <path
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"
      />
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

function EyeOffIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden>
      <path
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"
      />
      <path stroke="currentColor" strokeWidth="2" strokeLinecap="round" d="M1 1l22 22" />
    </svg>
  );
}

/** Password field with optional show/hide toggle (eye), and an opt-in M011 strength meter. */
export function PasswordInput({ className = "", id, showStrength = false, ...props }: PasswordInputProps) {
  const [visible, setVisible] = useState(false);
  const meterId = useId();
  const value = typeof props.value === "string" ? props.value : "";

  return (
    <div>
      <div className="relative">
        <Input
          id={id}
          type={visible ? "text" : "password"}
          className={`${className} pr-12`}
          {...props}
          aria-describedby={showStrength ? meterId : props["aria-describedby"]}
        />
        <button
          type="button"
          className="absolute right-2.5 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full text-muted transition hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? "Hide password" : "Show password"}
          aria-pressed={visible}
        >
          {visible ? <EyeOffIcon /> : <EyeIcon />}
        </button>
      </div>
      {showStrength ? <PasswordStrengthMeter password={value} id={meterId} /> : null}
    </div>
  );
}
