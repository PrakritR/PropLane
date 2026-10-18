"use client";

import { useCallback, useEffect, useState } from "react";
import { MessageSquare, Plus } from "lucide-react";
import { PortalPropertyRecordRow, PortalRowIconTile } from "@/components/portal/portal-record-row";
import { CopyIconAction, PortalIconAction } from "@/components/portal/portal-icon-action";
import { RowActionsMenu } from "@/components/portal/row-actions-menu";
import { fetchWithTimeout } from "@/lib/auth/fetch-with-timeout";

type CodeView = { code: string; propertyId: string; active: boolean; callToAction: string | null; smsLink: string | null };
type Loaded = { codes: CodeView[]; suggestion: string | null };

/** `sms:` links open the messages app; this copies one a manager can paste into a QR maker, a bio or an ad. */
async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    /* clipboard blocked: the visible call to action is still selectable */
  }
}

/**
 * The "Text code" row on a property's Promotion tab: the code stock flyers, signs and listings carry
 * ("Text BROOKLYN5 to (206) 555-0100"), a copy icon and a prefilled `sms:` link. The route answers 404 while
 * the line is per-workspace, which draws nothing at all: this row exists only on the shared line.
 */
export function PropertyTextCodeRow({ propertyId }: { propertyId: string }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let next: Loaded | null = null;
      try {
        const res = await fetchWithTimeout(`/api/portal/one-number/entry-codes?propertyId=${encodeURIComponent(propertyId)}`, {}, 15_000);
        if (res.ok) {
          const json = (await res.json().catch(() => null)) as (Partial<Loaded> & { codes?: CodeView[] }) | null;
          if (json?.codes) next = { codes: json.codes, suggestion: json.suggestion ?? null };
        }
      } catch {
        next = null;
      }
      if (!cancelled) setLoaded(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [propertyId, tick]);

  if (!loaded) return null;

  const live = loaded.codes.find((c) => c.active) ?? null;

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetchWithTimeout(
        "/api/portal/one-number/entry-codes",
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ propertyId, code: loaded.suggestion }) },
        15_000,
      );
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) setError(json.error ?? "Could not create a code.");
      reload();
    } finally {
      setBusy(false);
    }
  };

  const turnOff = async (code: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetchWithTimeout(
        `/api/portal/one-number/entry-codes/${encodeURIComponent(code)}`,
        { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ active: false }) },
        15_000,
      );
      if (!res.ok) setError("Could not turn this code off.");
      reload();
    } finally {
      setBusy(false);
    }
  };

  if (!live) {
    return (
      <PortalPropertyRecordRow
        title="Text code"
        summary={error ?? undefined}
        leading={<PortalRowIconTile icon={MessageSquare} />}
        leadingShape="square"
        actions={
          loaded.suggestion ? (
            <PortalIconAction icon={Plus} label={`Create ${loaded.suggestion}`} disabled={busy} data-attr="property-text-code-create" onClick={() => void create()} />
          ) : null
        }
        dataAttr="property-text-code-row"
      />
    );
  }

  const cta = live.callToAction ?? `Text ${live.code}`;
  return (
    <PortalPropertyRecordRow
      title={cta}
      summary={error ?? undefined}
      leading={<PortalRowIconTile icon={MessageSquare} />}
      leadingShape="square"
      actions={
        <>
          <CopyIconAction label="Copy text code" data-attr="property-text-code-copy" onCopy={() => copyText(cta)} />
          {live.smsLink ? (
            <CopyIconAction label="Copy text link" data-attr="property-text-code-link" onCopy={() => copyText(live.smsLink!)} />
          ) : null}
          <RowActionsMenu label="Actions for text code" items={[{ id: "turn-off", label: "Turn off", danger: true, disabled: busy, onSelect: () => void turnOff(live.code) }]} />
        </>
      }
      dataAttr="property-text-code-row"
    />
  );
}
