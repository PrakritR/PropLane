import type { LucideIcon } from "lucide-react";
import { AlertCircle, Ban, Calendar, CalendarDays, Check, CircleCheck, Clock, Scale, UserCheck, UserRound, Users, Wallet } from "lucide-react";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import {
  managerServiceListStageLabel,
  type ManagerServiceAssignee,
  resolveWorkOrderAssignee,
} from "@/lib/manager-service-workflow";
import { formatPortalRowDate } from "@/lib/portal-display-dates";
import { serviceShortWhen } from "@/lib/service-time-labels";

/** Resident · property · room — assignee is a row fact, not part of the place line. */
export function managerServicePlaceLine(
  row: {
    residentName?: string | null;
    residentEmail?: string | null;
    propertyLabel?: string;
    unitLabel?: string | null;
  },
): string {
  const resident = row.residentName?.trim() || row.residentEmail?.trim() || "";
  const parts = [resident, row.propertyLabel, row.unitLabel?.trim() || null].filter(Boolean);
  return parts.join(" · ");
}

export function managerServiceAssigneeFact(
  assignee: ManagerServiceAssignee,
): { icon: LucideIcon; text: string } | null {
  if (!assignee) return null;
  if (assignee.kind === "team") {
    return { icon: UserRound, text: `${assignee.name} · Team` };
  }
  return { icon: Users, text: assignee.name };
}

/** Stage label duplicates the assignee fact when hire is already shown by name. */
export function managerServiceStageFactRedundantWithAssignee(
  assignee: ReturnType<typeof resolveWorkOrderAssignee>,
  stageText: string,
): boolean {
  if (!assignee) return false;
  const t = stageText.trim().toLowerCase();
  return t === "hired" || t === "assigned";
}

/** One glyph fact per list row — stage when it carries the signal, else assignee. */
export function managerServiceListGlyphFact(
  assignee: ManagerServiceAssignee,
  stageFact: { icon: LucideIcon; text: string },
): { icon: LucideIcon; text: string } | null {
  const showStage =
    Boolean(stageFact.text) &&
    !managerServiceStageFactRedundantWithAssignee(assignee, stageFact.text);
  if (showStage) return stageFact;
  const assigneeFact = managerServiceAssigneeFact(assignee);
  if (assigneeFact) return assigneeFact;
  return stageFact.text ? stageFact : null;
}

export function managerServiceStageFact(
  row: DemoManagerWorkOrderRow,
  bidCount: number,
): { icon: LucideIcon; text: string } {
  const label = managerServiceListStageLabel(row, bidCount);
  const lower = label.toLowerCase();
  let icon: LucideIcon = Clock;
  if (!resolveWorkOrderAssignee(row) && bidCount === 0 && !row.biddingOpen) {
    icon = AlertCircle;
    return { icon, text: "Unassigned" };
  }
  if (lower.includes("quote") || lower.includes("bid")) icon = Scale;
  else if (lower.startsWith("scheduled")) icon = Calendar;
  else if (lower.includes("paid") || lower.includes("done")) icon = Check;
  else if (lower.includes("payment") || lower.includes("invoice") || lower.includes("awaiting")) icon = Wallet;
  else if (lower.includes("hired") || lower.includes("assigned")) icon = UserRound;
  else if (lower.includes("published")) icon = Users;
  return { icon, text: label };
}

/**
 * What a Services card row says, in the Payments row's slots: the requester's
 * name as the title (the service itself when nobody requested it), "service ·
 * property · room" as the place line, and one dated fact — when it is scheduled
 * or, failing that, when it was requested. The tab already says the bucket, so
 * no status word rides on the row.
 */
export function managerServiceCardParts(
  row: {
    title: string;
    residentName?: string | null;
    residentEmail?: string | null;
    propertyLabel?: string | null;
    unitLabel?: string | null;
    scheduledIso?: string | null;
    createdIso?: string | null;
  },
  opts: { omitProperty?: boolean; nowMs?: number } = {},
): {
  /** The row title: always the service. */
  name: string;
  /** The resident's name (or email), when there is one. */
  person: string;
  hasPerson: boolean;
  placeLine: string;
  dateFact: { verb: "Scheduled" | "Requested"; date: string; text: string } | null;
} {
  const person = row.residentName?.trim() || row.residentEmail?.trim() || "";
  const placeLine = [opts.omitProperty ? null : row.propertyLabel?.trim() || null, row.unitLabel?.trim() || null]
    .filter(Boolean)
    .join(" · ");
  const scheduled = formatPortalRowDate(row.scheduledIso, opts.nowMs);
  const requested = formatPortalRowDate(row.createdIso, opts.nowMs);
  const dateFact = scheduled
    ? { verb: "Scheduled" as const, date: scheduled, text: `Scheduled ${scheduled}` }
    : requested
      ? { verb: "Requested" as const, date: requested, text: `Requested ${requested}` }
      : null;
  return { name: row.title, person, hasPerson: Boolean(person), placeLine, dateFact };
}

/**
 * The two plain facts a manager Services row carries beside the resident, by tab:
 * Open "Requested Sep 25", Assigned "Assigned to Rapid Pipes", Scheduled "Wed, Oct 8 · 9am",
 * Completed "Completed Sep 27" (Declined "Declined Sep 27"), and the money state as a fact too
 * ("Bill $152 unpaid" / "Paid"). Never a pill; the tab already says the bucket.
 */
export function managerServiceRowFacts(input: {
  state: "open" | "assigned" | "scheduled" | "completed" | "declined";
  createdIso?: string | null;
  /** The visit time: a booked one, or the suggested one for an add-on. */
  scheduledIso?: string | null;
  completedIso?: string | null;
  assigneeName?: string | null;
  /** The bill, once there is one: its amount and whether it is settled. */
  bill?: { amount: string; paid: boolean } | null;
  nowMs?: number;
}): { stage: { icon: LucideIcon; text: string }; money: { icon: LucideIcon; text: string } | null } {
  const dated = (verb: string, iso: string | null | undefined) => {
    const date = formatPortalRowDate(iso, input.nowMs);
    return date ? `${verb} ${date}` : verb;
  };
  let stage: { icon: LucideIcon; text: string };
  switch (input.state) {
    case "assigned": {
      const who = input.assigneeName?.trim();
      stage = { icon: UserCheck, text: who ? `Assigned to ${who}` : "Assigned" };
      break;
    }
    case "scheduled":
      stage = { icon: CalendarDays, text: serviceShortWhen(input.scheduledIso) || dated("Scheduled", input.scheduledIso) };
      break;
    case "completed":
      stage = { icon: CircleCheck, text: dated("Completed", input.completedIso) };
      break;
    case "declined":
      stage = { icon: Ban, text: dated("Declined", input.completedIso) };
      break;
    default:
      stage = { icon: Clock, text: dated("Requested", input.createdIso) };
  }
  const bill = input.bill;
  const money = bill ? { icon: Wallet, text: bill.paid ? "Paid" : `Bill ${bill.amount} unpaid` } : null;
  return { stage, money };
}

/** An add-on's price as the row's right-hand figure; nothing when it has none (a custom request awaiting a quote). */
export function managerServiceRequestCardFigure(req: { price?: string | null }): string | undefined {
  const raw = req.price?.trim();
  if (!raw || !/\d/.test(raw)) return undefined;
  if (/^\d[\d,]*(\.\d+)?$/.test(raw)) return `$${raw}`;
  return raw;
}
