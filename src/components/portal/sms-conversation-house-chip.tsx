"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { RowSelectCheckbox } from "@/components/ui/row-select-checkbox";
import { usePortalSession } from "@/hooks/use-portal-session";
import { MANAGER_PORTFOLIO_REFRESH_EVENTS } from "@/lib/manager-portfolio-access";
import { conversationHouseSourceLabel, type ConversationHouse } from "@/lib/manager-sms-messages";

type WorkspaceHouse = { propertyId: string; label: string; ownerUserId: string };

/** Assignment options are short-lived, authenticated results, never a global cache. */
export function SmsConversationHouseChip({ conversationKey, ownerManagerUserId, houses, canEdit, onChanged }: {
  conversationKey: string;
  ownerManagerUserId: string | null | undefined;
  houses: ConversationHouse[];
  canEdit: boolean;
  onChanged?: () => void;
}) {
  const { userId } = usePortalSession();
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<WorkspaceHouse[]>([]);
  const [draft, setDraft] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [saving, setSaving] = useState(false);
  const generation = useRef(0);
  const identity = `${userId ?? ""}:${ownerManagerUserId ?? ""}:${conversationKey}`;

  useEffect(() => {
    generation.current += 1;
    setOpen(false);
    setOptions([]);
    setError(null);
    setSaving(false);
  }, [identity]);

  useEffect(() => {
    const refresh = () => setRetry((n) => n + 1);
    for (const name of MANAGER_PORTFOLIO_REFRESH_EVENTS) window.addEventListener(name, refresh);
    return () => { for (const name of MANAGER_PORTFOLIO_REFRESH_EVENTS) window.removeEventListener(name, refresh); };
  }, []);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    setOptions([]);
    setError(null);
    const owner = ownerManagerUserId?.trim();
    if (!owner || !userId) {
      setError("Could not verify this workspace. Please refresh and try again.");
      setLoading(false);
      return;
    }
    void fetch(`/api/manager/sms-conversations/houses?ownerId=${encodeURIComponent(owner)}`, {
      credentials: "include", cache: "no-store", signal: controller.signal,
    }).then(async (res) => {
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Could not load houses.");
      if (!controller.signal.aborted) setOptions((body.houses ?? []).filter((h: WorkspaceHouse) => h.ownerUserId === owner));
    }).catch((e: unknown) => {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Could not load houses.");
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [open, identity, retry, ownerManagerUserId, userId]);

  async function save() {
    const currentGeneration = generation.current;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/manager/sms-conversations/houses", {
        method: "PATCH", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify({ conversationKey, propertyIds: draft }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Could not save the house assignment.");
      }
      if (generation.current === currentGeneration) { onChanged?.(); setOpen(false); }
    } catch (e) {
      if (generation.current === currentGeneration) setError(e instanceof Error ? e.message : "Could not save the house assignment.");
    } finally {
      if (generation.current === currentGeneration) setSaving(false);
    }
  }
  const primary = houses[0];
  const label = primary ? `${primary.label}${houses.length > 1 ? ` +${houses.length - 1}` : ""}` : "Assign a house";
  return <>
    <Button variant="outline" className="max-w-[12rem]" disabled={!canEdit}
      title={primary ? `${houses.map((h) => h.label).join(", ")} · ${conversationHouseSourceLabel(primary.source)}` : "Assign a house"}
      data-attr="sms-conversation-house" onClick={() => { setDraft(houses.map((h) => h.propertyId)); setQuery(""); setOpen(true); }}>
      <span className="truncate">{label}</span><ChevronDown className="h-4 w-4 shrink-0" aria-hidden />
    </Button>
    <Modal open={open} onClose={() => { if (!saving) setOpen(false); }} title="Assign a house"
      footer={<Button disabled={loading || saving || Boolean(error) || !canEdit || draft.some((id) => !options.some((h) => h.propertyId === id))} onClick={() => save()} data-attr="sms-house-assignment-save">Save assignment</Button>}>
      <p className="mb-4 text-sm text-muted">Only houses you can manage in this workspace.</p>
      <label className="mb-3 flex items-center gap-2 rounded-xl border border-border px-3">
        <Search className="h-4 w-4 text-muted" aria-hidden />
        <input className="min-h-11 min-w-0 flex-1 bg-transparent outline-none" aria-label="Search your houses" placeholder="Search your houses…" value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      {loading ? <p role="status" className="py-4 text-sm text-muted">Loading houses…</p> : null}
      {error ? <div role="alert" className="mb-3 rounded-xl border border-danger/20 bg-danger/5 p-3 text-sm"><p>{error}</p><Button variant="outline" onClick={() => setRetry((n) => n + 1)}>Refresh houses</Button></div> : null}
      {!loading && !error && options.length === 0 ? <p className="py-4 text-sm text-muted">No houses are available with your current edit access.</p> : null}
      {!loading && !error ? houses.filter((house) => draft.includes(house.propertyId) && !options.some((option) => option.propertyId === house.propertyId)).map((house) => <div key={house.propertyId} className="mb-2 flex items-center justify-between gap-3 rounded-xl border border-border p-3 text-sm">
        <span>{house.label}<span className="block text-xs text-muted">No longer available for assignment</span></span>
        <Button variant="ghost" disabled={saving} onClick={() => setDraft((ids) => ids.filter((id) => id !== house.propertyId))}>Remove</Button>
      </div>) : null}
      {options.filter((h) => h.label.toLowerCase().includes(query.toLowerCase())).map((h) => <div key={h.propertyId} className="flex min-h-16 items-center gap-4 rounded-xl border border-border px-5 py-3 mb-2">
        <RowSelectCheckbox aria-label={`Assign ${h.label}`} checked={draft.includes(h.propertyId)} disabled={saving}
          onChange={(e) => setDraft((ids) => e.target.checked ? [...ids, h.propertyId] : ids.filter((id) => id !== h.propertyId))} />
        <div><p className="text-sm font-semibold">{h.label}</p><p className="text-xs text-muted">Communication · Can edit</p></div>
      </div>)}
    </Modal>
  </>;
}
