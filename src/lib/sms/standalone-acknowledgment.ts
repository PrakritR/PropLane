/**
 * Conservative SMS acknowledgment classifier used to authorize a no-reply
 * outcome. False negatives cost one courteous reply; false positives lose a
 * prospect's question, so only a short exact phrase is accepted.
 */
const STANDALONE_ACKNOWLEDGMENTS = new Set([
  "got it",
  "got it thanks",
  "got it thank you",
  "makes sense",
  "noted",
  "ok thanks",
  "ok thank you",
  "okay thanks",
  "okay thank you",
  "thanks",
  "thanks so much",
  "thank you",
  "thank you so much",
  "understood",
]);

export function isStandaloneSmsAcknowledgment(value: string): boolean {
  const normalized = value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  if (!normalized || normalized.length > 80 || normalized.includes("?")) return false;
  const phrase = normalized.replace(/,/g, "").replace(/^[.!…]+|[.!…]+$/g, "").trim();
  return STANDALONE_ACKNOWLEDGMENTS.has(phrase);
}
