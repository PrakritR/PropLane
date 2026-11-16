/**
 * Web chat request parsing and the visitor-safe projection of a thread. Pure.
 *
 * A visitor's text is DATA: it is capped, stripped of control characters, stored as typed and rendered as plain text by the
 * widget (never as HTML, never auto-linked). The assistant's own replies may carry PropLane links only; the widget links
 * those and nothing else.
 */
export const WEB_CHAT_MAX_BODY = 1000;
export const WEB_CHAT_MAX_NAME = 60;
const ID_RE = /^[A-Za-z0-9_.:-]{1,200}$/;
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export type WebChatSend = {
  action: "send";
  propertyId: string;
  roomId: string | null;
  body: string;
  clientMessageId: string;
};
export type WebChatPhoneCode = { action: "phone_code"; propertyId: string; phone: string };
export type WebChatPhoneVerify = { action: "phone_verify"; propertyId: string; phone: string; otp: string; smsConsent: boolean };
export type WebChatRequest = WebChatSend | WebChatPhoneCode | WebChatPhoneVerify;

export type ParsedWebChat =
  | { ok: true; value: WebChatRequest }
  | { ok: false; error: string; /** A filled honeypot: answered like a success so a bot learns nothing. */ silent?: true };

const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁦-⁩]/g;

export function cleanVisitorText(raw: unknown, max: number): string {
  if (typeof raw !== "string") return "";
  return raw.replace(CONTROL_RE, "").replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, max);
}

export function parseWebChatRequest(raw: unknown): ParsedWebChat {
  if (!raw || typeof raw !== "object") return { ok: false, error: "Bad request." };
  const body = raw as Record<string, unknown>;
  // The honeypot is a field no person sees. Any value is a script.
  if (typeof body.website === "string" && body.website.trim()) return { ok: false, error: "Bad request.", silent: true };
  const propertyId = typeof body.propertyId === "string" ? body.propertyId.trim() : "";
  if (!ID_RE.test(propertyId)) return { ok: false, error: "This listing is not available." };
  const action = body.action;
  if (action === "send") {
    const text = cleanVisitorText(body.body, WEB_CHAT_MAX_BODY);
    if (!text) return { ok: false, error: "Type a message." };
    if (typeof body.body === "string" && body.body.trim().length > WEB_CHAT_MAX_BODY) return { ok: false, error: "That message is too long." };
    const clientMessageId = typeof body.clientMessageId === "string" ? body.clientMessageId.trim() : "";
    if (!CLIENT_ID_RE.test(clientMessageId)) return { ok: false, error: "Bad request." };
    const roomId = typeof body.roomId === "string" && ID_RE.test(body.roomId.trim()) ? body.roomId.trim() : null;
    return { ok: true, value: { action: "send", propertyId, roomId, body: text, clientMessageId } };
  }
  const phone = typeof body.phone === "string" ? body.phone.trim().slice(0, 40) : "";
  if (action === "phone_code") return phone ? { ok: true, value: { action, propertyId, phone } } : { ok: false, error: "Enter a US phone number." };
  if (action === "phone_verify") {
    const otp = typeof body.otp === "string" ? body.otp.replace(/\D/g, "").slice(0, 8) : "";
    return phone && otp ? { ok: true, value: { action, propertyId, phone, otp, smsConsent: body.smsConsent === true } } : { ok: false, error: "That code did not work." };
  }
  return { ok: false, error: "Bad request." };
}

const PHONE_IN_TEXT = /(?:\+?1[\s.-]?)?\(?\b([2-9]\d{2})\)?[\s.-]?([2-9]\d{2})[\s.-]?(\d{4})\b/;

/** A US phone number the visitor typed inside a message, as digits; null when none. It is a CLAIM: it only triggers the code offer. */
export function phoneClaimedInText(text: string): string | null {
  const match = PHONE_IN_TEXT.exec(text);
  return match ? `${match[1]}${match[2]}${match[3]}` : null;
}

export type VisibleTurn = { id: string; role: "visitor" | "assistant" | "team"; body: string; at: string };

type Row = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/**
 * What the visitor may read of a stored thread: the id, who spoke (they, the assistant, or the team), the text and the time.
 * Never a staff name, an internal note, a draft, a delivery detail or any id beyond the turn's own. Turns come oldest first.
 */
export function visibleTurnsOf(rowData: Row, assistantAuthor: string, limit = 60): VisibleTurn[] {
  const turns: Row[] = [];
  const rootId = str(rowData.rootMessageId);
  if (rootId) {
    turns.push({ id: rootId, from: rowData.from, body: rowData.body, at: str(rowData.rootAt) || str(rowData.time), outbound: rowData.rootOutbound === true });
  }
  for (const m of (Array.isArray(rowData.messages) ? rowData.messages : []) as Row[]) if (m && str(m.id)) turns.push(m);
  const out: VisibleTurn[] = [];
  for (const m of turns) {
    if (m.internal === true || m.private === true || m.draft === true || m.isDraft === true || m.note === true) continue;
    const body = typeof m.body === "string" ? m.body.trim() : "";
    if (!body) continue;
    const staff = m.outbound === true || Boolean(str(m.senderUserId));
    const role: VisibleTurn["role"] = !staff ? "visitor" : str(m.from) === assistantAuthor || m.automated === true ? "assistant" : "team";
    out.push({ id: str(m.id), role, body: body.slice(0, 2000), at: str(m.at) });
  }
  return out.slice(-limit);
}
