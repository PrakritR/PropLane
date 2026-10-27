/** Digits for the code field from a typed, pasted or autofilled value: "482 913", "Your PropLane code is 482913. It expires in 10 minutes." */
export function codeDigitsFrom(raw: string, length = 6): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length <= length) return digits;
  // A whole text message pasted in: prefer a standalone run of exactly `length` digits over the first digits it contains.
  const standalone = raw.match(new RegExp(`(?<!\\d)\\d{${length}}(?!\\d)`));
  return standalone ? standalone[0] : digits.slice(0, length);
}

/** "0:30" countdown label for the resend button. */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
