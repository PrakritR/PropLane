type NotificationKind = "work-order" | "service-request";

type ResidentManagerNotificationInput = {
  managerUserId: string;
  residentName: string;
  residentEmail: string;
  propertyName: string;
  propertyId?: string;
  title: string;
  details: string[];
  kind: NotificationKind;
};

type SendResult = { ok: boolean; skipped?: boolean; error?: string };

function joinDetails(details: string[]): string[] {
  return details
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `- ${line}`);
}

function subjectFor(kind: NotificationKind, title: string): string {
  const label = kind === "work-order" ? "Work order" : "Service request";
  return `New resident ${label}: ${title.trim() || "Untitled"}`;
}

function bodyFor(input: ResidentManagerNotificationInput): string {
  const kindLabel = input.kind === "work-order" ? "work order" : "service request";
  const propertyIdLine = input.propertyId?.trim() ? `Property ID: ${input.propertyId.trim()}` : "";
  return [
    `A resident submitted a new ${kindLabel}.`,
    "",
    `Resident: ${input.residentName || "Resident"}`,
    `Resident email: ${input.residentEmail}`,
    `Property: ${input.propertyName || "Assigned property"}`,
    propertyIdLine,
    "",
    `Title: ${input.title}`,
    ...joinDetails(input.details),
  ]
    .filter(Boolean)
    .join("\n");
}

export async function notifyManagerOfResidentSubmission(
  input: ResidentManagerNotificationInput,
): Promise<SendResult> {
  const managerUserId = input.managerUserId.trim();
  if (!managerUserId) return { ok: false, error: "Missing manager user id." };

  try {
    const response = await fetch("/api/portal/send-inbox-message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        fromName: input.residentName || input.residentEmail || "Resident",
        toUserIds: [managerUserId],
        propertyId: input.propertyId?.trim() || undefined,
        fanOutPropertyInbox: true,
        subject: subjectFor(input.kind, input.title),
        text: bodyFor(input),
        deliverToPortalInbox: true,
        // Inbox + email + SMS (when manager has a phone). Server mirrors also
        // notify; send-inbox-message dedupes poorly, but SMS prefs + phone gates
        // still make this the reliable client-side path if mirror lags.
        eventCategory: "maintenance",
        senderPortal: "resident",
      }),
    });
    const payload = (await response.json().catch(() => ({}))) as SendResult;
    if (!response.ok || !payload.ok) {
      return { ok: false, error: payload.error ?? "Notification delivery failed." };
    }
    return payload;
  } catch {
    return { ok: false, error: "Notification delivery failed." };
  }
}
