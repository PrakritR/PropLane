"use client";

import { useMemo, useState } from "react";
import {
  HOUSE_INFO_SECTIONS,
  parseLegacyHouseText,
  type HouseInfoV1,
} from "@/lib/house-info";

/**
 * Review screen for migrating a property's free-text house notes into sections.
 *
 * The split is only ever a PROPOSAL. The manager sees every field it would set,
 * every paragraph it would drop, and what would be kept verbatim — and nothing
 * is written until they press Apply. A parser that guessed wrong must cost a
 * click, not a house's information.
 */
export function HouseInfoSplitReview({
  legacy,
  onApply,
  onCancel,
}: {
  legacy: {
    generalHouseInfo: string;
    houseRulesText: string;
    wifiNetworkName: string;
    wifiPassword: string;
  };
  onApply: (info: HouseInfoV1) => void;
  onCancel: () => void;
}) {
  const split = useMemo(() => parseLegacyHouseText(legacy), [legacy]);
  const [dropPortalHelp, setDropPortalHelp] = useState(true);

  const grouped = useMemo(() => {
    return HOUSE_INFO_SECTIONS.map((spec) => ({
      label: spec.label,
      rows: split.matched.filter((m) => m.sectionId === spec.id),
    })).filter((group) => group.rows.length > 0);
  }, [split]);

  const apply = () => {
    // Keeping the portal help means keeping it where a resident still reads it:
    // appended to "Anything else", not silently discarded because the free-text
    // boxes are about to be cleared.
    const other = dropPortalHelp
      ? split.info.other
      : [split.info.other, ...split.portalHelp].filter(Boolean).join("\n\n");
    onApply({ ...split.info, other });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label="Review the house details split"
      data-attr="house-info-split-dialog"
    >
      <div className="flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-t-2xl border border-border bg-card sm:rounded-2xl">
        <header className="border-b border-border px-5 py-4">
          <h2 className="text-base font-semibold text-foreground">Review the split</h2>
          <p className="mt-1 text-xs text-muted">
            Nothing is lost. Anything not recognised is kept word for word under <b>Anything else</b>, and your
            original notes stay recoverable on the record.
          </p>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {grouped.length === 0 ? (
            <p className="text-sm text-muted">
              Nothing in your notes matched a section. You can fill the sections in by hand instead.
            </p>
          ) : (
            grouped.map((group) => (
              <section key={group.label} className="rounded-xl border border-border px-4 py-3">
                <h3 className="mb-1 text-sm font-semibold text-foreground">{group.label}</h3>
                <dl>
                  {group.rows.map((row) => (
                    <div key={`${row.key}-${row.label}`} className="flex flex-wrap gap-x-3 gap-y-1 border-b border-border/50 py-2 last:border-0">
                      <dt className="w-full text-xs text-muted sm:w-40">{row.label}</dt>
                      <dd className="min-w-0 flex-1 break-words text-sm text-foreground">{row.value}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))
          )}

          {split.portalHelp.length > 0 ? (
            <section className="rounded-xl border border-[color:var(--status-pending-fg)]/35 bg-[var(--status-pending-bg)] px-4 py-3">
              <h3 className="mb-1 text-sm font-semibold text-[color:var(--status-pending-fg)]">
                Text PropLane now writes for you
              </h3>
              <p className="mb-2 text-xs text-[color:var(--status-pending-fg)]">
                Residents already see how Services, Payments, Lease and Inbox work. You do not have to keep your own
                copy of it.
              </p>
              <div className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg bg-card/70 px-3 py-2 text-xs text-foreground">
                {split.portalHelp.join("\n\n")}
              </div>
              <label className="mt-2 flex items-center gap-2 text-xs font-medium text-foreground">
                <input
                  type="checkbox"
                  checked={dropPortalHelp}
                  onChange={(e) => setDropPortalHelp(e.target.checked)}
                  data-attr="house-info-drop-portal-help"
                />
                Remove it — PropLane says it for me
              </label>
            </section>
          ) : null}

          {split.leftover ? (
            <section className="rounded-xl border border-border px-4 py-3">
              <h3 className="mb-1 text-sm font-semibold text-foreground">Kept verbatim under “Anything else”</h3>
              <div className="max-h-48 overflow-y-auto whitespace-pre-wrap text-xs leading-relaxed text-muted">
                {split.leftover}
              </div>
            </section>
          ) : null}
        </div>

        <footer className="flex flex-wrap justify-end gap-2 border-t border-border px-5 py-3">
          <button
            type="button"
            className="rounded-full border border-border px-4 py-2 text-xs font-semibold text-muted hover:text-foreground"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded-full bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50"
            onClick={apply}
            disabled={grouped.length === 0}
            data-attr="house-info-split-apply"
          >
            Apply the split
          </button>
        </footer>
      </div>
    </div>
  );
}
