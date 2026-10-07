/**
 * The Vendors section of a service as ONE pipeline, for both models (maintenance work order and an
 * add-on's linked vendor job): Available - Sent - Bids - Scheduled - Done.
 *
 * Pure bucketing over the rows already loaded (offers, bids, the job row, the manager's roster); the
 * component renders it and the host owns every write. Nothing here invents state: a vendor is
 * Available until the manager has offered them the job, Sent while their offer is out (or they have
 * only given an estimate), a Bid once a real bid is submitted (the only thing that can be approved),
 * Scheduled once their bid is approved, Done once the job is finished.
 */
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import type { WorkOrderBid } from "@/lib/work-order-bids";
import type { WorkOrderVendorOffer } from "@/lib/work-order-vendor-offers";
import { deriveVendorRequestRows, serviceIsVendorPayable, type VendorRequestRow } from "@/lib/work-order-bid-cycle";
import { formatServiceMoney, resolveWorkOrderAssignee } from "@/lib/manager-service-workflow";
import { completedPaymentFact } from "@/lib/service-lifecycle";

export const PIPELINE_TABS = ["available", "sent", "bids", "scheduled", "done"] as const;
export type PipelineTabId = (typeof PIPELINE_TABS)[number];

export const PIPELINE_TAB_LABEL: Record<PipelineTabId, string> = {
  available: "Available",
  sent: "Sent",
  bids: "Bids",
  scheduled: "Scheduled",
  done: "Done",
};

/** One send reaches at most this many vendors (the server caps it too: `MAX_VENDORS_PER_SEND`). */
export const MAX_VENDORS_PER_JOB_SEND = 10;

/** The radii the Send job popup offers for "Also send to PropLane vendors within". */
export const JOB_SEND_RADIUS_OPTIONS = [5, 10, 25] as const;

export type PipelineRosterVendor = {
  id: string;
  name: string;
  trade?: string | null;
  active?: boolean;
  /** The vendor's review rating, when they have reviews. */
  rating?: { average: number; count: number } | null;
  city?: string | null;
  /** How the vendor reached the roster; a text link or the work board (vendor-work-share-1006). */
  origin?: VendorOrigin | null;
  /** The server holds their phone / email until they bid, so the row has none yet. */
  contactHeldUntilBid?: boolean;
};

export type VendorOrigin = "service_link" | "work_board";

/** The plain fact a Sent / Bids row draws for where the vendor came from. */
export const VENDOR_ORIGIN_FACT: Record<VendorOrigin, string> = {
  service_link: "From your text link",
  work_board: "From the work board",
};
export const CONTACT_HELD_FACT = "Contact shown after they bid";

/** A Sent / Bids row plus the extra facts a link / board vendor carries (absent for every other vendor). */
export type PipelineRequestRow = VendorRequestRow & {
  originFact?: string;
  contactFact?: string;
};

/** The origin / held-contact facts for one pipeline row; Sent rows show the held-contact fact, Bids rows never do. */
export function requestRowFacts(
  vendor: Pick<PipelineRosterVendor, "origin" | "contactHeldUntilBid"> | undefined,
  group: "sent" | "bids",
): { originFact?: string; contactFact?: string } {
  if (!vendor) return {};
  const out: { originFact?: string; contactFact?: string } = {};
  if (vendor.origin && VENDOR_ORIGIN_FACT[vendor.origin]) out.originFact = VENDOR_ORIGIN_FACT[vendor.origin];
  if (group === "sent" && vendor.contactHeldUntilBid === true) out.contactFact = CONTACT_HELD_FACT;
  return out;
}

export type PipelineCandidate = {
  id: string;
  name: string;
  trade: string;
  /** The vendor's trade matches the job's. */
  matchesTrade: boolean;
  rating?: { average: number; count: number } | null;
  city?: string;
};

