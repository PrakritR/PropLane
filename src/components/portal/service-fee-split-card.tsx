"use client";

/**
 * Settings > Balance & payouts > "Fee split" of a PropLane Service workspace: how each rent payment divides between
 * PropLane and the owner. A platform admin edits it (a new fee version through the admin Service route); the owner and
 * every other seat read one line. Who may edit is `canEdit` from `GET /api/workspaces/service-fee`, derived on the
 * server from the session - never from props the page computed - and the write is refused again by the admin route.
 */
import { useCallback, useEffect, useState } from "react";
import { Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PortalSettingsGroup, PortalSettingsRow, PortalSettingsSection } from "@/components/portal/portal-settings-ui";
import {
  DEFAULT_MANAGEMENT_FEE_PERCENT,
  MAX_MANAGEMENT_FEE_PERCENT,
  managementFeeSplitCents,
} from "@/lib/owner-management/fee-percent";

type SplitView = {
  split: { feePercent: number; version: number; since: string } | null;
  canEdit: boolean;
  viewerIsOwnerOfRecord: boolean;
};

const EXAMPLE_RENT_CENTS = 100_000;

function clampPercent(n: number): number {
  return Math.min(MAX_MANAGEMENT_FEE_PERCENT, Math.max(0, Math.round(n * 100) / 100));
}

function dollars(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
}

function percentText(n: number): string {
  return `${Number.isInteger(n) ? n : n.toFixed(2).replace(/0$/, "")}%`;
}

function sinceText(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return day;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export function ServiceFeeSplitCard({ workspaceId }: { workspaceId: string }) {
  const [view, setView] = useState<SplitView | null>(null);
  const [percent, setPercent] = useState(DEFAULT_MANAGEMENT_FEE_PERCENT);
  const [error, setError] = useState<string | null>(null);

  const fetchView = useCallback(async (): Promise<SplitView | null> => {
    try {
      const res = await fetch(`/api/workspaces/service-fee?workspaceId=${encodeURIComponent(workspaceId)}`, { cache: "no-store" });
      return res.ok ? ((await res.json()) as SplitView) : null;
    } catch {
      return null;
    }
  }, [workspaceId]);

  const apply = useCallback((next: SplitView | null) => {
    setView(next);
    if (next) {
      setPercent(next.split ? next.split.feePercent : DEFAULT_MANAGEMENT_FEE_PERCENT);
      setError(null);
    }
  }, []);

  useEffect(() => {
    let live = true;
    void fetchView().then((next) => {
      if (live) apply(next);
    });
    return () => {
      live = false;
    };
  }, [fetchView, apply]);

  if (!view) return null;
  const saved = view.split ? view.split.feePercent : null;

  if (!view.canEdit) {
    if (!view.split) return null;
    const ownerLabel = view.viewerIsOwnerOfRecord ? "You" : "Owner";
    return (
      <PortalSettingsSection id="fee-split" title="Fee split">
        <PortalSettingsGroup>
          <PortalSettingsRow label="Split">
            <span data-attr="service-fee-split-line" className="text-[15px] text-foreground">
              {`PropLane ${percentText(view.split.feePercent)} · ${ownerLabel} ${percentText(100 - view.split.feePercent)}`}
            </span>
          </PortalSettingsRow>
        </PortalSettingsGroup>
      </PortalSettingsSection>
    );
  }

  const ownerPercent = Math.round((100 - percent) * 100) / 100;
  const example = managementFeeSplitCents(EXAMPLE_RENT_CENTS, percent);
  const changed = saved === null ? true : percent !== saved;

  const save = async () => {
    setError(null);
    try {
      const res = await fetch("/api/admin/service-workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "fee", id: workspaceId, percent }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "Could not save the split.");
        return;
      }
      apply(await fetchView());
    } catch {
      setError("Could not save the split.");
    }
  };

  const stepButton =
    "grid size-8 shrink-0 place-items-center rounded-full border border-border bg-card text-foreground transition hover:border-primary/40 disabled:cursor-not-allowed disabled:opacity-40";

  return (
    <PortalSettingsSection id="fee-split" title="Fee split">
      <PortalSettingsGroup>
        <PortalSettingsRow label="Split">
          <span data-attr="service-fee-split-version" className="text-[15px] text-foreground">
            {view.split ? `Version ${view.split.version} · since ${sinceText(view.split.since)}` : "No version yet"}
          </span>
        </PortalSettingsRow>
        <PortalSettingsRow label="PropLane">
          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-label="Decrease PropLane percent"
              disabled={percent <= 0}
              onClick={() => setPercent((p) => clampPercent(p - 1))}
              data-attr="service-fee-split-decrement"
              className={stepButton}
            >
              <Minus className="size-3.5" aria-hidden />
            </button>
            <input
              type="number"
              inputMode="decimal"
              aria-label="PropLane percent"
              min={0}
              max={MAX_MANAGEMENT_FEE_PERCENT}
              step={1}
              value={percent}
              data-attr="service-fee-split-percent"
              onChange={(e) => {
                const n = Number(e.target.value);
                if (e.target.value.trim() !== "" && Number.isFinite(n)) setPercent(clampPercent(n));
              }}
              className="h-8 w-16 rounded-lg border border-border bg-card text-center text-sm font-semibold tabular-nums text-foreground [appearance:textfield] focus:outline-none focus:ring-2 focus:ring-primary/30 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            />
            <span className="text-sm text-foreground" aria-hidden>%</span>
            <button
              type="button"
              aria-label="Increase PropLane percent"
              disabled={percent >= MAX_MANAGEMENT_FEE_PERCENT}
              onClick={() => setPercent((p) => clampPercent(p + 1))}
              data-attr="service-fee-split-increment"
              className={stepButton}
            >
              <Plus className="size-3.5" aria-hidden />
            </button>
          </div>
        </PortalSettingsRow>
        <PortalSettingsRow label="Owner">
          <span data-attr="service-fee-split-owner" className="text-[15px] tabular-nums text-foreground">{percentText(ownerPercent)}</span>
        </PortalSettingsRow>
        <div className="flex min-h-12 items-center border-b border-border px-4 py-3">
          <div
            role="img"
            aria-label={`PropLane ${percentText(percent)}, Owner ${percentText(ownerPercent)}`}
            className="flex h-3 w-full overflow-hidden rounded-full bg-border"
          >
            <div className="h-full bg-primary transition-[width]" style={{ width: `${percent}%` }} data-attr="service-fee-split-bar-proplane" />
            <div className="h-full bg-success transition-[width]" style={{ width: `${ownerPercent}%` }} data-attr="service-fee-split-bar-owner" />
          </div>
        </div>
        <PortalSettingsRow
          label={<span data-attr="service-fee-split-example" className="tabular-nums">{`On $1,000 rent: PropLane ${dollars(example.feeCents)} · Owner ${dollars(example.ownerCents)}`}</span>}
        />
        <PortalSettingsRow label={error ? <span className="text-danger">{error}</span> : ""}>
          <Button type="button" variant="primary" disabled={!changed} onClick={() => save()} data-attr="service-fee-split-save">
            Save
          </Button>
        </PortalSettingsRow>
      </PortalSettingsGroup>
    </PortalSettingsSection>
  );
}
