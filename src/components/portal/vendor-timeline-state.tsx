import { Check, Clock, Minus, X } from "lucide-react";
import { PortalRowFact } from "@/components/portal/portal-record-row";

export type VendorTimelineStateName = "done" | "pending" | "failed" | "skipped";

/**
 * A timeline step's state as a plain glyph fact (Done · Pending · Rejected · Skipped), never a
 * `Badge` pill - the same fact shape every record row uses.
 */
export function VendorTimelineState({ state, failedLabel = "Failed" }: { state: VendorTimelineStateName; failedLabel?: string }) {
  switch (state) {
    case "done":
      return <PortalRowFact icon={Check} tone="ok">Done</PortalRowFact>;
    case "failed":
      return <PortalRowFact icon={X} tone="danger">{failedLabel}</PortalRowFact>;
    case "skipped":
      return <PortalRowFact icon={Minus}>Skipped</PortalRowFact>;
    default:
      return <PortalRowFact icon={Clock}>Pending</PortalRowFact>;
  }
}
