"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { usePortalSession } from "@/hooks/use-portal-session";
import { TOUR_INTEREST_BODY } from "@/lib/reminders/tour-interest";
import {
  useFlushSettingsAutosaveOnUnmount,
  useReportSettingsSaveStatus,
} from "@/components/portal/settings-save-status-context";

function interestSnapshot(enabled: boolean, body: string) {
  return JSON.stringify({ enabled, body: body.trim() });
}

/** Owner setting in the existing reminder namespace. Changes affect new replies. */
export function TourInterestSettings() {
  const { userId } = usePortalSession();
  const reportSaveStatus = useReportSettingsSaveStatus();
  const generation = useRef(0);
  const [enabled, setEnabled] = useState(false);
  const [body, setBody] = useState(TOUR_INTEREST_BODY);
  const [savedSnapshot, setSavedSnapshot] = useState(interestSnapshot(false, TOUR_INTEREST_BODY));
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    generation.current += 1;
    setLoaded(false);
    setEnabled(false);
    setBody(TOUR_INTEREST_BODY);
    setSavedSnapshot(interestSnapshot(false, TOUR_INTEREST_BODY));
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    const controller = new AbortController();
    setLoading(true);
    setLoaded(false);
    setError(null);
    void fetch("/api/portal/reminder-settings", { credentials: "include", cache: "no-store", signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error("Could not load follow-up settings.");
        const data = await res.json();
        if (controller.signal.aborted) return;
        const rule = data.settings?.rules?.tour_interest;
        const nextEnabled = rule?.enabled === true;
        const nextBody = rule?.template?.body || TOUR_INTEREST_BODY;
        setLoaded(true);
        setEnabled(nextEnabled);
        setBody(nextBody);
        setSavedSnapshot(interestSnapshot(nextEnabled, nextBody));
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(err.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [userId, retry]);

  const isDirty = useMemo(
    () => loaded && interestSnapshot(enabled, body) !== savedSnapshot,
    [body, enabled, loaded, savedSnapshot],
  );

  const save = useCallback(
    async (options?: { silent?: boolean }): Promise<boolean> => {
      if (!loaded || !isDirty || !body.trim()) return true;
      const started = generation.current;
      setSaving(true);
      setError(null);
      reportSaveStatus({ type: "start" });
      try {
        const res = await fetch("/api/portal/reminder-settings", {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind: "tour_interest",
            rule: { enabled, template: { subject: "Still interested in a tour?", body: body.trim() } },
          }),
          keepalive: true,
        });
        if (!res.ok) throw new Error("Could not save follow-up settings.");
        if (started !== generation.current) return true;
        setSavedSnapshot(interestSnapshot(enabled, body));
        reportSaveStatus({ type: "success" });
        return true;
      } catch (err) {
        if (started === generation.current) {
          const message = err instanceof Error ? err.message : "Could not save settings.";
          setError(message);
          reportSaveStatus({ type: "failure", reason: message });
        }
        return false;
      } finally {
        if (started === generation.current) setSaving(false);
      }
    },
    [body, enabled, isDirty, loaded, reportSaveStatus],
  );

  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (loading || !loaded || !isDirty || !body.trim()) return;
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = setTimeout(() => {
      void save({ silent: true });
    }, 600);
    return () => {
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    };
  }, [body, isDirty, loaded, loading, save]);

  useFlushSettingsAutosaveOnUnmount(save, isDirty && Boolean(body.trim()));

  return (
    <section className="space-y-3 border-t border-border pt-4" aria-label="Tour interest follow-up">
      <h3 className="text-sm font-semibold">Tour interest follow-up</h3>
      {loading ? (
        <p role="status" className="text-sm text-muted">Loading settings…</p>
      ) : (
        <>
          <label className="flex min-h-11 items-center gap-3 text-sm">
            <input
              type="checkbox"
              checked={enabled}
              disabled={!loaded || saving}
              onChange={(event) => setEnabled(event.target.checked)}
              className="h-4 w-4 accent-primary"
              data-attr="tour-interest-enable"
            />
            Send one follow-up after 24 hours without a reply
          </label>
          {enabled ? (
            <label className="block text-sm">
              Message
              <textarea
                value={body}
                maxLength={1600}
                rows={3}
                disabled={saving}
                onChange={(event) => setBody(event.target.value)}
                className="mt-2 w-full rounded-xl border border-border bg-background p-3"
                data-attr="tour-interest-template"
              />
            </label>
          ) : null}
        </>
      )}
      {error ? (
        <div role="alert" className="text-sm">
          <p>{error}</p>
          <Button variant="ghost" onClick={() => setRetry((n) => n + 1)}>Try again</Button>
        </div>
      ) : null}
    </section>
  );
}
