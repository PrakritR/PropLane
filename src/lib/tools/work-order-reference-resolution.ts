import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { resolveWorkOrderReference } from "@/lib/work-order-reference";
import type { AgentContext } from "@/lib/tools/context";
import type { ResidentAgentContext } from "@/lib/tools/resident-context";
import type { VendorAgentContext } from "@/lib/tools/vendor-context";
import { loadManagerWorkOrders } from "@/lib/tools/domains/work-orders";
import { loadResidentEmailRows } from "@/lib/tools/domains/resident/load-resident-rows";
import { loadVendorWorkOrders } from "@/lib/tools/domains/vendor/load-vendor-rows";

export type WorkOrderReferenceCandidate = {
  id: string;
  reference: string;
  title: string;
  propertyName: string;
  unit: string;
  status: string;
};

export type WorkOrderReferenceResolution =
  | { kind: "no_reference"; candidates: []; message: null }
  | { kind: "not_found"; candidates: []; message: string }
  | { kind: "resolved"; candidates: [WorkOrderReferenceCandidate]; message: null }
  | { kind: "ambiguous"; candidates: WorkOrderReferenceCandidate[]; message: string };

export function workOrderReferencePromptContext(
  resolution: WorkOrderReferenceResolution,
): string | null {
  if (resolution.kind !== "resolved") return null;
  const match = resolution.candidates[0];
  return [
    "Scoped work-order reference context:",
    `- The sender's ${match.reference} resolves to internal work-order id ${match.id}.`,
    `- Current status: ${match.status || "not set"}.`,
    `- Job: ${match.title}${match.propertyName ? ` at ${match.propertyName}${match.unit ? ` ${match.unit}` : ""}` : ""}.`,
    "Use that internal id for any tool input. Answer the current status and the single next step relevant to the sender's request. Any write still uses this surface's existing confirmation rules.",
  ].join("\n");
}

function candidate(row: DemoManagerWorkOrderRow): WorkOrderReferenceCandidate {
  return {
    id: row.id,
    reference: row.reference!,
    title: row.title || "Untitled work order",
    propertyName: row.propertyName || "",
    unit: row.unit || "",
    status: row.status || "",
  };
}

/** Match claims only against rows the caller has already been authorized to see. */
export function resolveVisibleWorkOrderReference(
  text: string,
  visibleRows: readonly DemoManagerWorkOrderRow[],
): WorkOrderReferenceResolution {
  const references = resolveWorkOrderReference(text);
  if (references.length === 0) return { kind: "no_reference", candidates: [], message: null };

  const wanted = new Set(references);
  const matches = visibleRows
    .filter((row) => row.reference && wanted.has(row.reference.toUpperCase()))
    .map(candidate);

  if (matches.length === 0) {
    return { kind: "not_found", candidates: [], message: "We can't find that work order." };
  }
  if (matches.length === 1) return { kind: "resolved", candidates: [matches[0]!], message: null };

  const choices = matches
    .map((match) => {
      const location = [match.propertyName, match.unit].filter(Boolean).join(" · ");
      return `${match.reference} (${[match.title, location].filter(Boolean).join(", ")})`;
    })
    .join(" or ");
  return { kind: "ambiguous", candidates: matches, message: `Did you mean ${choices}?` };
}

/** Manager portal/SMS scope, including the existing delegated-property filter. */
export async function resolveManagerWorkOrderReference(
  ctx: AgentContext,
  text: string,
): Promise<WorkOrderReferenceResolution> {
  return resolveVisibleWorkOrderReference(text, await loadManagerWorkOrders(ctx));
}

/** Resident scope: email plus the active manager when the request came by SMS. */
export async function resolveResidentWorkOrderReference(
  ctx: ResidentAgentContext,
  text: string,
): Promise<WorkOrderReferenceResolution> {
  const rows = await loadResidentEmailRows(
    ctx,
    "portal_work_order_records",
    (rowData) => rowData as DemoManagerWorkOrderRow,
  );
  return resolveVisibleWorkOrderReference(text, rows);
}

/** Vendor scope: assigned jobs plus still-live offers, never the full table. */
export async function resolveVendorWorkOrderReference(
  ctx: VendorAgentContext,
  text: string,
): Promise<WorkOrderReferenceResolution> {
  const jobs = await loadVendorWorkOrders(ctx);
  return resolveVisibleWorkOrderReference(text, jobs.map((job) => job.row));
}
