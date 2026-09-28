"use client";

/**
 * M017 — OTP input primitive (built, NOT wired to a live surface).
 *
 * PropLane has no verification-code entry anywhere, mocked or real —
 * AGENTS.md: "Emailed auth links are `token_hash`, never a `code`." A
 * page-by-page pass found nothing to attach this to (see
 * ~/proplane-mock-kit/review-0927/studio-motion.md "Not wired" and this
 * batch's own report). Built as a complete, ready primitive — full
 * pointer+keyboard a11y, auto-advance, paste-splitting, an error shake — for
 * the day a real code-entry surface (SMS/email 2FA, phone verification)
 * exists to wire it into with a one-attribute integration. Ports
 * interior.dev's OTP Input (MIT, github.com/ddoemonn/interior).
 */
import { useRef } from "react";
import { cn } from "@/lib/utils";

export function OtpInput({
  length = 6,
  value,
  onChange,
  onComplete,
  error = false,
  disabled = false,
  label = "Verification code",
}: {
  length?: number;
  /** The full code as typed so far, e.g. "123" while 3 of 6 digits are filled. */
  value: string;
  onChange: (next: string) => void;
  /** Fires once, the instant the code reaches `length` digits (paste or typed). */
  onComplete?: (code: string) => void;
  /** Shakes every cell once and re-renders — the caller clears it back to false. */
  error?: boolean;
  disabled?: boolean;
  label?: string;
}) {
  const cellRefs = useRef<Array<HTMLInputElement | null>>([]);
  const digits = value.split("").slice(0, length);
  while (digits.length < length) digits.push("");

  const commit = (next: string) => {
    onChange(next);
    if (next.length === length && onComplete) onComplete(next);
  };

  const setDigit = (index: number, digit: string) => {
    const next = digits.slice();
    next[index] = digit;
    commit(next.join(""));
    if (digit && index + 1 < length) cellRefs.current[index + 1]?.focus();
  };

  return (
    <div>
      <div role="group" aria-label={label} className="flex gap-2">
        {digits.map((digit, i) => (
          <input
            key={i}
            ref={(el) => {
              cellRefs.current[i] = el;
            }}
            value={digit}
            disabled={disabled}
            inputMode="numeric"
            maxLength={1}
            aria-label={`${label}, character ${i + 1} of ${length}`}
            className={cn("motion-otp-cell", digit && "is-filled", error && "is-error")}
            onChange={(e) => {
              const raw = e.target.value.replace(/\D/g, "");
              if (!raw) {
                setDigit(i, "");
                return;
              }
              setDigit(i, raw[raw.length - 1] ?? "");
            }}
            onKeyDown={(e) => {
              if (e.key === "Backspace" && !digits[i] && i > 0) cellRefs.current[i - 1]?.focus();
              if (e.key === "ArrowLeft" && i > 0) cellRefs.current[i - 1]?.focus();
              if (e.key === "ArrowRight" && i + 1 < length) cellRefs.current[i + 1]?.focus();
            }}
            onPaste={(e) => {
              const text = e.clipboardData.getData("text").replace(/\D/g, "");
              if (!text) return;
              e.preventDefault();
              const next = digits.slice();
              for (let j = 0; j < text.length && i + j < length; j++) next[i + j] = text[j]!;
              commit(next.join(""));
              const focusIndex = Math.min(i + text.length, length - 1);
              cellRefs.current[focusIndex]?.focus();
            }}
          />
        ))}
      </div>
      {error ? (
        <span role="status" aria-live="polite" className="sr-only">
          Incorrect code
        </span>
      ) : null}
    </div>
  );
}
// A caller drives `error` itself — true right after a rejected code, then
// false again (e.g. on the next digit typed, or a short timeout). Because
// `.is-error`'s shake (tokens.css) is a plain CSS animation keyed off that
// class being present, toggling it off between attempts is enough for a
// SECOND wrong code to shake again — no extra remount/key needed here.