/** A row under Scheduled or Done: the approved vendor plus what the job itself says. */
export type PipelineJobRow = {
  key: string;
  vendorName: string;
  vendorDirectoryId: string | null;
  /** The approved bid's row, when the vendor came through the bid cycle. */
  request: VendorRequestRow | null;
  visitAt: string | null;
  amountCents: number | null;
  /** Done only: "To pay" or "Paid". */
  paymentFact: "To pay" | "Paid" | null;
  canPay: boolean;
  /** The vendor said they finished; the manager has not confirmed it yet, so Mark done is still theirs to do. */
  vendorSaysDone?: boolean;
};

export type ServicePipeline = {
  available: PipelineCandidate[];
  /** Offers out, estimates given, visits booked and vendors who declined - nobody has bid yet. */
  sent: PipelineRequestRow[];
  /** Submitted bids, each approvable. */
  bids: PipelineRequestRow[];
  scheduled: PipelineJobRow[];
  done: PipelineJobRow[];
  counts: Record<PipelineTabId, number>;
  /** True when no roster vendor matched the job's trade, so every roster vendor is offered instead. */
  availableIsUnfiltered: boolean;
};

type PipelineJob = Pick<
  DemoManagerWorkOrderRow,
  "bucket" | "status" | "scheduledAtIso" | "automationStatus" | "vendorId" | "vendorName" | "vendorCostCents" | "materialsCostCents" | "cost" | "selfAssigned" | "assignee"
>;

