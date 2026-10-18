/**
 * Whether the attachments on a composer allow a send.
 *
 * A failed upload used to be dropped silently at send time: the chip read
 * "Failed" and the message still went out without the file. A send now waits
 * until every attachment is either uploaded or removed.
 */
export type InboxAttachmentGateItem = { uploading?: boolean; error?: string | null };

export function inboxAttachmentsHaveFailure(attachments: readonly InboxAttachmentGateItem[] | undefined): boolean {
  return (attachments ?? []).some((attachment) => Boolean(attachment.error));
}

export const INBOX_ATTACHMENT_FAILED_MESSAGE = "An attachment failed to upload. Remove it or attach it again to send.";
export const INBOX_ATTACHMENT_UPLOADING_MESSAGE = "Wait for uploads to finish.";

/**
 * Why the attachments block this send, or `null` when they do not. Every composer asks this one
 * question — a gate that lived in two places is how a failed upload got dropped silently once.
 */
export function inboxAttachmentSendBlockReason(
  attachments: readonly InboxAttachmentGateItem[] | undefined,
): string | null {
  if (inboxAttachmentsHaveFailure(attachments)) return INBOX_ATTACHMENT_FAILED_MESSAGE;
  if ((attachments ?? []).some((attachment) => attachment.uploading)) return INBOX_ATTACHMENT_UPLOADING_MESSAGE;
  return null;
}

/** True when nothing about the attachments blocks a send (a message with no attachments is always clear). */
export function inboxAttachmentsAllowSend(attachments: readonly InboxAttachmentGateItem[] | undefined): boolean {
  return inboxAttachmentSendBlockReason(attachments) === null;
}
