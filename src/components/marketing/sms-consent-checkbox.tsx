import Link from "next/link";

import { SMS_CONSENT_WORDING_VERSION } from "@/lib/rental-application/sms-consent";

/**
 * Carrier-compliant (A2P 10DLC / CTIA) SMS opt-in control. Rendered on every
 * public form that collects a phone number and can lead to an outbound text.
 * Invariants required for carrier review — do not change without re-checking
 * the campaign requirements:
 *  - unchecked by default (never pre-selected),
 *  - optional: submitting without it must still succeed,
 *  - not bundled with any other agreement,
 *  - names the sender + message types + frequency/rate + STOP/HELP,
 *  - links to the Privacy Policy and Terms of Service.
 */
export function SmsConsentCheckbox({
  checked,
  onChange,
  inputId,
  ps = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  inputId: string;
  /** Journey styling (`.ps` pages): hairline block, same wording and behavior. */
  ps?: boolean;
}) {
  return (
    <label
      htmlFor={inputId}
      data-attr="sms-consent-checkbox"
      data-wording-version={SMS_CONSENT_WORDING_VERSION}
      className={
        ps
          ? "ps-j-consent"
          : "flex cursor-pointer items-start gap-3 rounded-2xl border border-border bg-accent/20 px-4 py-3"
      }
    >
      <input
        id={inputId}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className={ps ? undefined : "mt-0.5 h-4 w-4 shrink-0 rounded border-border text-primary focus:ring-primary/30"}
      />
      <span className={ps ? undefined : "text-xs leading-relaxed text-muted"}>
        I agree to receive text messages from PropLane about my rental application and account. Msg &amp; data
        rates may apply. Message frequency varies. Reply STOP to opt out, HELP for help. See our{" "}
        <Link href="/privacy" target="_blank" className="font-semibold text-primary hover:underline">
          Privacy Policy
        </Link>{" "}
        and{" "}
        <Link href="/tos" target="_blank" className="font-semibold text-primary hover:underline">
          Terms of Service
        </Link>
        . Consent is optional and not required to submit an application, book a tour, or send a message.
      </span>
    </label>
  );
}
