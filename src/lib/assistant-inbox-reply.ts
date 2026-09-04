/** Client helper — PropLane in-app inbox replies (portal delivery only, no email/SMS). */
export async function sendPropLaneAssistantInboxMessage(args: {
  threadId: string;
  subject: string;
  text: string;
  fromName: string;
  senderPortal: "manager" | "resident";
  attachmentUrls?: string[];
  /** Counterparty on person threads — assistant threads omit this. */
  toEmails?: string[];
  toUserIds?: string[];
}): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch("/api/portal/send-inbox-message", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      threadId: args.threadId,
      subject: args.subject,
      text: args.text,
      fromName: args.fromName,
      deliverToPortalInbox: true,
      deliverViaEmail: false,
      deliverViaSms: false,
      senderPortal: args.senderPortal,
      toEmails: args.toEmails?.length ? args.toEmails : undefined,
      toUserIds: args.toUserIds?.length ? args.toUserIds : undefined,
      attachmentUrls: args.attachmentUrls?.length ? args.attachmentUrls : undefined,
    }),
  });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  return { ok: res.ok && data.ok === true, error: data.error };
}
