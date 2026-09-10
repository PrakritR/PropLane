import { formatManagerMessagingPhone } from "@/lib/sms/manager-messaging-number";

/**
 * "Here is how to reach me" — one announcement covering every work contact
 * channel the manager actually has.
 *
 * There is deliberately not one broadcast per channel. A manager who sets up a
 * work number and a work email on the same afternoon would otherwise email
 * their whole portfolio twice with two halves of the same instruction, and a
 * resident who received the number-only version would never learn about the
 * address. The message names whichever channels are live; the caller decides
 * when to offer it, and only ever for a channel that can actually carry a reply.
 */
export type WorkContactChannels = {
  /** E.164 work number, or null when there is none that can send. */
  phone: string | null;
  /** Work email address, or null when there is none that can send. */
  email: string | null;
};

/** The event the Work email card fires to open the shared announce composer. */
export const WORK_CONTACT_ANNOUNCE_EVENT = "axis:work-contact-announce";

export function hasAnyWorkContactChannel(channels: WorkContactChannels): boolean {
  return Boolean(channels.phone?.trim() || channels.email?.trim());
}

/** Stable per-manager key so a dismissed prompt stays dismissed for that pair. */
export function workContactAnnounceStorageKey(channels: WorkContactChannels): string {
  const phone = channels.phone?.trim() ?? "";
  const email = channels.email?.trim().toLowerCase() ?? "";
  return `axis_work_contact_announce_v1:${phone}|${email}`;
}

export function buildWorkContactAnnounceCopy(channels: WorkContactChannels): {
  subject: string;
  text: string;
} {
  const phone = channels.phone?.trim() ? formatManagerMessagingPhone(channels.phone.trim()) : null;
  const email = channels.email?.trim() || null;

  const subject = phone && email
    ? "New ways to reach me"
    : email
      ? "New email address to reach me"
      : "New number to reach me";

  const body = phone && email
    ? ["Here is how to reach me from now on:", "", `Text: ${phone}`, `Email: ${email}`]
    : email
      ? [`Please email me at this new address: ${email}`]
      : [`Please text me at this new number: ${phone}`];

  const save = phone && email
    ? "Save both in your contacts so maintenance updates, rent reminders, and day-to-day questions go to the right place."
    : "Save it in your contacts so maintenance updates, rent reminders, and day-to-day questions go to the right place.";

  return {
    subject,
    text: ["Hi,", "", ...body, "", save, "", "Thanks,", "Your property manager"].join("\n"),
  };
}

/** Which channels the announcement actually named — for the analytics event. */
export function workContactAnnounceChannelTag(channels: WorkContactChannels): string {
  const phone = Boolean(channels.phone?.trim());
  const email = Boolean(channels.email?.trim());
  if (phone && email) return "number_email";
  if (email) return "email";
  return "number";
}
