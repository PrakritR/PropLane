"use client";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { usePortalSession } from "@/hooks/use-portal-session";
import { TOUR_INTEREST_BODY } from "@/lib/reminders/tour-interest";

/** Owner setting in the existing reminder namespace. Changes affect new replies. */
export function TourInterestSettings() {
  const { userId } = usePortalSession();
  const generation = useRef(0);
  const [enabled, setEnabled] = useState(false);
  const [body, setBody] = useState(TOUR_INTEREST_BODY);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => { generation.current += 1; setLoaded(false); setEnabled(false); setSaved(false); }, [userId]);
  useEffect(() => {
    if (!userId) return;
    const controller = new AbortController();
    setLoading(true); setLoaded(false); setError(null); setSaved(false);
    void fetch("/api/portal/reminder-settings", { credentials: "include", cache: "no-store", signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error("Could not load follow-up settings.");
        const data = await res.json();
        if (controller.signal.aborted) return;
        const rule = data.settings?.rules?.tour_interest;
        setLoaded(true);
        setEnabled(rule?.enabled === true); setBody(rule?.template?.body || TOUR_INTEREST_BODY);
      }).catch((err) => { if (!controller.signal.aborted) setError(err.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [userId, retry]);
  async function save() {
    const started = generation.current;
    setError(null); setSaved(false);
    try {
      const res = await fetch("/api/portal/reminder-settings", { method: "PATCH", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "tour_interest", rule: { enabled, template: { subject: "Still interested in a tour?", body: body.trim() } } }) });
      if (!res.ok) throw new Error("Could not save follow-up settings.");
      if (started === generation.current) setSaved(true);
    } catch (err) { if (started === generation.current) setError(err instanceof Error ? err.message : "Could not save settings."); }
  }
  return <section className="space-y-3 border-t border-border pt-4" aria-label="Tour interest follow-up">
    <h3 className="text-sm font-semibold">Tour interest follow-up</h3>
    {loading ? <p role="status" className="text-sm text-muted">Loading settings…</p> : <>
      <label className="flex min-h-11 items-center gap-3 text-sm">
        <input type="checkbox" checked={enabled} disabled={!loaded} onChange={(event) => { setEnabled(event.target.checked); setSaved(false); }} className="h-4 w-4 accent-primary" data-attr="tour-interest-enable" />
        Send one follow-up after 24 hours without a reply
      </label>
      <p className="text-xs text-muted">Starts after the assistant sends tour options. Replies, tour requests, bookings, applications, and archiving cancel the follow-up. Texts wait until quiet hours end.</p>
      {enabled ? <label className="block text-sm">Message
        <textarea value={body} maxLength={1600} rows={3} onChange={(event) => { setBody(event.target.value); setSaved(false); }}
          className="mt-2 w-full rounded-xl border border-border bg-background p-3" data-attr="tour-interest-template" />
      </label> : null}
      <Button variant="outline" disabled={!loaded || !body.trim()} onClick={save} data-attr="tour-interest-save">Save follow-up settings</Button>
    </>}
    {error ? <div role="alert" className="text-sm"><p>{error}</p><Button variant="ghost" onClick={() => setRetry((n) => n + 1)}>Try again</Button></div> : null}
    {saved ? <p role="status" className="text-sm text-primary">Saved. Applies to new tour responses.</p> : null}
  </section>;
}
