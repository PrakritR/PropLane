"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { PortalDialog } from "@/components/portal/portal-dialog";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { useAppUi } from "@/components/providers/app-ui-provider";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import type { AdverseActionStatus } from "@/lib/screening/adverse-action";

type StatusView = Pick<
  AdverseActionStatus,
  "required" | "stage" | "declineAllowed" | "canFinalize" | "finalDueAt" | "preAdverseSentAt" | "basedOnReport"
>;

type Mode =
  | { kind: "question"; row: DemoApplicantRow }
  | { kind: "waiting"; row: DemoApplicantRow; status: StatusView }
  | { kind: "finalize"; row: DemoApplicantRow; status: StatusView };

const ANSWER_OPTIONS = [
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" },
];

function dateLabel(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

/** Does declining this application involve a consumer report? Only a completed Checkr report does. */
export function applicationHasConsumerReport(row: Pick<DemoApplicantRow, "backgroundCheck">): boolean {
  return row.backgroundCheck?.status === "complete" && Boolean(row.backgroundCheck.reportId);
}

async function readStatus(applicationId: string): Promise<StatusView | null> {
  try {
    const res = await fetch(`/api/screening/adverse-action?applicationId=${encodeURIComponent(applicationId)}`, {
      credentials: "include",
      cache: "no-store",
    });
    if (!res.ok) return null;
    return ((await res.json()) as { status?: StatusView }).status ?? null;
  } catch {
    return null;
  }
}

async function post(body: Record<string, unknown>): Promise<{ ok: boolean; error?: string; status?: StatusView }> {
  try {
    const res = await fetch("/api/screening/adverse-action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; status?: StatusView };
    return res.ok && data.ok ? { ok: true, status: data.status } : { ok: false, error: data.error ?? "That could not be saved." };
  } catch {
    return { ok: false, error: "Network error. Try again." };
  }
}

/**
 * The FCRA question a manager answers before declining an application that has a Checkr report: "Is this decision
 * based in whole or part on the background check?".
 *
 *   No   -> recorded, then the usual decline.
 *   Yes  -> the PRE-ADVERSE notice goes out now (report copy, rights summary, how to dispute); the application stays
 *           where it is for five business days, then Finalize sends the final notice and declines.
 *
 * `confirmDecline(row)` resolves `true` when the caller may go on and save the decline, `false` when it must stop. An
 * application with no completed report resolves `true` at once and draws nothing. The server independently refuses
 * the decline until the answer is on record (`adverseActionDeclineBlocker`), so this is the screen, not the rule.
 */
export function useAdverseActionDecline(): {
  confirmDecline: (row: DemoApplicantRow) => Promise<boolean>;
  dialog: ReactNode;
} {
  const { showToast } = useAppUi();
  const [mode, setMode] = useState<Mode | null>(null);
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const resolver = useRef<((proceed: boolean) => void) | null>(null);

  const settle = useCallback((proceed: boolean) => {
    resolver.current?.(proceed);
    resolver.current = null;
    setMode(null);
    setAnswer("");
    setBusy(false);
  }, []);

  const confirmDecline = useCallback(
    async (row: DemoApplicantRow): Promise<boolean> => {
      if (isDemoModeActive() || !applicationHasConsumerReport(row)) return true;
      const status = await readStatus(row.id);
      if (!status) {
        showToast("Could not check the background check requirements. Try again.");
        return false;
      }
      if (!status.required || status.declineAllowed) return true;
      return new Promise<boolean>((resolve) => {
        resolver.current = resolve;
        setAnswer("");
        if (status.stage === "pre_adverse_sent") {
          setMode(status.canFinalize ? { kind: "finalize", row, status } : { kind: "waiting", row, status });
        } else {
          setMode({ kind: "question", row });
        }
      });
    },
    [showToast],
  );

  const who = mode ? mode.row.name?.trim() || mode.row.email?.trim() || "the applicant" : "";

  const submitAnswer = async () => {
    if (mode?.kind !== "question" || (answer !== "yes" && answer !== "no")) return;
    setBusy(true);
    const result = await post({ action: "decide", applicationId: mode.row.id, basedOnReport: answer === "yes" });
    if (!result.ok) {
      showToast(result.error ?? "That could not be saved.");
      setBusy(false);
      return;
    }
    if (answer === "no") return settle(true);
    showToast(`Pre-adverse notice sent to ${who}. The final notice can go out after ${dateLabel(result.status?.finalDueAt) || "the waiting period"}.`);
    settle(false);
  };

  const finalize = async () => {
    if (mode?.kind !== "finalize") return;
    setBusy(true);
    const result = await post({ action: "finalize", applicationId: mode.row.id });
    if (!result.ok) {
      showToast(result.error ?? "The final notice could not be sent.");
      setBusy(false);
      return;
    }
    settle(true);
  };

  const cancelNotice = async () => {
    if (mode?.kind === "question") return;
    if (!mode) return;
    setBusy(true);
    const result = await post({ action: "cancel", applicationId: mode.row.id });
    if (!result.ok) {
      showToast(result.error ?? "The notice could not be withdrawn.");
      setBusy(false);
      return;
    }
    showToast(`Pre-adverse notice withdrawn for ${who}.`);
    settle(false);
  };

  let dialog: ReactNode = null;
  if (mode?.kind === "question") {
    dialog = (
      <PortalDialog
        open
        title="Decline application"
        onClose={() => settle(false)}
        dataAttr="adverse-action-question"
        fullScreenMobile={false}
        primaryAction={{
          label: answer === "yes" ? "Send pre-adverse notice" : "Decline",
          onClick: submitAnswer,
          disabled: (answer !== "yes" && answer !== "no") || busy,
          loading: busy,
          dataAttr: "adverse-action-submit",
        }}
        tone={answer === "no" ? "danger" : "default"}
      >
        <FieldSingleSelect
          label="Is this decision based in whole or part on the background check?"
          value={answer}
          onChange={setAnswer}
          options={ANSWER_OPTIONS}
          placeholder="Choose"
          dataAttr="adverse-action-answer"
        />
      </PortalDialog>
    );
  } else if (mode?.kind === "waiting") {
    dialog = (
      <PortalDialog
        open
        title="Pre-adverse notice sent"
        onClose={() => settle(false)}
        dataAttr="adverse-action-waiting"
        fullScreenMobile={false}
        primaryAction={{ label: "Withdraw notice", onClick: cancelNotice, disabled: busy, loading: busy, dataAttr: "adverse-action-cancel" }}
      >
        <dl className="space-y-1 text-sm">
          <div className="flex items-center justify-between gap-3">
            <dt className="text-foreground">Sent</dt>
            <dd className="font-medium">{dateLabel(mode.status.preAdverseSentAt)}</dd>
          </div>
          <div className="flex items-center justify-between gap-3">
            <dt className="text-foreground">Final notice available</dt>
            <dd className="font-medium">{dateLabel(mode.status.finalDueAt)}</dd>
          </div>
        </dl>
      </PortalDialog>
    );
  } else if (mode?.kind === "finalize") {
    dialog = (
      <PortalDialog
        open
        title="Send final notice and decline"
        onClose={() => settle(false)}
        dataAttr="adverse-action-finalize"
        fullScreenMobile={false}
        tone="danger"
        primaryAction={{ label: "Send final notice and decline", onClick: finalize, disabled: busy, loading: busy, dataAttr: "adverse-action-finalize-submit" }}
        secondaryAction={{ label: "Withdraw notice", onClick: cancelNotice, disabled: busy, dataAttr: "adverse-action-cancel" }}
      >
        <dl className="space-y-1 text-sm">
          <div className="flex items-center justify-between gap-3">
            <dt className="text-foreground">Pre-adverse notice sent</dt>
            <dd className="font-medium">{dateLabel(mode.status.preAdverseSentAt)}</dd>
          </div>
        </dl>
      </PortalDialog>
    );
  }

  return { confirmDecline, dialog };
}

/**
 * Where an application stands on its adverse-action notices, as one plain fact on the screening panel. Draws nothing
 * until a notice has gone out (a decline asks the question itself).
 */
export function AdverseActionFact({ row }: { row: DemoApplicantRow }) {
  const [status, setStatus] = useState<StatusView | null>(null);
  const applicationId = row.id;
  const hasReport = applicationHasConsumerReport(row);
  useEffect(() => {
    if (!hasReport || isDemoModeActive()) return;
    let cancelled = false;
    void readStatus(applicationId).then((next) => {
      if (!cancelled) setStatus(next);
    });
    return () => {
      cancelled = true;
    };
  }, [applicationId, hasReport]);
  if (!status) return null;
  if (status.stage === "pre_adverse_sent") {
    return (
      <p className="text-sm font-medium text-foreground" data-attr="adverse-action-fact">
        {`Pre-adverse notice sent ${dateLabel(status.preAdverseSentAt)} · Final notice available ${dateLabel(status.finalDueAt)}`}
      </p>
    );
  }
  if (status.stage === "finalized") {
    return (
      <p className="text-sm font-medium text-foreground" data-attr="adverse-action-fact">
        Final adverse-action notice sent
      </p>
    );
  }
  return null;
}
