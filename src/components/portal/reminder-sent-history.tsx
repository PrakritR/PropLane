"use client";

/**
 * Read-only Sent history for reminders — what actually went out (and what
 * failed), sourced from `GET /api/portal/reminder-history`.
 *
 * Self-contained: fetches its own data, paginates itself, and is not wired
 * into any settings shell yet. A future host mounts this component as-is;
 * it takes no data props.
 *
 * No mutation lives here. This is a log, not an editor: no retry, no
 * delete, no edit.
 *
 * The SMS column is shown only when the API reports `smsUiEnabled` (which it
 * reads server-side through `src/lib/sms-comm-ui-flag.server.ts` — this
 * component never reads `SMS_COMM_UI_ENABLED` or `process.env` itself). With
 * the flag off, the column disappears but an SMS row is still listed like
 * any other — a reminder that was actually sent never vanishes from the log.
 *
 * `last_error` is rendered exactly as the API returns it. Never reworded.
 */
import { useCallback, useEffect, useState } from "react";
import { PortalSettingsGroup } from "@/components/portal/portal-settings-ui";
import { cn } from "@/lib/utils";

export type ReminderSentHistoryStatus = "scheduled" | "sending" | "sent" | "failed" | "cancelled";

export type ReminderSentHistoryItem = {
  id: string;
  kind: string;
  kindLabel: string;
  status: ReminderSentHistoryStatus;
  recipientEmail: string | null;
  recipientPhone: string | null;
  recipientRole: "manager" | "counterparty";
  channel: "email" | "sms";
  sendAtLabel: string;
  sentAtLabel: string | null;
  lastError: string | null;
};

type HistoryResponse = {
  items: ReminderSentHistoryItem[];
  nextCursor: string | null;
  smsUiEnabled: boolean;
  error?: string;
};

const STATUS_LABEL: Record<ReminderSentHistoryStatus, string> = {
  sent: "Sent",
  failed: "Failed",
  scheduled: "Scheduled",
  sending: "Sending",
  cancelled: "Cancelled",
};

const STATUS_TONE: Record<ReminderSentHistoryStatus, string> = {
  sent: "bg-[var(--status-confirmed-bg)] text-[var(--status-confirmed-fg)]",
  failed: "bg-[var(--status-overdue-bg)] text-[var(--status-overdue-fg)]",
  scheduled: "bg-[var(--status-pending-bg)] text-[var(--status-pending-fg)]",
  sending: "bg-[var(--status-pending-bg)] text-[var(--status-pending-fg)]",
  cancelled: "bg-foreground/5 text-muted",
};

function recipientLabel(item: ReminderSentHistoryItem): string {
  return item.recipientEmail?.trim() || item.recipientPhone?.trim() || "—";
}

export function ReminderSentHistory({ pageSize = 25 }: { pageSize?: number }) {
  const [items, setItems] = useState<ReminderSentHistoryItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [smsUiEnabled, setSmsUiEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (after: string | null, replace: boolean) => {
      if (replace) setLoading(true);
      else setLoadingMore(true);
      setError(null);
      try {
        const params = new URLSearchParams({ limit: String(pageSize) });
        if (after) params.set("cursor", after);
        const res = await fetch(`/api/portal/reminder-history?${params.toString()}`);
        const body = (await res.json().catch(() => ({}))) as Partial<HistoryResponse>;
        if (!res.ok) throw new Error(body.error || "Could not load the reminder history.");
        const nextItems = body.items ?? [];
        setItems((prev) => (replace ? nextItems : [...prev, ...nextItems]));
        setCursor(body.nextCursor ?? null);
        setSmsUiEnabled(Boolean(body.smsUiEnabled));
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not load the reminder history.");
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [pageSize],
  );

  useEffect(() => {
    void load(null, true);
  }, [load]);

  if (loading) {
    return (
      <PortalSettingsGroup>
        <div className="px-4 py-8 text-center text-sm text-muted">Loading sent reminders…</div>
      </PortalSettingsGroup>
    );
  }

  if (error) {
    return (
      <PortalSettingsGroup>
        <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
          <p className="text-sm font-medium text-foreground">The reminder history did not load.</p>
          <p className="text-xs text-muted">{error}</p>
          <button
            type="button"
            onClick={() => void load(null, true)}
            data-attr="reminder-history-retry"
            className="mt-1 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-foreground transition-colors hover:bg-accent/40"
          >
            Try again
          </button>
        </div>
      </PortalSettingsGroup>
    );
  }

  if (items.length === 0) {
    return (
      <PortalSettingsGroup>
        <div className="px-4 py-8 text-center text-sm text-muted">No reminders have been sent yet.</div>
      </PortalSettingsGroup>
    );
  }

  return (
    <div className="space-y-3">
      <PortalSettingsGroup className="overflow-x-auto">
        <table className="w-full min-w-[540px] border-collapse text-left text-[13px]">
          <thead>
            <tr className="border-b border-border text-[11px] font-semibold uppercase tracking-[0.06em] text-muted">
              <th scope="col" className="px-4 py-2.5 font-semibold">
                Reminder
              </th>
              <th scope="col" className="px-4 py-2.5 font-semibold">
                Recipient
              </th>
              {smsUiEnabled ? (
                <th scope="col" className="px-4 py-2.5 font-semibold">
                  Channel
                </th>
              ) : null}
              <th scope="col" className="px-4 py-2.5 font-semibold">
                Scheduled / sent
              </th>
              <th scope="col" className="px-4 py-2.5 font-semibold">
                Status
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id} className="border-b border-border/70 align-top last:border-0">
                <td className="px-4 py-3 font-medium text-foreground">{item.kindLabel}</td>
                <td className="px-4 py-3 text-muted">
                  <span className="block max-w-[16rem] truncate" title={recipientLabel(item)}>
                    {recipientLabel(item)}
                  </span>
                </td>
                {smsUiEnabled ? (
                  <td className="px-4 py-3 text-muted">{item.channel === "sms" ? "SMS" : "Email"}</td>
                ) : null}
                <td className="px-4 py-3 text-muted">{item.sentAtLabel ?? item.sendAtLabel}</td>
                <td className="px-4 py-3">
                  <span
                    className={cn(
                      "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold",
                      STATUS_TONE[item.status],
                    )}
                  >
                    {STATUS_LABEL[item.status]}
                  </span>
                  {item.status === "failed" && item.lastError ? (
                    <p className="mt-1 max-w-[22rem] whitespace-pre-wrap break-words text-[11px] leading-relaxed text-[var(--status-overdue-fg)]">
                      {item.lastError}
                    </p>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </PortalSettingsGroup>
      {cursor ? (
        <div className="flex justify-center">
          <button
            type="button"
            onClick={() => void load(cursor, false)}
            disabled={loadingMore}
            data-attr="reminder-history-load-more"
            className="rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-foreground transition-colors hover:bg-accent/40 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
