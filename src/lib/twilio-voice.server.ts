import twilio from "twilio";
import { PRODUCTION_APP_ORIGIN, resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { twilioWebhookAuthToken } from "@/lib/twilio-client.server";

export type TwilioVoiceWebhookParams = Record<string, string>;

export function isManagerVoiceAgentEnabled(): boolean {
  const raw = process.env.MANAGER_VOICE_AGENT_ENABLED?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

export function isVoiceRecordingEnabled(): boolean {
  const raw = process.env.TWILIO_VOICE_RECORDING?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

export function resolveVoiceInboundWebhookUrl(): string {
  const explicit = process.env.TWILIO_VOICE_INBOUND_WEBHOOK_URL?.trim();
  if (explicit) return explicit;
  const base = (resolveEmailLinkBaseUrl() || PRODUCTION_APP_ORIGIN).replace(/\/$/, "");
  return `${base}/api/twilio/voice/inbound`;
}

export function resolveVoiceTurnWebhookUrl(phase: "consent" | "agent" = "agent"): string {
  const explicit = process.env.TWILIO_VOICE_TURN_WEBHOOK_URL?.trim();
  if (explicit) {
    try {
      const url = new URL(explicit);
      if (!url.pathname.endsWith("/turn")) {
        url.pathname = `${url.pathname.replace(/\/$/, "")}/turn`;
      }
      url.searchParams.set("phase", phase);
      return url.toString();
    } catch {
      /* fall through to derived URL */
    }
  }
  const base = (resolveEmailLinkBaseUrl() || PRODUCTION_APP_ORIGIN).replace(/\/$/, "");
  return `${base}/api/twilio/voice/turn?phase=${phase}`;
}

/** Twilio call-status callback (fires on completed/failed/no-answer). */
export function resolveVoiceStatusWebhookUrl(): string {
  const explicit = process.env.TWILIO_VOICE_STATUS_WEBHOOK_URL?.trim();
  if (explicit) return explicit;
  const base = (resolveEmailLinkBaseUrl() || PRODUCTION_APP_ORIGIN).replace(/\/$/, "");
  return `${base}/api/twilio/voice/status`;
}

export function resolveVoiceRecordingWebhookUrl(): string {
  const explicit = process.env.TWILIO_VOICE_RECORDING_WEBHOOK_URL?.trim();
  if (explicit) return explicit;
  const base = (resolveEmailLinkBaseUrl() || PRODUCTION_APP_ORIGIN).replace(/\/$/, "");
  return `${base}/api/twilio/voice/recording`;
}

export function resolveVoicePollyVoice(): string {
  return process.env.TWILIO_VOICE_POLLY_VOICE?.trim() || "Polly.Joanna-Neural";
}

export function resolveVoiceLanguage(): string {
  return process.env.TWILIO_VOICE_LANGUAGE?.trim() || "en-US";
}

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function twimlResponse(innerXml: string, status = 200): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${innerXml}</Response>`, {
    status,
    headers: { "Content-Type": "text/xml; charset=utf-8" },
  });
}

export function twimlSay(text: string, voice = resolveVoicePollyVoice(), language = resolveVoiceLanguage()): string {
  return `<Say voice="${escapeXml(voice)}" language="${escapeXml(language)}">${escapeXml(text)}</Say>`;
}

/**
 * Bridge the live call to a real phone.
 *
 * `callerId` must be a number this Twilio account owns — the manager's work
 * number — so the manager sees the call coming from PropLane rather than from
 * the caller's own line. `answerOnBridge` keeps the caller hearing ringing
 * instead of silence, and the call ends when the bridge does.
 */
export function twimlDial(args: { toPhone: string; callerId: string; timeoutSeconds?: number }): string {
  const timeout = Math.max(5, Math.min(60, args.timeoutSeconds ?? 25));
  return (
    `<Dial answerOnBridge="true" callerId="${escapeXml(args.callerId)}" timeout="${timeout}">` +
    `<Number>${escapeXml(args.toPhone)}</Number>` +
    `</Dial>`
  );
}

export function twimlHangup(): string {
  return "<Hangup/>";
}

export function twimlGatherSpeech(args: {
  actionUrl: string;
  prompt?: string;
  timeout?: number;
  speechTimeout?: "auto" | number;
}): string {
  const prompt = args.prompt ? twimlSay(args.prompt) : "";
  const timeout = args.timeout ?? 8;
  const speechTimeout = args.speechTimeout ?? "auto";
  const speechTimeoutAttr =
    speechTimeout === "auto" ? 'speechTimeout="auto"' : `speechTimeout="${speechTimeout}"`;
  return `${prompt}<Gather input="speech" action="${escapeXml(args.actionUrl)}" method="POST" timeout="${timeout}" ${speechTimeoutAttr} language="${escapeXml(resolveVoiceLanguage())}"><Say voice="${escapeXml(resolveVoicePollyVoice())}" language="${escapeXml(resolveVoiceLanguage())}"> </Say></Gather>`;
}

export function twimlStartRecording(statusCallbackUrl: string): string {
  return `<Start><Recording recordingStatusCallback="${escapeXml(statusCallbackUrl)}" recordingStatusCallbackMethod="POST" /></Start>`;
}

/**
 * Validate Twilio webhook signature. Uses explicit env URL when set (proxy/ngrok),
 * otherwise the request URL Twilio posted to.
 */
export function validateTwilioVoiceWebhook(
  req: Request,
  rawBody: string,
  envUrlOverride?: string | null,
): { ok: true; params: TwilioVoiceWebhookParams } | { ok: false; status: number; message: string } {
  const authToken = twilioWebhookAuthToken();
  if (!authToken) {
    return { ok: false, status: 503, message: "Voice not configured." };
  }

  const params = Object.fromEntries(new URLSearchParams(rawBody)) as TwilioVoiceWebhookParams;
  const signature = req.headers.get("x-twilio-signature") ?? "";
  const failClosed = Boolean(process.env.VERCEL || process.env.NODE_ENV === "production");
  const url = envUrlOverride?.trim() || req.url;

  if (!signature) {
    if (failClosed) return { ok: false, status: 403, message: "Invalid signature." };
    return { ok: true, params };
  }
  if (!twilio.validateRequest(authToken, signature, url, params)) {
    return { ok: false, status: 403, message: "Invalid signature." };
  }
  return { ok: true, params };
}

/** Trim agent reply for spoken TTS (shorter than SMS segment limits). */
export function truncateForVoiceSpeech(text: string, maxChars = 900): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars - 1).trimEnd()}…`;
}
