"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { Input } from "@/components/ui/input";
import type { ManagerRoomSubmission } from "@/lib/manager-listing-submission";

/**
 * Printables — everything on the wall or in the welcome folder, drawn from the
 * house details above so it can never drift from what the manager typed.
 *
 * The door card and the rules poster carry a QR to the house's PUBLIC page:
 * rules and trash days only. The welcome sheet carries the codes and the Wi-Fi,
 * so it is printed and handed over — it never becomes a link.
 */
type LinkState = { url: string | null; issuedAt: string | null } | null;

export function HousePrintablesCard({
  propertyId,
  rooms,
  showToast,
}: {
  propertyId: string;
  rooms: ReadonlyArray<Pick<ManagerRoomSubmission, "id" | "name" | "floor">>;
  showToast?: (message: string) => void;
}) {
  const [link, setLink] = useState<LinkState>(null);
  const [busy, setBusy] = useState(false);
  const [roomId, setRoomId] = useState<string>(rooms[0]?.id ?? "");
  const [residentName, setResidentName] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/portal/house-public-link?propertyId=${encodeURIComponent(propertyId)}`);
      if (!res.ok) return;
      const data = (await res.json()) as { url?: string | null; issuedAt?: string | null };
      setLink({ url: data.url ?? null, issuedAt: data.issuedAt ?? null });
    } catch {
      /* the print routes still work; the link line just stays quiet */
    }
  }, [propertyId]);

  useEffect(() => {
    void load();
  }, [load]);

  const revoke = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/portal/house-public-link", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ propertyId }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        showToast?.(data.error ?? "Could not turn the link off.");
        return;
      }
      setLink({ url: null, issuedAt: null });
      showToast?.("Link turned off. Printed posters no longer open. Print again for a new one.");
    } finally {
      setBusy(false);
    }
  }, [propertyId, showToast]);

  const welcomeHref = `/print/welcome/${encodeURIComponent(propertyId)}?${new URLSearchParams({
    ...(roomId ? { room: roomId } : {}),
    ...(residentName.trim() ? { resident: residentName.trim() } : {}),
  }).toString()}`;

  const printLink = (href: string, label: string, dataAttr: string) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex min-h-[40px] items-center justify-center rounded-full border border-border bg-card px-4 text-sm font-semibold text-foreground hover:bg-accent/40"
      data-attr={dataAttr}
    >
      {label}
    </a>
  );

  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-card" data-attr="house-printables">
      <div className="px-4 py-3">
        <p className="text-sm font-semibold text-foreground">Printables</p>
        <p className="text-xs text-muted">
          Made from the details above, so they are never out of date the way a hand-made poster is.
        </p>
      </div>
      <div className="space-y-4 border-t border-border px-4 pb-4 pt-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            {printLink(`/print/door-card/${encodeURIComponent(propertyId)}`, "Door card", "house-printables-door-card")}
            {printLink(`/print/house-rules/${encodeURIComponent(propertyId)}`, "House rules poster", "house-printables-rules")}
            <span className="portal-badge-info rounded-full px-2 py-0.5 text-[10px] font-semibold">Public · no codes</span>
          </div>
          <p className="mt-2 text-xs text-muted">
            Both carry a QR that opens the house rules and trash days — never a door code or the Wi-Fi.
          </p>
          {link?.url ? (
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted" data-attr="house-printables-link">
              <a href={link.url} target="_blank" rel="noreferrer" className="font-mono text-foreground underline underline-offset-2">
                {link.url.replace(/^https?:\/\//, "")}
              </a>
              <button
                type="button"
                className="font-semibold text-foreground underline underline-offset-2 disabled:opacity-50"
                disabled={busy}
                onClick={() => void revoke()}
                data-attr="house-printables-revoke"
              >
                Turn the link off
              </button>
            </div>
          ) : (
            <p className="mt-2 text-xs text-muted">The QR link is created the first time you open a card or poster.</p>
          )}
        </div>

        <div className="rounded-xl border border-dashed border-border p-3">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold text-foreground">Welcome sheet</p>
            <span className="portal-badge-notice rounded-full px-2 py-0.5 text-[10px] font-semibold">Private · has codes</span>
          </div>
          <p className="mt-1 text-xs text-muted">
            Door codes, Wi-Fi and the room&apos;s move-in notes on one page. Print it and hand it over — it is never a link.
          </p>
          <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
            {rooms.length > 0 ? (
              <FieldSingleSelect
                label="Room"
                value={roomId}
                onChange={setRoomId}
                options={rooms.map((room) => ({
                  value: room.id,
                  label: room.floor?.trim() ? `${room.name} · ${room.floor}` : room.name,
                }))}
              />
            ) : (
              <div className="text-xs text-muted">Whole home — no room to pick.</div>
            )}
            <label className="block">
              <span className="mb-1 block text-xs font-semibold text-muted">Resident (optional)</span>
              <Input
                value={residentName}
                onChange={(e) => setResidentName(e.target.value)}
                placeholder="Maya"
                aria-label="Resident name"
              />
            </label>
            <Button asChild variant="primary" className="rounded-full">
              <a href={welcomeHref} target="_blank" rel="noreferrer" data-attr="house-printables-welcome">
                Open welcome sheet
              </a>
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
