"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { BANNER_INFO_CLASS } from "@/lib/ui-styles";

type PendingChange = {
  id: string;
  recordKind: "tour" | "work_order";
  changeType: "time_changed" | "deleted";
  summary: string | null;
  previousStart: string | null;
  previousEnd: string | null;
  proposedStart: string | null;
  proposedEnd: string | null;
};

function formatWhen(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function describe(change: PendingChange): string {
  const label = change.recordKind === "tour" ? "tour" : "service visit";
  const name = change.summary?.trim() || label;
  if (change.changeType === "deleted") {
    return `${name} was deleted on Google.`;
  }
  return `${name} was moved on Google to ${formatWhen(change.proposedStart)}.`;
}

/**
 * "Google edited or deleted a PropLane event" attention items — the visible
 * half of `proplane-calendar-reconcile.server.ts`'s two-way sync. Renders
 * nothing when there is nothing pending, so it costs no layout space on the
 * common path. Accept applies Google's version to PropLane (through the same
 * guarded reschedule/cancel boundary a manual change uses); Dismiss keeps
 * PropLane's version and pushes it back onto Google, overwriting the change.
 * Never applies either automatically — see the module doc for why.
 */
export function GoogleCalendarPendingChangesBanner({
  apiBase,
  refreshSignal,
}: {
  /** `/api/portal/google-calendar` (manager) or `/api/vendor/google-calendar` (vendor). */
  apiBase: string;
  refreshSignal?: number;
}) {
  const { showToast } = useAppUi();
  const [pending, setPending] = useState<PendingChange[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/pending-changes`, { credentials: "include", cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { pending?: PendingChange[] };
      setPending(Array.isArray(data.pending) ? data.pending : []);
    } catch {
      /* best-effort — an attention banner that fails to load just stays empty */
    }
  }, [apiBase]);

  useEffect(() => {
    void load();
  }, [load, refreshSignal]);

  const resolve = useCallback(
    async (id: string, action: "accept" | "dismiss") => {
      setBusyId(id);
      try {
        const res = await fetch(`${apiBase}/pending-changes/${encodeURIComponent(id)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ action }),
        });
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) throw new Error(data.error || "Could not update this item.");
        setPending((prev) => prev.filter((row) => row.id !== id));
        showToast(action === "accept" ? "Applied Google's change." : "Kept PropLane's version.");
      } catch (e) {
        showToast(e instanceof Error ? e.message : "Could not update this item.");
      } finally {
        setBusyId(null);
      }
    },
    [apiBase, showToast],
  );

  if (pending.length === 0) return null;

  return (
    <div className={BANNER_INFO_CLASS} data-attr="google-calendar-pending-changes-banner">
      <div className="space-y-2">
        {pending.map((change) => (
          <div key={change.id} className="flex flex-wrap items-center justify-between gap-2" data-attr="google-calendar-pending-change-row">
            <p className="text-sm text-foreground">{describe(change)}</p>
            <div className="flex shrink-0 gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={busyId === change.id}
                onClick={() => void resolve(change.id, "dismiss")}
                data-attr="google-calendar-pending-change-dismiss"
              >
                Keep PropLane&apos;s time
              </Button>
              <Button
                type="button"
                variant="primary"
                disabled={busyId === change.id}
                onClick={() => void resolve(change.id, "accept")}
                data-attr="google-calendar-pending-change-accept"
              >
                {change.changeType === "deleted" ? "Confirm cancelled" : "Use Google's time"}
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
