"use client";

import { useEffect, useState } from "react";
import { Pencil } from "lucide-react";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { PortalDialog } from "@/components/portal/portal-dialog";
import { useSettingsPropertyScope } from "@/components/portal/settings-property-scope";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { DEFAULT_LISTING_SHARED_INTRO, LISTING_SHARED_TEMPLATE_KEY } from "@/lib/listing-shared-template";
import { normalizeAutomatedMessageSettings } from "@/lib/automated-messages-settings";

export function ListingSharedTemplateSettings() {
  const { propertyId, workspaceId } = useSettingsPropertyScope();
  const { showToast } = useAppUi();
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState(DEFAULT_LISTING_SHARED_INTRO);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    setLoadFailed(false);
    const query = new URLSearchParams();
    if (propertyId) query.set("propertyId", propertyId);
    if (workspaceId) query.set("workspaceId", workspaceId);
    void fetch(`/api/portal/automated-messages?${query}`, { credentials: "include" }).then(async (response) => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load template.");
      if (active) setBody(normalizeAutomatedMessageSettings(data.settings)[LISTING_SHARED_TEMPLATE_KEY]?.template?.body || DEFAULT_LISTING_SHARED_INTRO);
    }).catch((error: unknown) => { if (active) setLoadFailed(true); showToast(error instanceof Error ? error.message : "Could not load template."); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [open, propertyId, workspaceId, showToast]);
  async function save() {
    const response = await fetch("/api/portal/automated-messages", { method: "PATCH", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ propertyId, workspaceId, settings: { [LISTING_SHARED_TEMPLATE_KEY]: { enabled: true, template: { subject: "", body: body.trim() || DEFAULT_LISTING_SHARED_INTRO } } } }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) { showToast(data.error || "Could not save template."); return; }
    setOpen(false);
    showToast("Listing template saved.");
  }
  return <>
    <div className="flex items-center justify-between px-4 py-3"><span className="text-sm font-medium">Listing shared</span><PortalIconAction icon={Pencil} label="Edit listing shared template" onClick={() => setOpen(true)} /></div>
    <PortalDialog open={open} onClose={() => setOpen(false)} title="Listing shared" primaryAction={{ label: "Save", onClick: save, disabled: loading || loadFailed }}>
      <label htmlFor="listing-shared-template" className="mb-2 block text-sm">Message</label>
      <textarea id="listing-shared-template" value={body} onChange={(event) => setBody(event.target.value)} disabled={loading} rows={5} className="w-full rounded-xl border border-border bg-card p-3 text-sm" />
      <div className="mt-3 flex flex-wrap gap-3">{["{homes}", "{property}", "{first_name}"].map((token) => <button key={token} type="button" className="text-sm text-primary" onClick={() => setBody((current) => `${current} ${token}`)}>{token}</button>)}</div>
    </PortalDialog>
  </>;
}
