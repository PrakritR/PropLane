/**
 * How a dispatch run reads in the portal (vendor-dispatch-1018). Plain words
 * for a run and each attempt, and which actions a run offers. Dispatch is NOT
 * a service stage: the services vocabulary stays Open, Assigned, Scheduled,
 * Completed (`service-lifecycle.ts`); this is a section on the record.
 */
export type DispatchRunStatus =
  | "awaiting_approval"
  | "offering"
  | "accepted"
  | "exhausted"
  | "declined_by_manager"
  | "canceled"
  | "completed";

export type DispatchAttemptStatus =
  | "queued"
  | "offered"
  | "accepted"
  | "declined"
  | "busy"
  | "timed_out"
  | "superseded"
  | "canceled";

export const DISPATCH_RUN_STATUS_LABEL: Record<DispatchRunStatus, string> = {
  awaiting_approval: "Waiting for your approval",
  offering: "Offering",
  accepted: "Accepted",
  exhausted: "No one took it",
  declined_by_manager: "Declined",
  canceled: "Canceled",
  completed: "Done",
};

export const DISPATCH_ATTEMPT_STATUS_LABEL: Record<DispatchAttemptStatus, string> = {
  queued: "Next in line",
  offered: "Waiting for an answer",
  accepted: "Accepted",
  declined: "Declined",
  busy: "Busy",
  timed_out: "No answer",
  superseded: "Skipped",
  canceled: "Canceled",
};

export type DispatchRunAction = "approve" | "pick" | "decline" | "retry" | "broadcast" | "cancel";

export type DispatchAttemptView = {
  id: string;
  vendorDirectoryId: string;
  vendorName: string;
  position: number;
  wave: number;
  status: DispatchAttemptStatus;
  offeredAt: string | null;
  respondedAt: string | null;
  /** What the vendor wrote back. Vendor-entered text: display as data. */
  responseText: string | null;
};

export type DispatchRunView = {
  id: string;
  handle: number;
  sourceType: string;
  sourceId: string;
  trade: string;
  issue: string | null;
  urgency: string;
  propertyId: string | null;
  /** Exactly what the vendor will read (general area only until they accept). */
  offerText: string;
  mode: "sequential" | "broadcast";
  payCents: number | null;
  nteCents: number | null;
  status: DispatchRunStatus;
  approvalChannel: "sms" | "portal" | null;
  approvedByName: string | null;
  approvedAt: string | null;
  acceptedVendorName: string | null;
  acceptedAt: string | null;
  scheduledFor: string | null;
  createdAt: string;
  attempts: DispatchAttemptView[];
};

/** The actions a run in this state offers, in the order the section shows them. */
export function dispatchRunActions(status: DispatchRunStatus): DispatchRunAction[] {
  switch (status) {
    case "awaiting_approval":
      return ["approve", "pick", "decline"];
    case "offering":
      return ["cancel"];
    case "exhausted":
      return ["retry", "broadcast", "cancel"];
    case "accepted":
      return ["cancel"];
    default:
      return [];
  }
}

/** A run still moving: it holds the source's one open dispatch. */
export function dispatchRunIsOpen(status: DispatchRunStatus): boolean {
  return status === "awaiting_approval" || status === "offering";
}

const KNOWN_RUN_STATUS = new Set<string>(Object.keys(DISPATCH_RUN_STATUS_LABEL));
const KNOWN_ATTEMPT_STATUS = new Set<string>(Object.keys(DISPATCH_ATTEMPT_STATUS_LABEL));

export function asRunStatus(value: unknown): DispatchRunStatus {
  return typeof value === "string" && KNOWN_RUN_STATUS.has(value) ? (value as DispatchRunStatus) : "canceled";
}

export function asAttemptStatus(value: unknown): DispatchAttemptStatus {
  return typeof value === "string" && KNOWN_ATTEMPT_STATUS.has(value) ? (value as DispatchAttemptStatus) : "canceled";
}

/** The run to show for a source: the open one, else the newest. */
export function pickRunForSource(runs: readonly DispatchRunView[]): DispatchRunView | null {
  const open = runs.find((run) => dispatchRunIsOpen(run.status));
  if (open) return open;
  return runs.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
}

/** One open offer in the vendor portal: the general area only (the offer text), never a house or resident. */
export type VendorDispatchOffer = {
  attemptId: string;
  handle: number;
  tradeLabel: string;
  issueLabel: string | null;
  urgency: string;
  offerText: string;
  payCents: number | null;
  status: DispatchAttemptStatus;
  /** When the offer lapses; null = until the manager moves on. */
  answerBy: string | null;
};
