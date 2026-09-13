"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Clock3 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { usePortalSession } from "@/hooks/use-portal-session";
import { formatPacificDateTime } from "@/lib/pacific-time";

type FollowUp = { id: string; conversationKey?: string; status: string; sendAt: string; body: string; canEdit: boolean; canCancel?: boolean };
const LABELS: Record<string, string> = { scheduled: "Scheduled follow-up", queued: "Queued follow-up", sending: "Sending follow-up", submitted: "Follow-up sent", sent: "Follow-up sent", delivered: "Follow-up delivered", failed: "Follow-up not sent", cancelled: "Follow-up cancelled", unknown: "Delivery unconfirmed" };
function localInputTime(iso: string) {
  const value = new Date(iso);
  return new Date(value.getTime() - value.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export function TourInterestFollowUpCard({ conversationKey, conversationKeys, messageCount }: { conversationKey: string; conversationKeys?: string[]; messageCount: number }) {
  const { userId } = usePortalSession();
  const [rows, setRows] = useState<FollowUp[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<FollowUp | null>(null);
  const [text, setText] = useState("");
  const [sendAt, setSendAt] = useState("");
  const [retry, setRetry] = useState(0);
  const generation = useRef(0);
  const keyQuery = [...new Set([conversationKey, ...(conversationKeys ?? [])])].sort().map((key) => `conversationKey=${encodeURIComponent(key)}`).join("&");
  const reload = useCallback(() => setRetry((n) => n + 1), []);
  useEffect(() => {
    generation.current += 1;
    setRows([]); setError(null); setEditing(null);
  }, [conversationKey, userId]);
  useEffect(() => {
    if (!userId || !conversationKey) return;
    const controller = new AbortController();
    void fetch(`/api/manager/tour-follow-ups?${keyQuery}`, { credentials: "include", cache: "no-store", signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error("Could not load scheduled follow-ups.");
        const body = await res.json();
        if (!controller.signal.aborted) { setRows(body.reminders ?? []); setError(null); }
      }).catch((err) => { if (!controller.signal.aborted) setError(err.message); });
    return () => controller.abort();
  }, [conversationKey, keyQuery, userId, messageCount, retry]);
  const pending = rows.some((row) => ["scheduled", "queued", "sending"].includes(row.status));
  useEffect(() => {
    if (!pending || editing) return;
    const timer = setInterval(() => { if (document.visibilityState === "visible") reload(); }, 60_000);
    return () => clearInterval(timer);
  }, [pending, editing, reload]);
  async function update(row: FollowUp, action: "edit" | "cancel") {
    const started = generation.current;
    setError(null);
    try {
      const res = await fetch("/api/manager/tour-follow-ups", { method: "PATCH", credentials: "include",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversationKey: row.conversationKey ?? conversationKey, id: row.id, action,
          ...(action === "edit" ? { text, sendAt: sendAt === localInputTime(row.sendAt) ? row.sendAt : new Date(sendAt).toISOString() } : {}) }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Could not update the follow-up.");
      if (started === generation.current) { setEditing(null); reload(); }
    } catch (err) { if (started === generation.current) setError(err instanceof Error ? err.message : "Could not update the follow-up."); }
  }
  return <>
    {error ? <div role="alert" className="rounded-xl border border-border p-3 text-sm"><p>{error}</p><Button variant="ghost" onClick={reload}>Try again</Button></div> : null}
    {rows.slice(0, 1).map((row) => <article key={row.id} className="my-3 rounded-2xl border border-primary/20 bg-primary/5 p-4" data-attr="tour-interest-inline-card">
      <div className="flex items-center gap-2 text-sm font-semibold"><Clock3 className="h-4 w-4" aria-hidden />{LABELS[row.status] ?? "Follow-up pending"}</div>
      <p className="mt-1 text-xs text-muted">{formatPacificDateTime(row.sendAt)} Pacific</p>
      <p className="mt-3 text-sm">{row.body}</p>
      {row.canEdit || row.canCancel ? <div className="mt-3 flex gap-2">
        {row.canEdit ? <Button variant="outline" onClick={() => { setEditing(row); setText(row.body); setSendAt(localInputTime(row.sendAt)); }}>Edit follow-up</Button> : null}
        {row.canCancel ? <Button variant="ghost" onClick={() => update(row, "cancel")}>Cancel follow-up</Button> : null}
      </div> : null}
    </article>)}
    <Modal open={Boolean(editing)} onClose={() => setEditing(null)} title="Edit follow-up"
      footer={<Button disabled={!text.trim() || !sendAt || !Number.isFinite(Date.parse(sendAt))} onClick={() => editing ? update(editing, "edit") : undefined}>Save follow-up</Button>}>
      <label className="block text-sm">Message<textarea value={text} maxLength={1600} rows={4} onChange={(event) => setText(event.target.value)} className="mt-2 w-full rounded-xl border border-border bg-background p-3" /></label>
      <label className="mt-4 block text-sm">Send at ({Intl.DateTimeFormat().resolvedOptions().timeZone})<input type="datetime-local" value={sendAt} onChange={(event) => setSendAt(event.target.value)} className="mt-2 min-h-11 w-full rounded-xl border border-border bg-background p-3" /></label>
      <p className="mt-2 text-xs text-muted">At least 24 hours after the tour response. Replies still cancel this follow-up, and quiet hours apply.</p>
      {error ? <p role="alert" className="mt-3 text-sm">{error}</p> : null}
    </Modal>
  </>;
}
