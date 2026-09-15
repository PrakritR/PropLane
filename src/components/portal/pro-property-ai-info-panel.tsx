"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Textarea } from "@/components/ui/input";
import { PROMOTION_HOUSE_NOTES_MAX_CHARS } from "@/components/portal/promotion-house-notes";
import {
  type AiCommunicationInfo,
  type AiCommunicationInfoSection,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import {
  persistManagerListingSubmissionOnServer,
  resolveManagerListingSubmissionForPropertyId,
} from "@/lib/manager-property-save-target";

type SectionKey = "about" | AiCommunicationInfoSection;

/**
 * The property's AI info tab: five sections the leasing assistant reads when it
 * talks to a prospect about this home. "About this home" is the listing's
 * `marketingNotes` (public, searchable — a prospect quoting the ad lands here);
 * the other four are `aiCommunicationInfo`, assistant-only. Each section is a
 * textarea that saves itself when it loses focus.
 */
const SECTIONS: { key: SectionKey; title: string; placeholder: string }[] = [
  {
    key: "about",
    title: "About this home",
    placeholder:
      'e.g. Facebook: "Private locked room near University of Washington" — furnished, 5 min walk to campus, utilities included.',
  },
  {
    key: "tours",
    title: "Tours & showings",
    placeholder: "e.g. Tours weekdays after 4pm; meet at the side gate; virtual tours on request.",
  },
  {
    key: "rules",
    title: "House rules & policies",
    placeholder: "e.g. No smoking anywhere; quiet hours 10pm–8am; one cat allowed with deposit.",
  },
  {
    key: "pricing",
    title: "Pricing, deposits & lease terms",
    placeholder: "e.g. Rent includes wifi and water; $500 deposit; 12-month or month-to-month.",
  },
  {
    key: "neighborhood",
    title: "Neighborhood & getting around",
    placeholder: "e.g. Light rail 8 min walk; Trader Joe's on the corner; street parking with permit.",
  },
];

const EMPTY_INFO: AiCommunicationInfo = { tours: "", rules: "", pricing: "", neighborhood: "" };

function readSection(sub: ManagerListingSubmissionV1, key: SectionKey): string {
  if (key === "about") return sub.marketingNotes ?? "";
  return sub.aiCommunicationInfo?.[key] ?? "";
}

export function ManagerPropertyAiInfoPanel({
  propertyId,
  managerUserId,
  revision = 0,
  showToast,
  onUpdated,
}: {
  propertyId: string;
  managerUserId: string | null;
  /** Bump when the property pipeline re-syncs so saved values re-resolve. */
  revision?: number;
  showToast: (message: string) => void;
  onUpdated?: () => void;
}) {
  const resolved = useMemo(() => {
    void revision;
    if (!managerUserId || !propertyId.trim()) return null;
    return resolveManagerListingSubmissionForPropertyId(managerUserId, propertyId);
  }, [managerUserId, propertyId, revision]);

  // `null` per section means "no unsaved edit" — a background re-sync never
  // overwrites text the manager is mid-typing.
  const [drafts, setDrafts] = useState<Partial<Record<SectionKey, string | null>>>({});
  const [status, setStatus] = useState<Partial<Record<SectionKey, "saving" | "saved" | "error">>>({});

  useEffect(() => {
    setDrafts({});
  }, [propertyId]);

  const save = useCallback(
    async (key: SectionKey) => {
      if (!resolved || !managerUserId) return;
      const draft = drafts[key];
      if (draft === null || draft === undefined) return;
      const value = draft.trim();
      if (value === readSection(resolved.sub, key).trim()) {
        setDrafts((current) => ({ ...current, [key]: null }));
        return;
      }
      const next: ManagerListingSubmissionV1 =
        key === "about"
          ? { ...resolved.sub, marketingNotes: value }
          : {
              ...resolved.sub,
              aiCommunicationInfo: { ...EMPTY_INFO, ...(resolved.sub.aiCommunicationInfo ?? {}), [key]: value },
            };
      setStatus((current) => ({ ...current, [key]: "saving" }));
      const ok = await persistManagerListingSubmissionOnServer(resolved.saveTarget, managerUserId, next);
      if (!ok) {
        setStatus((current) => ({ ...current, [key]: "error" }));
        showToast("Could not save. Your text is still here — try again.");
        return;
      }
      setDrafts((current) => ({ ...current, [key]: null }));
      setStatus((current) => ({ ...current, [key]: "saved" }));
      onUpdated?.();
    },
    [drafts, managerUserId, onUpdated, resolved, showToast],
  );

  if (!resolved) return null;

  return (
    <div className="space-y-3 px-3 py-4 max-md:px-2.5" data-attr="property-ai-info">
      {SECTIONS.map((section) => {
        const saved = readSection(resolved.sub, section.key);
        const draft = drafts[section.key];
        const value = draft ?? saved;
        return (
          <section
            key={section.key}
            className="rounded-2xl border border-border bg-card p-4 sm:p-5"
            data-attr={`property-ai-info-${section.key}`}
          >
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-muted">{section.title}</p>
            <Textarea
              value={value}
              onChange={(e) =>
                setDrafts((current) => ({
                  ...current,
                  [section.key]: e.target.value.slice(0, PROMOTION_HOUSE_NOTES_MAX_CHARS),
                }))
              }
              onBlur={() => void save(section.key)}
              rows={4}
              maxLength={PROMOTION_HOUSE_NOTES_MAX_CHARS}
              placeholder={section.placeholder}
              aria-label={section.title}
              className="mt-3"
              data-attr={`property-ai-info-${section.key}-input`}
            />
            <div className="mt-2 flex items-center justify-between text-xs text-muted">
              <span>
                {value.length}/{PROMOTION_HOUSE_NOTES_MAX_CHARS}
              </span>
              <span aria-live="polite" className="font-semibold tabular-nums">
                {status[section.key] === "saving" ? "Saving…" : null}
                {status[section.key] === "saved" ? (
                  <span className="text-[var(--status-confirmed-fg,#15803d)]">Saved</span>
                ) : null}
                {status[section.key] === "error" ? <span className="text-red-600">Failed</span> : null}
              </span>
            </div>
          </section>
        );
      })}
    </div>
  );
}
