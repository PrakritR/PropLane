export type ManagerNotificationDestination = "none" | "personal_number" | "assistant" | "both";

export type ManagerNotificationCategory =
  | "messages"
  | "maintenance"
  | "payment_reminders"
  | "applications"
  | "leasing"
  | "voice_calls"
  | "attention_digest";

export type ManagerAttentionDigestCadence = "off" | "daily" | "weekly";

export type ManagerNotificationCategoryPreferences = Record<ManagerNotificationCategory, boolean>;

export const MANAGER_NOTIFICATION_CATEGORIES = [
  {
    id: "messages",
    label: "Messages",
    description: "New resident and vendor messages that need a reply.",
  },
  {
    id: "maintenance",
    label: "Maintenance",
    description: "Services, add-on requests, reminders, and status changes.",
  },
  {
    id: "payment_reminders",
    label: "Payment reminders",
    description: "Confirmation when automated rent or charge reminders are sent.",
  },
  {
    id: "applications",
    label: "Applications",
    description: "New applications and application updates.",
  },
  {
    id: "leasing",
    label: "Leasing",
    description: "Tour requests and new listing inquiries.",
  },
  {
    id: "voice_calls",
    label: "Call summaries",
    description: "Transcript and summary after someone calls your work number.",
  },
  {
    id: "attention_digest",
    label: "Needs-attention digest",
    description: "Scheduled summary of unpaid charges, service work, applications, and unsigned leases.",
  },
] as const satisfies ReadonlyArray<{
  id: ManagerNotificationCategory;
  label: string;
  description: string;
}>;

export const DEFAULT_MANAGER_NOTIFICATION_DESTINATION: ManagerNotificationDestination =
  "assistant";

export const DEFAULT_MANAGER_NOTIFICATION_CATEGORIES: ManagerNotificationCategoryPreferences = {
  messages: true,
  maintenance: true,
  payment_reminders: true,
  applications: true,
  leasing: true,
  voice_calls: true,
  attention_digest: true,
};

export function normalizeManagerAttentionDigestCadence(
  value: unknown,
): ManagerAttentionDigestCadence {
  return value === "daily" || value === "weekly" ? value : "off";
}

export function normalizeManagerNotificationDestination(
  value: unknown,
): ManagerNotificationDestination {
  return value === "none" || value === "assistant" || value === "both" || value === "personal_number"
    ? value
    : DEFAULT_MANAGER_NOTIFICATION_DESTINATION;
}

export function normalizeManagerNotificationCategories(
  value: unknown,
): ManagerNotificationCategoryPreferences {
  const row = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return Object.fromEntries(
    MANAGER_NOTIFICATION_CATEGORIES.map(({ id }) => [
      id,
      typeof row[id] === "boolean" ? row[id] : DEFAULT_MANAGER_NOTIFICATION_CATEGORIES[id],
    ]),
  ) as ManagerNotificationCategoryPreferences;
}

export function managerNotificationCategoryForEvent(
  eventCategory: string,
): ManagerNotificationCategory {
  switch (eventCategory) {
    case "maintenance":
      return "maintenance";
    case "payments":
    case "payment_reminders":
      return "payment_reminders";
    case "applications":
      return "applications";
    case "attention_digest":
      return "attention_digest";
    case "voice_calls":
      return "voice_calls";
    case "leases":
    case "leasing":
      return "leasing";
    case "messages":
    case "account":
    default:
      return "messages";
  }
}

export function managerNotificationCategoryForTask(task: {
  templateKey?: string;
  taskType?: string;
  title: string;
  linkedWorkOrderId?: string;
}): ManagerNotificationCategory {
  const template = task.templateKey ?? "";
  if (template === "review_application" || template === "decide_application") return "applications";
  if (
    template === "review_and_send_lease" ||
    template === "countersign_lease" ||
    template === "approve_tour_request" ||
    template === "prepare_for_tour"
  ) return "leasing";
  if (template === "collect_rent") return "payment_reminders";
  if (
    task.taskType === "work_order" ||
    Boolean(task.linkedWorkOrderId) ||
    // Matches TITLES ALREADY STORED on rows, not display copy: a maintenance
    // task is still prefixed "Work order ·" in existing data even though the
    // product now calls it a service everywhere a person reads it. Renaming
    // this literal silently stops matching every row written before the rename.
    /^(Service|Work order) ·/.test(task.title.trim())
  ) return "maintenance";
  return "messages";
}

export function resolveManagerNotificationRoute(input: {
  destination: ManagerNotificationDestination;
  categoryEnabled: boolean;
  personalPhoneReady: boolean;
  workNumberReady: boolean;
}): { assistant: boolean; sms: boolean; fellBackToAssistant: boolean } {
  if (input.destination === "none") {
    return { assistant: false, sms: false, fellBackToAssistant: false };
  }
  const smsReady = input.categoryEnabled && input.personalPhoneReady && input.workNumberReady;
  if (input.destination === "assistant") {
    return { assistant: true, sms: false, fellBackToAssistant: false };
  }
  if (input.destination === "both") {
    return { assistant: true, sms: smsReady, fellBackToAssistant: false };
  }
  if (smsReady) {
    return { assistant: false, sms: true, fellBackToAssistant: false };
  }
  return { assistant: true, sms: false, fellBackToAssistant: true };
}
