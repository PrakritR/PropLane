"use client";

import { useCallback, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import {
  persistManagerListingSubmissionOnServer,
  resolveManagerListingSubmissionForPropertyId,
} from "@/lib/manager-property-save-target";

export const PROMOTION_HOUSE_NOTES_MAX_CHARS = 2000;

/**
 * The "About this home" box on a property's Promotion tab: free text where the
 * manager keeps the Facebook / Craigslist ad title and copy, nicknames,
 * landmarks — anything a prospect might quote back over SMS. It is stored on
 * the listing submission as `marketingNotes`, which the leasing SMS assistant
 * searches, so "the locked room near UW" resolves to this listing (PRP-426).
 *
 * The notes are PUBLIC listing metadata: they reach prospects through the
 * assistant, so the copy says so and nothing private belongs here.
 */
export function PromotionHouseNotesCard({
  propertyId,
  managerUserId,
  revision = 0,
  showToast,
  onUpdated,
}: {
  propertyId: string;
  managerUserId: string | null;
  /** Bump when the property pipeline re-syncs so the saved value re-resolves. */
  revision?: number;
  showToast: (m: string) => void;
  onUpdated?: () => void;
}) {
  const resolved = useMemo(() => {
    void revision;
    if (!managerUserId || !propertyId.trim()) return null;
    return resolveManagerListingSubmissionForPropertyId(managerUserId, propertyId);
  }, [managerUserId, propertyId, revision]);
  const saved = resolved?.sub.marketingNotes ?? "";
  // `null` means "no unsaved edit": the box shows whatever is saved, and a
  // background re-sync can never overwrite text the manager is mid-typing.
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const value = draft ?? saved;
  const dirty = draft !== null && draft.trim() !== saved.trim();

  const save = useCallback(async () => {
    if (!resolved || !managerUserId || !dirty) return;
    const next: ManagerListingSubmissionV1 = { ...resolved.sub, marketingNotes: value.trim() };
    setSaving(true);
    try {
      const ok = await persistManagerListingSubmissionOnServer(resolved.saveTarget, managerUserId, next);
      if (!ok) {
        showToast("Could not save the notes about this home.");
        return;
      }
      setDraft(null);
      showToast("Notes saved. The texting assistant can use them now.");
      onUpdated?.();
    } finally {
      setSaving(false);
    }
  }, [resolved, managerUserId, dirty, value, showToast, onUpdated]);

  if (!resolved) return null;

  return (
    <section
      className="rounded-2xl border border-border bg-card p-4 sm:p-5"
      data-attr="promotion-house-notes"
      data-testid="promotion-house-notes"
    >
      <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-muted">About this home</p>
      <p className="mt-1.5 text-xs leading-relaxed text-muted">
        Paste the title and text of your Facebook or Craigslist ad, plus anything else a renter might say about
        this home — a nickname, a landmark, what makes it special. When someone texts your work number quoting
        the ad, the assistant uses these notes to find this listing. Renters can see this, so keep codes and
        private details out.
      </p>
      <Textarea
        value={value}
        onChange={(e) => setDraft(e.target.value.slice(0, PROMOTION_HOUSE_NOTES_MAX_CHARS))}
        rows={5}
        maxLength={PROMOTION_HOUSE_NOTES_MAX_CHARS}
        placeholder={'e.g. Facebook: "Private locked room near University of Washington" — furnished, 5 min walk to campus, utilities included.'}
        aria-label="Notes about this home for the texting assistant"
        className="mt-3"
        data-attr="promotion-house-notes-input"
      />
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <span className="text-xs text-muted">
          {value.length}/{PROMOTION_HOUSE_NOTES_MAX_CHARS}
        </span>
        <div className="flex items-center gap-2">
          {dirty ? (
            <Button
              type="button"
              variant="outline"
              className="h-9 min-h-0 rounded-full px-4 text-[13px]"
              onClick={() => setDraft(null)}
              disabled={saving}
              data-attr="promotion-house-notes-discard"
            >
              Discard
            </Button>
          ) : null}
          <Button
            type="button"
            variant="primary"
            className="h-9 min-h-0 rounded-full px-4 text-[13px]"
            onClick={() => save()}
            disabled={!dirty || saving}
            data-attr="promotion-house-notes-save"
          >
            {saving ? "Saving…" : "Save notes"}
          </Button>
        </div>
      </div>
    </section>
  );
}
