"use client";

import { useState } from "react";
import { Ban, Megaphone, RotateCcw, Send } from "lucide-react";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { RecordFactCard, RecordFactRow } from "@/components/portal/portal-record-overview-kit";
import { Button } from "@/components/ui/button";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { postDispatchRunAction, runForSource, useDispatchRuns } from "@/lib/vendor-dispatch/dispatch-client";
import { formatRulePay } from "@/lib/vendor-dispatch/rules";
import {
  DISPATCH_ATTEMPT_STATUS_LABEL,
  DISPATCH_RUN_STATUS_LABEL,
  dispatchRunActions,
  type DispatchRunAction,
  type DispatchRunView,
} from "@/lib/vendor-dispatch/runs-view";
import { issueDefinition, tradeDefinition } from "@/lib/vendor-dispatch/trades";
import { formatServiceWhen } from "@/lib/service-lifecycle";

const ACTION_DONE: Record<DispatchRunAction, string> = {
  approve: "Approved. Offering now.",
  pick: "Sent to that vendor.",
  decline: "Declined.",
  retry: "Offering again.",
  broadcast: "Offered to every vendor.",
  cancel: "Canceled.",
};

/** The pay line: the run's own figure, "Quote" when none. */
function runPay(run: DispatchRunView): string {
  const base = run.payCents == null ? "Quote" : formatRulePay(run.payCents, "flat");
  return run.nteCents != null ? `${base}, up to ${formatRulePay(run.nteCents, "flat")}` : base;
}

/**
 * The Dispatch section on a service record's Overview (vendor-dispatch-1018):
 * where the run stands in plain words, who approved it and when, and each
 * attempt (vendor, answer, time). Not a service stage: the services vocabulary
 * stays Open, Assigned, Scheduled, Completed. Renders nothing when the service
 * has no run, or when the viewer has no dispatch access.
 */
export function ServiceDispatchSection({
  sourceType,
  sourceId,
}: {
  sourceType: "work_order" | "service_request";
  sourceId: string;
}) {
  const { runs, loading } = useDispatchRuns({ sourceType, sourceId });
  const { showToast, confirm } = useAppUi();
  const [busy, setBusy] = useState<string | null>(null);
  const run = runForSource(runs);
  if (loading || !run) return null;

  const actions = dispatchRunActions(run.status);
  const trade = tradeDefinition(run.trade)?.label ?? "Job";
  const issue = issueDefinition(run.trade, run.issue)?.label;

  const act = async (action: DispatchRunAction, position?: number) => {
    if (busy) return;
    if (action === "decline" || action === "cancel") {
      const ok = await confirm({
        title: action === "decline" ? "Decline dispatch" : "Cancel dispatch",
        description: action === "decline" ? "Nobody will be texted about this job." : "Stop offering this job to vendors?",
        confirmLabel: action === "decline" ? "Decline" : "Cancel dispatch",
        dataAttr: `dispatch-${action}-confirm`,
      });
      if (!ok) return;
    }
    setBusy(`${action}:${position ?? ""}`);
    const result = await postDispatchRunAction(run.id, action, position);
    setBusy(null);
    showToast(result.ok ? ACTION_DONE[action] : result.error);
  };

  const attempts = run.attempts.slice().sort((a, b) => a.wave - b.wave || a.position - b.position);
  const canPick = actions.includes("pick");

  return (
    <RecordFactCard
      title="Dispatch"
      dataAttr="service-dispatch"
      headerActions={
        <>
          {actions.includes("retry") ? (
            <PortalIconAction
              icon={RotateCcw}
              label="Try again"
              disabled={busy !== null}
              onClick={() => void act("retry")}
              data-attr="dispatch-retry"
            />
          ) : null}
          {actions.includes("broadcast") ? (
            <PortalIconAction
              icon={Megaphone}
              label="Offer to all"
              disabled={busy !== null}
              onClick={() => void act("broadcast")}
              data-attr="dispatch-broadcast"
            />
          ) : null}
          {actions.includes("cancel") ? (
            <PortalIconAction
              icon={Ban}
              label="Cancel dispatch"
              tone="danger"
              disabled={busy !== null}
              onClick={() => void act("cancel")}
              data-attr="dispatch-cancel"
            />
          ) : null}
        </>
      }
    >
      <RecordFactRow label="Status" value={DISPATCH_RUN_STATUS_LABEL[run.status]} tone={run.status === "exhausted" ? "bad" : undefined} />
      <RecordFactRow label="Job" value={issue ? `${trade} · ${issue}` : trade} />
      <RecordFactRow label="Pay" value={runPay(run)} />
      {run.approvedAt ? (
        <RecordFactRow
          label="Approved"
          value={[run.approvedByName, run.approvalChannel === "sms" ? "by text" : null, formatServiceWhen(run.approvedAt)]
            .filter(Boolean)
            .join(" · ")}
        />
      ) : null}
      {run.acceptedVendorName ? (
        <RecordFactRow
          label="Vendor"
          value={[run.acceptedVendorName, run.acceptedAt ? formatServiceWhen(run.acceptedAt) : null].filter(Boolean).join(" · ")}
        />
      ) : null}
      {attempts.length > 0 ? (
        <ol className="border-t border-border px-[var(--portal-card-padding,14px)] py-2" data-attr="dispatch-attempts">
          {attempts.map((attempt) => {
            const when = attempt.respondedAt ?? attempt.offeredAt;
            return (
              <li
                key={attempt.id}
                className="flex min-h-9 items-center gap-2 py-1 text-[13.5px]"
                data-attr="dispatch-attempt"
                data-attempt-status={attempt.status}
              >
                <span className="min-w-0 flex-1">
                  <span className="font-medium text-foreground">{attempt.vendorName}</span>
                  <span className="text-muted"> · {DISPATCH_ATTEMPT_STATUS_LABEL[attempt.status]}</span>
                  {when ? <span className="ml-1.5 text-[12px] text-muted/75">{formatServiceWhen(when)}</span> : null}
                  {attempt.responseText ? <span className="block truncate text-[12.5px] text-muted">{attempt.responseText}</span> : null}
                </span>
                {canPick && attempt.status === "queued" ? (
                  <PortalIconAction
                    icon={Send}
                    label="Send only to this vendor"
                    ariaLabel={`Send only to ${attempt.vendorName}`}
                    disabled={busy !== null}
                    onClick={() => void act("pick", attempt.position)}
                    data-attr="dispatch-pick"
                  />
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : null}
      {actions.includes("approve") || actions.includes("decline") ? (
        <div className="flex items-center gap-2 border-t border-border px-[var(--portal-card-padding,14px)] py-3" data-attr="dispatch-approval">
          {actions.includes("approve") ? (
            <Button type="button" variant="primary" disabled={busy !== null} onClick={() => act("approve")} data-attr="dispatch-approve">
              Approve
            </Button>
          ) : null}
          {actions.includes("decline") ? (
            <Button type="button" variant="danger" disabled={busy !== null} onClick={() => act("decline")} data-attr="dispatch-decline">
              Decline
            </Button>
          ) : null}
        </div>
      ) : null}
    </RecordFactCard>
  );
}
