"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { usePortalSession } from "@/hooks/use-portal-session";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { DEFAULT_HOUSEMATE_SHARING, HOUSEMATE_SHARING_LABELS, housemateSharingSchema, type HousemateSharing } from "@/lib/resident-housemate-sharing";

export function ResidentHousemateSharing() {
  const { userId, ready } = usePortalSession();
  if (!ready || !userId) return <p role="status" className="p-4 text-sm text-muted">Loading sharing preferences…</p>;
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
        const response = await fetch("/api/resident/housemate-sharing", { signal: controller.signal, cache: "no-store" });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Could not load sharing preferences.");
        if (!controller.signal.aborted) { setPreferences(housemateSharingSchema.parse(data.preferences)); setLoaded(true); setError(""); }
      } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Could not load sharing preferences."); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    }
    void load();
    return () => controller.abort();
  }, [retry]);
  async function save() {
    if (busy || !loaded || loading || isDemoModeActive()) return;
    setBusy(true); setSaved(false); setError("");
    try {
      const response = await fetch("/api/resident/housemate-sharing", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(preferences) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not save sharing preferences.");
      setPreferences(housemateSharingSchema.parse(data.preferences)); setSaved(true); router.refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save sharing preferences."); }
    finally { setBusy(false); }
  }
  return <section className="p-4 sm:p-6" data-attr="housemate-sharing-settings">
    <h2 className="text-base font-semibold">What housemates can see</h2>
    <p className="mt-2 max-w-2xl text-sm text-muted">Choose which details to share with roommates and housemates. Everything starts private. You can change these choices anytime.</p>
    <p className="mt-2 max-w-2xl text-sm text-muted">Your property manager can still access information needed to manage your tenancy. Changing these choices hides details on future visits; it cannot remove copies someone already saved.</p>
    {loading ? <p role="status" className="mt-4 text-sm text-muted">Loading your choices…</p> : null}
    <fieldset disabled={!loaded || loading || busy || isDemoModeActive()} className="mt-5 grid gap-4 sm:grid-cols-2">
      <legend className="sr-only">Share with my housemates</legend>
      {(Object.keys(HOUSEMATE_SHARING_LABELS) as Array<keyof HousemateSharing>).map(key => <label key={key} className="flex items-center gap-3 text-sm font-medium">
        <input type="checkbox" checked={preferences[key]} onChange={event => { setPreferences(current => ({ ...current, [key]: event.target.checked })); setSaved(false); }} data-attr={`housemate-sharing-${key.replace(/[A-Z]/g, value => `-${value.toLowerCase()}`)}`} className="h-4 w-4 accent-primary" />
        {HOUSEMATE_SHARING_LABELS[key]}
      </label>)}
    </fieldset>
    {error ? <div className="mt-4"><p role="alert" className="text-sm text-red-600">{error}</p><Button variant="outline" data-attr="housemate-sharing-retry" onClick={() => { setLoaded(false); setLoading(true); setRetry(value => value + 1); }}>Reload preferences</Button></div> : null}
    {saved ? <p role="status" className="mt-4 text-sm text-green-700">Sharing choices saved.</p> : null}
    {isDemoModeActive() ? <p className="mt-4 text-sm text-muted">Sign in to your resident portal to change sharing choices.</p> : null}
    <Button className="mt-5" disabled={!loaded || loading || busy || isDemoModeActive()} onClick={() => void save()} data-attr="housemate-sharing-save">{busy ? "Saving…" : "Save sharing choices"}</Button>
  </section>;
}
