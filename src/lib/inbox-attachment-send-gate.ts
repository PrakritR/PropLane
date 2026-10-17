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

/** True when nothing about the attachments blocks a send (a message with no attachments is always clear). */
export function inboxAttachmentsAllowSend(attachments: readonly InboxAttachmentGateItem[] | undefined): boolean {
  return !inboxAttachmentsHaveFailure(attachments) && !(attachments ?? []).some((attachment) => attachment.uploading);
}
