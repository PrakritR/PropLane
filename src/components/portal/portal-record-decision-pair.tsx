"use client";

import { CheckCircle2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { RecordHeaderAction } from "@/lib/portals/record-sections";

/**
 * The decision pair (approved redesign, dashboard-redesign-1007): a record whose
 * tab is waiting on a yes/no draws it as the ONE labelled pair in the header —
 * a red-outline "Decline" then a solid green "Approve" — behind a hairline
 * divider. Every other header action stays an icon. These are the only labelled
 * buttons a record header carries (a decision is a commit, not utility chrome).
 */
export const RECORD_POSITIVE_DECISION_IDS = ["approve", "confirm"] as const;
export const RECORD_NEGATIVE_DECISION_IDS = ["decline", "reject"] as const;

/** Splits a record's header actions into the plain icon actions and its decision pair. */
export function splitRecordDecisionActions(actions: readonly RecordHeaderAction[]): {
  rest: RecordHeaderAction[];
  positive?: RecordHeaderAction;
  negative?: RecordHeaderAction;
} {
  const positive = actions.find((a) => (RECORD_POSITIVE_DECISION_IDS as readonly string[]).includes(a.id));
  const negative = actions.find((a) => (RECORD_NEGATIVE_DECISION_IDS as readonly string[]).includes(a.id));
  return {
    rest: actions.filter((a) => a !== positive && a !== negative),
    positive,
    negative,
  };
}

export function PortalRecordDecisionPair({
  positive,
  negative,
  onAction,
  dataAttrPrefix = "record-decision",
}: {
  positive?: RecordHeaderAction;
  negative?: RecordHeaderAction;
  onAction?: (actionId: string) => unknown;
  /** `data-attr` stem; the action id is appended. */
  dataAttrPrefix?: string;
}) {
  if (!positive && !negative) return null;
  return (
    <div
      data-slot="portal-record-decision-pair"
      role="group"
      aria-label="Decision"
      className="ml-1.5 flex shrink-0 items-center gap-1.5 border-l border-[var(--pl-line,rgba(17,24,39,0.085))] pl-3"
    >
      {negative ? (
        <Button
          variant="outline"
          data-attr={`${dataAttrPrefix}-${negative.id}`}
          className="!border-[#d92d20] !bg-white !text-[#d92d20] hover:!bg-[#fef3f2]"
          onClick={() => onAction?.(negative.id)}
        >
          <XCircle className="size-4" aria-hidden />
          {negative.label}
        </Button>
      ) : null}
      {positive ? (
        <Button
          data-attr={`${dataAttrPrefix}-${positive.id}`}
          className="hover:!brightness-95"
          style={{ background: "#12805c" }}
          onClick={() => onAction?.(positive.id)}
        >
          <CheckCircle2 className="size-4" aria-hidden />
          {positive.label}
        </Button>
      ) : null}
    </div>
  );
}
