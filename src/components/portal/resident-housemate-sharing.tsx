"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { MANAGER_TABLE_TH } from "@/components/portal/portal-metrics";
import {
  PORTAL_DATA_TABLE,
  PORTAL_DATA_TABLE_WRAP_CARD,
  PORTAL_TABLE_HEAD_ROW,
  PORTAL_TABLE_TD,
  PORTAL_TABLE_TR,
} from "@/components/portal/portal-data-table";
import { usePortalSession } from "@/hooks/use-portal-session";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import {
  DEFAULT_HOUSEMATE_SHARING,
  HOUSEMATE_SHARING_LABELS,
  housemateSharingSchema,
  type HousemateSharing,
} from "@/lib/resident-housemate-sharing";

const SHARING_KEYS = Object.keys(HOUSEMATE_SHARING_LABELS) as Array<keyof HousemateSharing>;

export function ResidentHousemateSharing() {
  const { userId, ready } = usePortalSession();
  if (!ready || !userId) {
    return <p role="status" className="p-4 text-sm text-muted">Loading sharing preferences…</p>;
  }
  return <SharingForm key={userId} />;
}

function SharingForm() {
  const router = useRouter();
  const [preferences, setPreferences] = useState<HousemateSharing>({ ...DEFAULT_HOUSEMATE_SHARING });
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        if (isDemoModeActive()) return;
        const response = await fetch("/api/resident/housemate-sharing", {
          signal: controller.signal,
          cache: "no-store",
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Could not load sharing preferences.");
        if (!controller.signal.aborted) {
          setPreferences(housemateSharingSchema.parse(data.preferences));
          setLoaded(true);
          setError("");
        }
      } catch (e) {
        if (!controller.signal.aborted) {
          setError(e instanceof Error ? e.message : "Could not load sharing preferences.");
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [retry]);

  async function updatePreference(key: keyof HousemateSharing, checked: boolean) {
    if (busy || !loaded || loading || isDemoModeActive()) return;
    const previous = preferences;
    const next = { ...preferences, [key]: checked };
    setPreferences(next);
    setBusy(true);
    setSaved(false);
    setError("");
    try {
      const response = await fetch("/api/resident/housemate-sharing", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not save sharing preferences.");
      setPreferences(housemateSharingSchema.parse(data.preferences));
      setSaved(true);
      router.refresh();
    } catch (e) {
      setPreferences(previous);
      setError(e instanceof Error ? e.message : "Could not save sharing preferences.");
    } finally {
      setBusy(false);
    }
  }

  const disabled = !loaded || loading || busy || isDemoModeActive();

  return (
    <section className="p-4 sm:p-6" data-attr="housemate-sharing-settings">
      <h2 className="text-base font-semibold">What housemates can see</h2>
      {loading ? <p role="status" className="mt-4 text-sm text-muted">Loading your choices…</p> : null}
      <div className={`${PORTAL_DATA_TABLE_WRAP_CARD} mt-4`}>
        <h3 className="border-b border-border px-4 py-3 text-sm font-semibold text-foreground sm:px-5">
          Share with my housemates
        </h3>
        <table className={PORTAL_DATA_TABLE}>
          <thead>
            <tr className={PORTAL_TABLE_HEAD_ROW}>
              <th className={`${MANAGER_TABLE_TH} text-left`}>Detail</th>
              <th className={`${MANAGER_TABLE_TH} w-24 text-right`}>Share</th>
            </tr>
          </thead>
          <tbody>
            {SHARING_KEYS.map((key) => (
              <tr key={key} className={PORTAL_TABLE_TR}>
                <td className={`${PORTAL_TABLE_TD} font-medium text-foreground`}>
                  {HOUSEMATE_SHARING_LABELS[key]}
                </td>
                <td className={`${PORTAL_TABLE_TD} text-right`}>
                  <label className="inline-flex items-center justify-end">
                    <span className="sr-only">{HOUSEMATE_SHARING_LABELS[key]}</span>
                    <input
                      type="checkbox"
                      checked={preferences[key]}
                      disabled={disabled}
                      onChange={(event) => void updatePreference(key, event.target.checked)}
                      data-attr={`housemate-sharing-${key.replace(/[A-Z]/g, (value) => `-${value.toLowerCase()}`)}`}
                      className="h-4 w-4 accent-primary"
                    />
                  </label>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {busy ? (
          <p role="status" className="border-t border-border px-4 py-2 text-xs text-muted sm:px-5">
            Saving…
          </p>
        ) : saved ? (
          <p role="status" className="border-t border-border px-4 py-2 text-xs text-green-700 sm:px-5">
            Saved
          </p>
        ) : null}
      </div>
      {error ? (
        <div className="mt-4">
          <p role="alert" className="text-sm text-red-600">{error}</p>
          <Button
            variant="outline"
            data-attr="housemate-sharing-retry"
            onClick={() => {
              setLoaded(false);
              setLoading(true);
              setRetry((value) => value + 1);
            }}
          >
            Reload preferences
          </Button>
        </div>
      ) : null}
      {isDemoModeActive() ? (
        <p className="mt-4 text-sm text-muted">Sign in to your resident portal to change sharing choices.</p>
      ) : null}
    </section>
  );
}
