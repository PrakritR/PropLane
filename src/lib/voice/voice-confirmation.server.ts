import {
  classifySmsConfirmationReply,
  renderPreviewForSms,
  type SmsConfirmationIntent,
} from "@/lib/sms/agent-confirmation.server";

/**
 * Speech transcripts are noisier than typed SMS. Map common spoken affirmations
 * to the same confirm gate vocabulary without treating every "sure" in conversation
 * as authorization — only leading affirmatives/denials count.
 */
export function classifyVoiceConfirmationReply(transcript: string): SmsConfirmationIntent {
  const sms = classifySmsConfirmationReply(transcript);
  if (sms !== "none") return sms;

  const normalized = String(transcript ?? "")
    .trim()
    .replace(/[.!?,]+$/g, "")
    .toLowerCase();
  if (!normalized) return "none";

  if (/^(yes|yeah|yep|yup|correct|right|affirmative|go ahead|do it|confirmed?|approve[d]?)(\s|$)/.test(normalized)) {
    return "confirm";
  }
  if (/^(no|nope|nah|negative|cancel|stop|don't|do not)(\s|$)/.test(normalized)) {
    return "deny";
  }
  return "none";
}

/** Normalize a spoken confirmation into the exact token the SMS gate expects. */
export function normalizeVoiceConfirmationForAgentGate(transcript: string): string {
  const intent = classifyVoiceConfirmationReply(transcript);
  if (intent === "confirm") return "YES";
  if (intent === "deny") return "NO";
  return transcript.trim();
}

export function renderPreviewForVoice(preview: Parameters<typeof renderPreviewForSms>[0]): string {
  return renderPreviewForSms(preview).replace("Reply YES to confirm or NO to cancel.", "Say yes to confirm, or no to cancel.");
}

export function spokenConsentGranted(transcript: string): boolean {
  return classifyVoiceConfirmationReply(transcript) === "confirm";
}
