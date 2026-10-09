"use client";

import { useState } from "react";
import { Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, Select } from "@/components/ui/input";
import { MODAL_FIELD_LABEL_CLASS } from "@/components/ui/modal";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalEntryRow } from "@/components/portal/portal-entry-row";
import { growthApi } from "@/lib/growth/client";
import { GROWTH_PLATFORMS, GROWTH_PUBLISHER_IDS, type GrowthAccount, type GrowthPlatform, type GrowthPublisherId } from "@/lib/growth/types";
import { GrowthErrorBanner, PLATFORM_LABEL, useGrowthLoad } from "@/components/portal/growth-shared";

const PUBLISHER_KEY_ENV: Partial<Record<GrowthPublisherId, string>> = {
  late: "GROWTH_LATE_API_KEY",
  upload_post: "GROWTH_UPLOAD_POST_API_KEY",
  meta: "GROWTH_META_PAGE_TOKEN",
};

const STATUS_TONE: Record<GrowthAccount["status"], "success" | "warning" | "danger" | "neutral"> = {
  connected: "success",
  expiring: "warning",
  disconnected: "danger",
  paused: "neutral",
};

export function GrowthAccountsTab() {
  const { data, error, loading, reload } = useGrowthLoad(() => growthApi.listAccounts());
  const accounts = data?.accounts;
  const status = data?.publisher ?? null;
  // An account's own non-log publisher wins; otherwise the environment default. "log" needs no key.
  const missingKey = (a: GrowthAccount): string | null => {
    if (!status) return null;
    const id = a.publisher !== "log" ? a.publisher : status.publisher;
    return id && id !== "log" && status.keys?.[id] === false ? PUBLISHER_KEY_ENV[id] ?? null : null;
  };
  const [platform, setPlatform] = useState<GrowthPlatform>("instagram");
  const [handle, setHandle] = useState("");
  const [publisher, setPublisher] = useState<GrowthPublisherId>("log");
  const [vendorAccountId, setVendorAccountId] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);

  const add = async () => {
    setSaving(true);
    setFormError(null);
    const res = await growthApi.createAccount({ platform, handle: handle.trim(), publisher, vendorAccountId: vendorAccountId.trim() || null });
    setSaving(false);
    if (!res.ok) {
      setFormError(res.error);
      return;
    }
    setHandle("");
    setVendorAccountId("");
    reload();
  };

  const toggle = async (a: GrowthAccount) => {
    setToggling(a.id);
    setFormError(null);
    const res = await growthApi.patchAccount(a.id, { status: a.status === "paused" ? "connected" : "paused" });
    setToggling(null);
    if (!res.ok) setFormError(res.error);
    else reload();
  };

  return (
    <div className="space-y-4" data-attr="admin-growth-accounts">
      <p className="text-xs text-muted" data-attr="admin-growth-accounts-note">
        Tokens live in the vendor or in env, never here. This list only holds the handle and which publisher posts for it.
      </p>
      {status && !status.configured ? (
        <p
          role="status"
          className="rounded-2xl border border-[var(--status-pending-fg)]/30 bg-[var(--status-pending-bg)] px-4 py-2 text-xs font-medium text-[var(--status-pending-fg)]"
          data-attr="admin-growth-accounts-publisher-banner"
        >
          {status.message ?? "No publisher configured"} in this environment. Posts will not publish until GROWTH_PUBLISHER and its key are set.
        </p>
      ) : null}
      <PortalRecordListSurface
        loading={loading}
        loadError={error ?? undefined}
        onRetry={reload}
        isEmpty={(accounts ?? []).length === 0}
        empty={<p className="px-4 py-8 text-center text-sm text-muted" data-attr="admin-growth-accounts-empty">No accounts connected yet. Add one below.</p>}
        dataAttr="admin-growth-accounts-list"
      >
        {(accounts ?? []).map((a) => (
          <div key={a.id} data-attr="admin-growth-account-row" data-status={a.status}>
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <PortalEntryRow
                tile={{ kind: "glyph", icon: Share2, label: PLATFORM_LABEL[a.platform] }}
                title={`${PLATFORM_LABEL[a.platform]} · ${a.handle}`}
                facts={[{ label: `via ${a.publisher}` }]}
                dataAttr="admin-growth-account"
              />
            </div>
            <Badge tone={STATUS_TONE[a.status]}>{a.status}</Badge>
            {a.status === "expiring" || a.status === "disconnected" ? (
              <span className="text-xs font-semibold text-primary" data-attr="admin-growth-account-reconnect">
                Reconnect in {a.publisher === "meta" ? "Meta" : "the vendor dashboard"}
              </span>
            ) : null}
            <Button
              type="button"
              variant="outline"
              className="h-8 px-3 text-xs"
              data-attr="admin-growth-account-toggle"
              loading={toggling === a.id}
              onClick={() => void toggle(a)}
            >
              {a.status === "paused" ? "Resume" : "Pause"}
            </Button>
          </div>
          {missingKey(a) ? (
            <p className="px-4 pb-2 text-xs font-semibold text-[var(--status-pending-fg)]" data-attr="admin-growth-account-key-missing">
              Key missing: {missingKey(a)}
            </p>
          ) : null}
          </div>
        ))}
      </PortalRecordListSurface>
      {formError ? <GrowthErrorBanner message={formError} dataAttr="admin-growth-accounts-form-error" /> : null}
      <form
        className="grid grid-cols-1 gap-3 rounded-2xl border border-border bg-card p-4 sm:grid-cols-2"
        data-attr="admin-growth-account-form"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <h3 className="text-sm font-semibold text-foreground sm:col-span-2">Add account</h3>
        <label className="block">
          <span className={MODAL_FIELD_LABEL_CLASS}>Platform</span>
          <Select value={platform} onChange={(e) => setPlatform(e.target.value as GrowthPlatform)} aria-label="Platform" data-attr="admin-growth-account-platform">
            {GROWTH_PLATFORMS.map((p) => (
              <option key={p} value={p}>
                {PLATFORM_LABEL[p]}
              </option>
            ))}
          </Select>
        </label>
        <label className="block">
          <span className={MODAL_FIELD_LABEL_CLASS}>Handle</span>
          <Input value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="@proplane" data-attr="admin-growth-account-handle" />
        </label>
        <label className="block">
          <span className={MODAL_FIELD_LABEL_CLASS}>Publisher</span>
          <Select value={publisher} onChange={(e) => setPublisher(e.target.value as GrowthPublisherId)} aria-label="Publisher" data-attr="admin-growth-account-publisher">
            {GROWTH_PUBLISHER_IDS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </Select>
        </label>
        <label className="block">
          <span className={MODAL_FIELD_LABEL_CLASS}>Vendor account id</span>
          <Input value={vendorAccountId} onChange={(e) => setVendorAccountId(e.target.value)} placeholder="optional" data-attr="admin-growth-account-vendor-id" />
        </label>
        <div className="sm:col-span-2">
          <Button type="submit" data-attr="admin-growth-account-add" disabled={!handle.trim()} loading={saving}>
            Add account
          </Button>
        </div>
      </form>
    </div>
  );
}
