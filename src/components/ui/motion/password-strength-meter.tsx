"use client";

/**
 * M011 — password strength meter on sign-up / reset.
 *
 * Scoring technique ported from interior.dev's Password Strength (MIT
 * license, github.com/ddoemonn/interior, © ozzy): length + case mix + digits
 * + symbols, with a common-password/keyboard-run penalty — scored locally,
 * no network call. See
 * ~/proplane-mock-kit/review-0927/interior-dev-research.md §2's "Password
 * Strength" row.
 */
import { cn } from "@/lib/utils";

const COMMON_PREFIXES = /^(password|12345678|qwertyui|11111111|123456789|letmein00)/i;
const REPEATED_RUN = /(.)\1\1/;

export type PasswordStrengthScore = 0 | 1 | 2 | 3 | 4;

export const PASSWORD_STRENGTH_LABELS: readonly string[] = ["Too short", "Weak", "Fair", "Good", "Strong"];
const TONE: readonly ("weak" | "fair" | "good")[] = ["weak", "weak", "fair", "good", "good"];

/** No network call — every signal is a local, cheap regex/length check. */
export function scorePasswordStrength(password: string): PasswordStrengthScore {
  if (!password) return 0;
  let score = 0;
  if (password.length >= 8) score++;
  if (password.length >= 12) score++;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score++;
  if (/\d/.test(password)) score++;
  if (/[^A-Za-z0-9]/.test(password)) score++;
  if (COMMON_PREFIXES.test(password)) score = Math.min(score, 1);
  if (REPEATED_RUN.test(password)) score = Math.max(0, score - 1);
  return Math.min(4, score) as PasswordStrengthScore;
}

/**
 * Segment-by-segment fill + a crossfading label. Renders even for an empty
 * password (so the DOM node exists once, no remount), but stays invisible
 * (`opacity: 0`, tokens.css) until there is something to score — matching
 * the no-subtext rule (nothing shown while the field is merely empty).
 */
export function PasswordStrengthMeter({ password, id }: { password: string; id?: string }) {
  const score = scorePasswordStrength(password);
  const hasValue = password.length > 0;
  return (
    <div className="motion-pw-strength" data-attr="password-strength-meter">
      <div
        className="motion-pw-strength-track"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={4}
        aria-valuenow={score}
        aria-valuetext={hasValue ? PASSWORD_STRENGTH_LABELS[score] : "Empty"}
        aria-label="Password strength"
      >
        {[0, 1, 2, 3].map((segIndex) => (
          <span
            key={segIndex}
            className={cn(
              "motion-pw-strength-seg",
              hasValue && segIndex < score && `is-on-${TONE[score]}`,
            )}
          />
        ))}
      </div>
      <span id={id} role="status" aria-live="polite" className={cn("motion-pw-strength-label", hasValue && "is-shown")}>
        {hasValue ? PASSWORD_STRENGTH_LABELS[score] : ""}
      </span>
    </div>
  );
}
