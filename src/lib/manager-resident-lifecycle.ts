import type { DemoManagerPaymentLedgerRow, DemoApplicantRow } from "@/data/demo-portal";
import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";
import { parseMoneyAmount } from "@/lib/parse-money";

export type ResidentLifecycleStageId =
  | "prospect"
  | "applicant"
  | "approved"
  | "lease_sent"
  | "signed"
  | "current"
  | "moving_out"
  | "past";

export type ResidentLifecycleStepState = "done" | "current" | "next";

export type ResidentLifecycleStep = {
  id: ResidentLifecycleStageId;
  label: string;
  state: ResidentLifecycleStepState;
  date?: string;
};

export type ResidentLifecycleAction =
  | { kind: "navigate"; href: string; label: string }
  | { kind: "callback"; label: string; actionId: string };

export type ResidentNeedsAttentionItem = {
  id: string;
  icon: string;
  title: string;
  fact: string;
  urgent: boolean;
  rank: number;
  href?: string;
  inline?: { label: string; actionId: string };
};

export type ResidentLifecycleSnapshot = {
  stage: ResidentLifecycleStageId;
  stageLabel: string;
  headerFact: string;
  steps: ResidentLifecycleStep[];
  next: ResidentLifecycleAction | null;
  todo: ResidentNeedsAttentionItem[];
  kpiTiles: Array<{ label: string; value: string }>;
  balanceCents: number;
};

const STAGE_LABELS: Record<ResidentLifecycleStageId, string> = {
  prospect: "Prospect",
  applicant: "Applicant",
  approved: "Approved",
  lease_sent: "Lease sent",
  signed: "Signed",
  current: "Current resident",
  moving_out: "Moving out",
  past: "Past resident",
};

const STAGE_ORDER: ResidentLifecycleStageId[] = [
  "prospect",
  "applicant",
  "approved",
  "lease_sent",
  "signed",
  "current",
  "moving_out",
  "past",
];

const usdWhole = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

const usdCents = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatResidentMoney(cents: number): string {
  const dollars = cents / 100;
  return (dollars % 1 === 0 ? usdWhole : usdCents).format(dollars);
}

