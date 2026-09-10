import type { ScheduledPaymentMessage } from "@/lib/scheduled-payment-messages";

export type ClientScheduledMessagePatch = {
  cancelled?: boolean;
  customSubject?: string;
  customBody?: string;
  customSendAt?: string;
  customDeliverViaEmail?: boolean;
  customDeliverViaSms?: boolean;
};

const STORAGE_KEY = "propplane.clientScheduledMessageOverrides.v1";

export const CLIENT_SCHEDULED_MESSAGE_OVERRIDES_EVENT = "propplane:client-scheduled-message-overrides";

function readAll(): Record<string, ClientScheduledMessagePatch> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, ClientScheduledMessagePatch>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeAll(data: Record<string, ClientScheduledMessagePatch>) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

export function mergeClientScheduledMessagePatch(messageId: string, patch: ClientScheduledMessagePatch): void {
  const all = readAll();
  all[messageId] = { ...all[messageId], ...patch };
  writeAll(all);
  window.dispatchEvent(new Event(CLIENT_SCHEDULED_MESSAGE_OVERRIDES_EVENT));
}

export function applyClientPatchesToMessages(messages: ScheduledPaymentMessage[]): ScheduledPaymentMessage[] {
  const all = readAll();
  return messages.map((message) => {
    const patch = all[message.id];
    if (!patch) return message;
    let status = message.status;
    if (patch.cancelled === true) status = "cancelled";
    else if (patch.cancelled === false) status = "scheduled";
    return {
      ...message,
      status,
      subject: patch.customSubject ?? message.subject,
      body: patch.customBody ?? message.body,
      sendAt: patch.customSendAt ?? message.sendAt,
      // `??` and not `||`: false is a real choice here ("do not send by email"),
      // and the fall-through carries the row's own absence, which means the
      // automation settings still decide.
      deliverViaEmail: patch.customDeliverViaEmail ?? message.deliverViaEmail,
      deliverViaSms: patch.customDeliverViaSms ?? message.deliverViaSms,
    };
  });
}