function normalizeTrade(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function tradeMatches(vendorTrade: string, jobTrade: string): boolean {
  if (!jobTrade) return true;
  if (!vendorTrade) return false;
  return vendorTrade === jobTrade || vendorTrade.includes(jobTrade) || jobTrade.includes(vendorTrade);
}

function jobIsCancelled(job: PipelineJob): boolean {
  return (job.status ?? "").trim().toLowerCase() === "cancelled";
}

export function jobIsFinished(job: PipelineJob): boolean {
  if (jobIsCancelled(job)) return false;
  return job.bucket === "completed" || job.automationStatus === "vendor_marked_done" || job.automationStatus === "paid";
}

function jobAmountCents(job: PipelineJob, request: VendorRequestRow | null): number | null {
  if (request?.bidTotalCents != null) return request.bidTotalCents;
  if (job.vendorCostCents != null) return job.vendorCostCents + (job.materialsCostCents ?? 0);
  const parsed = Number.parseFloat((job.cost ?? "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * 100) : null;
}

/**
 * Bucket one job's vendors. `jobTrade` narrows the roster to vendors who do this kind of work; a
 * roster with no match falls back to everyone so the manager is never left with an empty Available.
 */
export function buildServicePipeline(input: {
  job: PipelineJob | null;
  offers: readonly WorkOrderVendorOffer[];
  bids: readonly WorkOrderBid[];
  roster: readonly PipelineRosterVendor[];
  jobTrade?: string;
}): ServicePipeline {
  const { job, offers, bids } = input;
  const requests = deriveVendorRequestRows(bids, offers);
  const cancelled = job ? jobIsCancelled(job) : false;
  const finished = job ? jobIsFinished(job) : false;

  // Anyone the job already went to (an open offer, an answer, an approval) is not Available again.
  const offered = new Set<string>();
  for (const request of requests) if (request.vendorDirectoryId) offered.add(request.vendorDirectoryId);

  const jobTrade = normalizeTrade(input.jobTrade);
  const active = input.roster.filter((vendor) => vendor.id?.trim() && vendor.active !== false && !offered.has(vendor.id));
  const decorated: PipelineCandidate[] = active.map((vendor) => {
    const trade = (vendor.trade ?? "").trim();
    return {
      id: vendor.id,
      name: vendor.name?.trim() || "Vendor",
      trade,
      matchesTrade: tradeMatches(normalizeTrade(trade), jobTrade),
      rating: vendor.rating ?? null,
      city: vendor.city?.trim() || undefined,
    };
  });
  const matched = decorated.filter((vendor) => vendor.matchesTrade);
  const availableIsUnfiltered = matched.length === 0 && decorated.length > 0;
  const available = (availableIsUnfiltered ? decorated : matched).sort((a, b) => a.name.localeCompare(b.name));

  const approved = requests.find((request) => request.state === "approved") ?? null;
  const bidRows = requests.filter((request) => request.state === "bid");
  // Nothing is pending once a vendor is hired or the job is closed out: open offers read as Sent only before that.
  const rosterById = new Map(input.roster.map((vendor) => [vendor.id, vendor]));
  const withFacts = (rows: VendorRequestRow[], group: "sent" | "bids"): PipelineRequestRow[] =>
    rows.map((row) => {
      const facts = requestRowFacts(row.vendorDirectoryId ? rosterById.get(row.vendorDirectoryId) : undefined, group);
      return facts.originFact || facts.contactFact ? { ...row, ...facts } : row;
    });
  const sent = approved || finished || cancelled ? [] : withFacts(requests.filter((request) => request.state !== "bid" && request.state !== "approved"), "sent");
  const bidsOpen = approved || finished || cancelled ? [] : withFacts(bidRows, "bids");

  const assignee = job ? resolveWorkOrderAssignee(job as DemoManagerWorkOrderRow) : null;
  const vendorName = approved?.vendorName ?? (assignee?.kind === "vendor" ? assignee.name : "");
  const hired = Boolean(approved) || (assignee?.kind === "vendor" && Boolean(vendorName));
  const hiredRow = (): PipelineJobRow => {
    const paid = job?.automationStatus === "paid";
    return {
      key: approved?.key ?? `job-${job?.vendorId ?? vendorName}`,
      vendorName: vendorName || "Vendor",
      vendorDirectoryId: approved?.vendorDirectoryId ?? job?.vendorId ?? null,
      request: approved,
      visitAt: job?.scheduledAtIso ?? approved?.proposedTime ?? null,
      amountCents: job ? jobAmountCents(job, approved) : (approved?.bidTotalCents ?? null),
      paymentFact: finished && job
        ? completedPaymentFact({ vendorPayable: serviceIsVendorPayable(job as DemoManagerWorkOrderRow), paid })
        : null,
      canPay: finished && Boolean(job) && !paid && serviceIsVendorPayable(job as DemoManagerWorkOrderRow),
      vendorSaysDone: job?.automationStatus === "vendor_marked_done" && job?.bucket !== "completed",
    };
  };
  const scheduled = hired && !finished && !cancelled ? [hiredRow()] : [];
  const done = hired && finished ? [hiredRow()] : [];

  return {
    available,
    sent,
    bids: bidsOpen,
    scheduled,
    done,
    availableIsUnfiltered,
    counts: {
      available: available.length,
      sent: sent.length,
      bids: bidsOpen.length,
      scheduled: scheduled.length,
      done: done.length,
    },
  };
}

/** The tab the section opens on: where the job actually is. */
export function defaultPipelineTab(counts: Record<PipelineTabId, number>): PipelineTabId {
  if (counts.done > 0) return "done";
  if (counts.scheduled > 0) return "scheduled";
  if (counts.bids > 0) return "bids";
  if (counts.sent > 0) return "sent";
  return "available";
}

/** One line of what a Scheduled / Done row says: the visit time and the money, plain facts. */
export function pipelineJobFact(row: PipelineJobRow, formatWhen: (iso: string | null | undefined) => string): string {
  const when = row.visitAt ? formatWhen(row.visitAt) : "";
  return [
    row.vendorSaysDone ? "Vendor says done" : "",
    row.paymentFact ?? "",
    when || (row.paymentFact || row.vendorSaysDone ? "" : "No visit time yet"),
    row.amountCents != null ? formatServiceMoney(row.amountCents) : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The Send job popup's button: how many are picked, capped, and the label it shows. */
export function sendBarState(selectedCount: number, marketplace: boolean): { count: number; label: string; disabled: boolean; capped: boolean } {
  const count = Math.min(selectedCount, MAX_VENDORS_PER_JOB_SEND);
  const picked = count + (marketplace ? 1 : 0);
  return {
    count,
    label: count > 0 ? `Send job to ${count}` : marketplace ? "Send job to PropLane vendors" : "Send job",
    disabled: picked === 0,
    capped: selectedCount > MAX_VENDORS_PER_JOB_SEND,
  };
}