function parseIsoDay(iso: string | undefined | null): Date | null {
  if (!iso?.trim()) return null;
  const raw = iso.trim();
  const d = new Date(raw.length === 10 ? `${raw}T12:00:00.000Z` : raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Drop the year when it matches the current calendar year (Sep 26 vs Feb 28, 2027). */
export function formatResidentShortDate(iso: string | undefined | null): string {
  const d = parseIsoDay(iso);
  if (!d) return "";
  const now = new Date();
  const sameYear = d.getUTCFullYear() === now.getUTCFullYear();
  const month = d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  const day = d.getUTCDate();
  if (sameYear) return `${month} ${day}`;
  return `${month} ${day}, ${d.getUTCFullYear()}`;
}

function chargeDueCents(row: DemoManagerPaymentLedgerRow): number {
  if (row.bucket === "paid") return 0;
  return parseMoneyAmount(row.balanceDue);
}

export type ResidentLifecycleInput = {
  directoryStage: "potential" | "current" | "past";
  application: DemoApplicantRow | null;
  leaseRows: LeasePipelineRow[];
  ledgerRows: DemoManagerPaymentLedgerRow[];
  hasPortalAccount: boolean;
  monthlyIncome?: number | null;
  roomLabel?: string;
  propertyLabel?: string;
  moveInDate?: string;
  moveOutDate?: string;
  signedMonthlyRent?: number | null;
  tourCount?: number;
  hasPendingTour?: boolean;
  hasRequestedTour?: boolean;
  screeningRequested?: boolean;
  moveInInspectionOpen?: boolean;
  moveOutInspectionOpen?: boolean;
  hasMoveInInspection?: boolean;
  hasMoveOutInspection?: boolean;
  serviceRequestCount?: number;
};

function primaryLease(rows: LeasePipelineRow[]): LeasePipelineRow | null {
  return rows[0] ?? null;
}

function resolveStage(input: ResidentLifecycleInput): ResidentLifecycleStageId {
  const lease = primaryLease(input.leaseRows);
  const app = input.application;
  const today = new Date();
  const todayIso = today.toISOString().slice(0, 10);

  if (input.directoryStage === "past") return "past";
  if (lease?.bucket === "signed") {
    const end = (lease as { leaseEnd?: string }).leaseEnd?.trim();
    if (end && end < todayIso) return "past";
    const start = (lease as { leaseStart?: string }).leaseStart?.trim();
    if (start && start > todayIso) return "signed";
    if (input.moveOutDate && input.moveOutDate < todayIso) return "past";
    if (input.moveOutInspectionOpen || input.hasMoveOutInspection) return "moving_out";
    return "current";
  }
  if (lease && (lease.bucket === "resident" || lease.bucket === "manager")) return "lease_sent";
  if (app?.bucket === "approved") return "approved";
  if (app) return "applicant";
  if ((input.tourCount ?? 0) > 0 || input.hasPendingTour) return "prospect";
  return "prospect";
}

function stepVisible(stage: ResidentLifecycleStageId, stepId: ResidentLifecycleStageId, input: ResidentLifecycleInput): boolean {
  const idx = STAGE_ORDER.indexOf(stage);
  const _stepIdx = STAGE_ORDER.indexOf(stepId);
  if (stepId === "prospect") return idx <= 3 || (input.tourCount ?? 0) > 0;
  if (stepId === "applicant" || stepId === "approved") {
    return idx <= 2 || Boolean(input.application && !input.application.manuallyAdded);
  }
  if (stepId === "moving_out" || stepId === "past") return idx >= STAGE_ORDER.indexOf("moving_out");
  return true;
}

export function buildResidentLifecycle(
  input: ResidentLifecycleInput,
  hrefs: {
    application: string;
    backgroundCheck: string;
    lease: string;
    payments: string;
    tours: string;
    inspections: string;
    services: string;
  },
): ResidentLifecycleSnapshot {
  const stage = resolveStage(input);
  const stageIdx = STAGE_ORDER.indexOf(stage);
  const lease = primaryLease(input.leaseRows);
  const app = input.application;

  const overdue = input.ledgerRows.filter((r) => r.bucket === "overdue");
  const unpaid = input.ledgerRows.filter((r) => r.bucket !== "paid");
  const balanceCents = unpaid.reduce((sum, r) => sum + chargeDueCents(r), 0);
  const overdueCents = overdue.reduce((sum, r) => sum + chargeDueCents(r), 0);

  const steps: ResidentLifecycleStep[] = STAGE_ORDER.filter((id) => stepVisible(stage, id, input)).map((id) => {
    const i = STAGE_ORDER.indexOf(id);
    const state: ResidentLifecycleStepState =
      i < stageIdx ? "done" : i === stageIdx ? "current" : "next";
    let date = "";
    if (id === "applicant" && app?.application?.submittedAt) date = formatResidentShortDate(app.application.submittedAt);
    if (id === "approved" && app?.bucket === "approved" && app.application?.submittedAt) {
      date = formatResidentShortDate(app.application.submittedAt);
    }
    if (id === "lease_sent" && lease?.sentToResidentAt) date = formatResidentShortDate(lease.sentToResidentAt);
    if (id === "signed" && lease?.fullySignedAt) date = formatResidentShortDate(lease.fullySignedAt);
    if (id === "current" && lease?.leaseStart) date = formatResidentShortDate(lease.leaseStart);
    if (id === "moving_out" && input.moveOutDate) date = formatResidentShortDate(input.moveOutDate);
    if (id === "past" && input.moveOutDate) date = formatResidentShortDate(input.moveOutDate);
    return { id, label: STAGE_LABELS[id], state, date: state !== "next" ? date : undefined };
  });

  let next: ResidentLifecycleAction | null = null;
  if (stage === "applicant" && app && app.bucket === "pending") {
    next = { kind: "navigate", href: hrefs.application, label: "Review application" };
  } else if (stage === "approved") {
    next = { kind: "navigate", href: hrefs.lease, label: "Send lease" };
  } else if (stage === "lease_sent" && lease?.bucket === "manager") {
    next = { kind: "callback", label: "Sign lease", actionId: "sign-lease" };
  } else if (stage === "current" && overdue.length > 0) {
    next = { kind: "navigate", href: hrefs.payments, label: "Collect balance" };
  } else if (stage === "past" && balanceCents > 0) {
    next = { kind: "navigate", href: hrefs.payments, label: "Collect balance" };
  }

  const todo: ResidentNeedsAttentionItem[] = [];
  let n = 0;
  const add = (item: Omit<ResidentNeedsAttentionItem, "rank"> & { rank: number }) => {
    todo.push({ ...item, id: item.id || `todo-${n++}` });
  };

  if (input.hasRequestedTour) {
    add({
      id: "tour-approve",
      icon: "tour",
      title: "Tour waiting for approval",
      fact: "Scheduled",
      urgent: false,
      rank: 1,
      href: hrefs.tours,
      inline: { label: "Approve", actionId: "approve-tour" },
    });
  }
  if (app?.bucket === "pending") {
    add({
      id: "app-review",
      icon: "application",
      title: "Application waiting for your review",
      fact: app.application?.submittedAt ? `Submitted ${formatResidentShortDate(app.application.submittedAt)}` : "Submitted",
      urgent: false,
      rank: 1,
      href: hrefs.application,
    });
  }
  if (app && app.bucket === "pending" && !app.application?.submittedAt) {
    add({
      id: "app-incomplete",
      icon: "application",
      title: "Application not finished",
      fact: "Not submitted",
      urgent: false,
      rank: 3,
      href: hrefs.application,
    });
  }
  if ((stage === "applicant" || stage === "approved") && !input.screeningRequested && app) {
    add({
      id: "bg-check",
      icon: "shield",
      title: "Background check not run",
      fact: "Not run",
      urgent: false,
      rank: 2,
      href: hrefs.backgroundCheck,
      inline: { label: "Run check", actionId: "run-background-check" },
    });
  }
  if (stage === "approved" && !lease) {
    add({
      id: "lease-missing",
      icon: "lease",
      title: "Lease not created",
      fact: "Approved",
      urgent: false,
      rank: 2,
      href: hrefs.lease,
    });
  }
  if (stage === "approved" && lease && lease.bucket === "manager") {
    add({
      id: "lease-draft",
      icon: "lease",
      title: "Lease not sent",
      fact: "Draft",
      urgent: false,
      rank: 2,
      href: hrefs.lease,
    });
  }
  if (stage === "lease_sent" && lease) {
    const waitingOnYou = lease.bucket === "manager";
    add({
      id: "lease-sign",
      icon: "lease",
      title: waitingOnYou ? "Lease waiting for your signature" : "Lease waiting for the resident to sign",
      fact: lease.sentToResidentAt ? `Sent ${formatResidentShortDate(lease.sentToResidentAt)}` : lease.stageLabel,
      urgent: waitingOnYou,
      rank: waitingOnYou ? 1 : 3,
      href: hrefs.lease,
    });
  }
  if (overdue.length > 0) {
    add({
      id: "overdue",
      icon: "payments",
      title: "Overdue rent",
      fact: `${formatResidentMoney(overdueCents)} past due`,
      urgent: true,
      rank: 0,
      href: hrefs.payments,
    });
  } else if (stage === "past" && balanceCents > 0) {
    add({
      id: "balance",
      icon: "payments",
      title: "Unpaid balance",
      fact: formatResidentMoney(balanceCents),
      urgent: true,
      rank: 0,
      href: hrefs.payments,
    });
  }
  if (!input.hasPortalAccount && input.directoryStage === "potential") {
    add({
      id: "no-login",
      icon: "user-plus",
      title: "No PropLane login",
      fact: "Send invite",
      urgent: false,
      rank: 4,
      inline: { label: "Send invite", actionId: "send-setup" },
    });
  }

  todo.sort((a, b) => a.rank - b.rank || 0);

  const rentCents =
    input.signedMonthlyRent != null ? Math.round(input.signedMonthlyRent * 100) : 0;
  const income = input.monthlyIncome ?? 0;

  let kpiCandidates: Array<[string, string]> = [];
  if (stageIdx <= STAGE_ORDER.indexOf("approved") && !lease) {
    kpiCandidates = [
      ["Tour", input.hasPendingTour ? "Scheduled" : ""],
      ["Desired move-in", formatResidentShortDate(input.moveInDate)],
      ["Room", input.roomLabel ?? ""],
      ["Income", income > 0 ? `${formatResidentMoney(Math.round(income * 100))}/mo` : ""],
    ];
  } else if (stageIdx <= STAGE_ORDER.indexOf("signed")) {
    const leaseWord =
      lease?.bucket === "manager"
        ? "Manager review"
        : lease?.bucket === "resident"
          ? "Resident signature"
          : lease?.bucket === "signed"
            ? "Signed"
            : "";
    kpiCandidates = [
      ["Rent", rentCents > 0 ? `${formatResidentMoney(rentCents)}/mo` : ""],
      ["Lease", leaseWord],
      ["Move in", formatResidentShortDate(input.moveInDate ?? (lease as { leaseStart?: string })?.leaseStart)],
      ["Room", input.roomLabel ?? ""],
    ];
  } else if (stage === "past") {
    kpiCandidates = [
      ["Balance", formatResidentMoney(balanceCents)],
      ["Rent", rentCents > 0 ? `${formatResidentMoney(rentCents)}/mo` : ""],
      ["Moved out", formatResidentShortDate(input.moveOutDate)],
    ];
  } else {
    const nextCharge = unpaid
      .filter((r) => r.bucket === "pending")
      .sort((a, b) => (a.dueDateSortMs ?? 0) - (b.dueDateSortMs ?? 0))[0];
    kpiCandidates = [
      ["Balance", formatResidentMoney(balanceCents)],
      ["Rent", rentCents > 0 ? `${formatResidentMoney(rentCents)}/mo` : ""],
      [
        stage === "moving_out" ? "Moves out" : "Lease ends",
        formatResidentShortDate(input.moveOutDate ?? (lease as { leaseEnd?: string })?.leaseEnd),
      ],
      ["Next payment", nextCharge ? formatResidentShortDate(nextCharge.dueDate) : ""],
    ];
  }

  const kpiTiles = kpiCandidates.filter(([, v]) => v).slice(0, 4).map(([label, value]) => ({ label, value }));

  let headerFact = "";
  if (stage === "applicant") {
    headerFact = app && !app.application?.submittedAt ? "application in progress" : app?.application?.submittedAt
      ? `applied ${formatResidentShortDate(app.application.submittedAt)}`
      : "";
  } else if (stage === "approved" && app?.application?.submittedAt) {
    headerFact = `approved ${formatResidentShortDate(app.application.submittedAt)}`;
  } else if (stage === "lease_sent" && lease?.sentToResidentAt) {
    headerFact = `lease sent ${formatResidentShortDate(lease.sentToResidentAt)}`;
  } else if (stage === "signed" && lease?.fullySignedAt) {
    headerFact = `signed ${formatResidentShortDate(lease.fullySignedAt)}`;
  } else if (stage === "current" && (lease as { leaseStart?: string })?.leaseStart) {
    headerFact = `since ${formatResidentShortDate((lease as { leaseStart?: string }).leaseStart)}`;
  } else if (stage === "moving_out" && input.moveOutDate) {
    headerFact = `moves out ${formatResidentShortDate(input.moveOutDate)}`;
  } else if (stage === "past" && input.moveOutDate) {
    headerFact = `moved out ${formatResidentShortDate(input.moveOutDate)}`;
  }

  return {
    stage,
    stageLabel: STAGE_LABELS[stage],
    headerFact,
    steps,
    next,
    todo,
    kpiTiles,
    balanceCents,
  };
}

export function residentHeaderStageLine(snapshot: ResidentLifecycleSnapshot): string {
  const fact = snapshot.headerFact.trim();
  return fact ? `${snapshot.stageLabel} · ${fact}` : snapshot.stageLabel;
}
