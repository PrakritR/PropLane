import type {
  NotificationConfirmDraft,
  NotificationDeliveryChannels,
} from "@/components/portal/portal-notification-preview-modal";
import type { NotificationCategory } from "@/lib/notification-preferences";
import { deliverPortalInboxMessage } from "@/lib/portal-message-delivery";

export type ManagerVendorInvitePreview = {
  linkUrl?: string;
  vendorId: string;
  name: string;
  email: string;
  phone: string;
  subject: string;
  body: string;
};

export type ManagerVendorRemovalPreview = {
  vendorId: string;
  name: string;
  email: string;
  phone: string;
  subject: string;
  body: string;
};

export type ManagerDirectoryMessageResult =
  | { ok: true; message: string; delivery?: "sent" | "scheduled" | "saved" }
  | { ok: false; message: string; uncertain?: boolean };

export async function fetchManagerVendorInviteDraft(input: {
  vendorId: string;
  vendorName: string;
  vendorEmail: string;
}): Promise<{ ok: true; preview: ManagerVendorInvitePreview } | { ok: false; error: string }> {
  const email = input.vendorEmail.trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(email)) {
    return { ok: false, error: "A valid email is required to preview the vendor portal invite." };
  }
  try {
    const res = await fetch("/api/portal/vendor-invite-draft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        vendorId: input.vendorId,
        vendorName: input.vendorName,
        vendorEmail: email,
      }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      subject?: string;
      body?: string;
      linkUrl?: string;
      error?: string;
    };
    if (!res.ok || !data.subject?.trim() || !data.body?.trim()) {
      return { ok: false, error: data.error ?? "Could not prepare the vendor onboarding message." };
    }
    return {
      ok: true,
      preview: {
        vendorId: input.vendorId,
        name: input.vendorName,
        email,
        phone: "",
        linkUrl: data.linkUrl,
        subject: data.subject,
        body: data.body,
      },
    };
  } catch {
    return { ok: false, error: "Could not prepare the vendor onboarding message." };
  }
}

export async function fetchManagerVendorRemovalDraft(input: {
  vendorId: string;
  vendorName: string;
  vendorEmail?: string;
  vendorPhone?: string;
}): Promise<{ ok: true; preview: ManagerVendorRemovalPreview } | { ok: false; error: string }> {
  try {
    const res = await fetch("/api/portal/vendor-removal-draft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        vendorId: input.vendorId,
        vendorName: input.vendorName,
      }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      subject?: string;
      body?: string;
      error?: string;
    };
    if (!res.ok || !data.subject?.trim() || !data.body?.trim()) {
      return { ok: false, error: data.error ?? "Could not prepare the vendor removal message." };
    }
    return {
      ok: true,
      preview: {
        vendorId: input.vendorId,
        name: input.vendorName,
        email: input.vendorEmail?.trim() ?? "",
        phone: input.vendorPhone?.trim() ?? "",
        subject: data.subject,
        body: data.body,
      },
    };
  } catch {
    return { ok: false, error: "Could not prepare the vendor removal message." };
  }
}

export async function deliverManagerDirectoryMessage(
  preview: Pick<ManagerVendorInvitePreview, "name" | "email" | "subject" | "body">,
  skipMessage: boolean,
  channels?: NotificationDeliveryChannels,
  messageDraft?: NotificationConfirmDraft,
  opts?: { toUserIds?: string[]; eventCategory?: NotificationCategory },
): Promise<ManagerDirectoryMessageResult> {
  if (skipMessage) {
    return { ok: true, message: "" };
  }

  const subject = messageDraft?.subject?.trim() || preview.subject;
  const body = messageDraft?.body?.trim() || preview.body;
  const viaInbox = channels?.viaInbox !== false;
  const viaEmail = channels == null ? true : channels.viaEmail === true;
  const viaSms = channels == null ? false : channels.viaSms === true;
  const recipientUserId = opts?.toUserIds?.[0]?.trim() ?? "";

  if (messageDraft?.scheduleAt) {
    const response = await fetch("/api/portal/scheduled-inbox-messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        subject,
        body,
        sendAt: messageDraft.scheduleAt,
        deliverViaEmail: viaEmail,
        deliverViaSms: viaSms,
        deliverViaInbox: viaInbox,
        recipientEmail: preview.email,
        recipientName: preview.name.trim(),
        recipientUserId: recipientUserId || undefined,
        senderPortal: "manager",
      }),
    });
    const data = (await response.json().catch(() => ({}))) as { error?: string };
    if (!response.ok) {
      return { ok: false, message: data.error ?? "The message could not be scheduled." };
    }
    return {
      ok: true,
      delivery: "scheduled",
      message: `Message scheduled for ${preview.name.trim() || preview.email || "recipient"}.`,
    };
  }

  const notice = await deliverPortalInboxMessage({
    eventCategory: opts?.eventCategory ?? "messages",
    toEmails: preview.email ? [preview.email] : undefined,
    toUserIds: opts?.toUserIds,
    subject,
    text: body,
    deliverToPortalInbox: viaInbox,
    deliverViaEmail: viaEmail,
    deliverViaSms: viaSms,
  });
  if (notice.ok) {
    return {
      ok: true,
      delivery: notice.skipped ? "saved" : "sent",
      message: notice.skipped
        ? "Message saved to PropLane inbox."
        : `Message sent to ${preview.name.trim() || preview.email || "recipient"}.`,
    };
  }
  return {
    ok: false,
    uncertain: notice.uncertain,
    message: notice.error ? `Message failed: ${notice.error}` : "The message could not be sent.",
  };
}

/**
 * Text a workspace invite to a phone with no PropLane account yet, through
 * the manager's provisioned work number. `phone` must already be E.164
 * (`normalizeE164` from `@/lib/phone-e164`) — this never guesses at a raw
 * string the way the shared inbox pipeline would.
 */
export async function sendWorkspaceInviteSms(input: {
  workspaceId: string;
  phone: string;
  text: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch("/api/pro/invite-links/send-sms", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!res.ok || !data.ok) {
      return { ok: false, error: data.error ?? "Could not send the text." };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "Could not send the text." };
  }
}

export async function deliverManagerVendorInvite(
  preview: ManagerVendorInvitePreview,
  skipMessage: boolean,
  channels?: NotificationDeliveryChannels,
  messageDraft?: NotificationConfirmDraft,
): Promise<ManagerDirectoryMessageResult> {
  const result = await deliverManagerDirectoryMessage(preview, skipMessage, channels, messageDraft);
  if (!result.ok) return result;
  if (!skipMessage && result.delivery) {
    const label = preview.email;
    if (result.delivery === "sent") {
      return { ok: true, delivery: "sent", message: `Portal invite sent to ${label}.` };
    }
    if (result.delivery === "scheduled") {
      return { ok: true, delivery: "scheduled", message: `Portal invite scheduled for ${label}.` };
    }
    if (result.delivery === "saved") {
      return { ok: true, delivery: "saved", message: `Invite saved to PropLane inbox for ${label}.` };
    }
  }
  return result;
}
