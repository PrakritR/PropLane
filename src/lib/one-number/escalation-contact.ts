/**
 * Escalation contact line, pure part. When a texting agent hands a question to a human, the reply to the texter ends with
 * ONE line naming who to text. The phone is resolved on the server (`escalation-contact.server.ts`), never typed by the
 * model; this file only holds the stored shape and the sentence.
 */

export type EscalationContactSettings = {
  /** Share the manager's phone when the assistant can't answer. Default ON. */
  enabled: boolean;
  /** True once the manager (or an admin) has saved a choice, as opposed to the default. */
  explicit: boolean;
};

export const DEFAULT_ESCALATION_CONTACT_SETTINGS: EscalationContactSettings = { enabled: true, explicit: false };

export function normalizeEscalationContactSettings(raw: unknown): EscalationContactSettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return DEFAULT_ESCALATION_CONTACT_SETTINGS;
  const r = raw as Record<string, unknown>;
  if (typeof r.enabled !== "boolean") return DEFAULT_ESCALATION_CONTACT_SETTINGS;
  return { enabled: r.enabled, explicit: true };
}

/** "(510) 309-8345" from any US phone format, or null when it is not a 10-digit US number. */
export function formatUsPhoneDisplay(phone: string | null | undefined): string | null {
  const digits = String(phone ?? "").replace(/\D/g, "");
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (ten.length !== 10) return null;
  return `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`;
}

export function formatEscalationContactLine(name: string, phone: string | null | undefined): string | null {
  const display = formatUsPhoneDisplay(phone);
  const who = name.replace(/\s+/g, " ").trim().slice(0, 40);
  if (!display || !who) return null;
  return `For anything I can't answer, text ${who} at ${display}.`;
}

/**
 * Add the contact line to an escalation reply. Exactly one line, never twice: a reply that already carries the number
 * (the model echoed the tool result) is left alone. An empty reply stays empty (a quiet handoff sends nothing).
 */
export function appendEscalationContactLine(reply: string, line: string | null | undefined): string {
  const body = reply.trim();
  if (!body || !line) return reply;
  const digits = line.replace(/\D/g, "").slice(-10);
  if (digits && body.replace(/\D/g, "").includes(digits)) return reply;
  return `${body}\n\n${line}`;
}
