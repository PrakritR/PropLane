"use client";

/**
 * Settings > Business > AI info. The facts the AI on the vendor's PropLane number may
 * state when a client texts it. Service area and trades are read from the business
 * details (shown, not edited here); the rest are labeled text areas and one Save.
 */

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ListSkeleton } from "@/components/ui/list-skeleton";
import { Textarea } from "@/components/ui/input";
import {
  PortalSettingsFormBody,
  PortalSettingsGroup,
  PortalSettingsRow,
  PortalSettingsSection,
} from "@/components/portal/portal-settings-ui";
import type { useVendorBusinessProfile } from "@/components/portal/vendor-business-settings";
import {
  EMPTY_VENDOR_AI_INFO,
  VENDOR_AI_INFO_KEYS,
  VENDOR_AI_INFO_LABELS,
  VENDOR_AI_INFO_MAX_LENGTH,
  type VendorAiInfo,
} from "@/lib/vendor-ai-info";

type Ctx = ReturnType<typeof useVendorBusinessProfile>;

export function VendorAiInfoPane({ ctx }: { ctx: Ctx }) {
  const [draft, setDraft] = useState<VendorAiInfo>(ctx.profile.aiInfo ?? EMPTY_VENDOR_AI_INFO);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    setDraft(ctx.profile.aiInfo ?? EMPTY_VENDOR_AI_INFO);
  }, [ctx.profile.aiInfo]);

  async function save() {
    setError(null);
    setSaved(false);
    const result = await ctx.save({ aiInfo: draft });
    if (result.ok) setSaved(true);
    else setError(result.error ?? "Could not save.");
  }

  const trades = ctx.profile.trades ?? [];
  return (
    <PortalSettingsSection title="AI info">
      <PortalSettingsGroup>
        {ctx.loading ? (
          <div className="px-4 py-4">
            <ListSkeleton rows={4} showLeading={false} />
          </div>
        ) : (
          <>
            <PortalSettingsRow label="Service area">
              <span className="text-sm text-foreground" data-attr="vendor-ai-info-service-area">
                {ctx.profile.serviceArea || "—"}
              </span>
            </PortalSettingsRow>
            <PortalSettingsRow label="Trades">
              <span className="text-sm text-foreground" data-attr="vendor-ai-info-trades">
                {trades.length > 0 ? trades.join(", ") : "—"}
              </span>
            </PortalSettingsRow>
            <PortalSettingsFormBody>
              {VENDOR_AI_INFO_KEYS.map((key) => (
                <div key={key} className="space-y-1.5">
                  <label htmlFor={`vendor-ai-info-${key}`} className="text-sm font-medium text-foreground">
                    {VENDOR_AI_INFO_LABELS[key]}
                  </label>
                  <Textarea
                    id={`vendor-ai-info-${key}`}
                    value={draft[key]}
                    rows={key === "extra" ? 4 : 2}
                    maxLength={VENDOR_AI_INFO_MAX_LENGTH}
                    onChange={(event) => {
                      setDraft({ ...draft, [key]: event.target.value });
                      setSaved(false);
                    }}
                    data-attr={`vendor-ai-info-${key.replace(/_/g, "-")}`}
                  />
                </div>
              ))}
              {error ? (
                <p className="text-xs text-danger" role="alert">
                  {error}
                </p>
              ) : null}
              <div className="flex items-center justify-end gap-3">
                {saved ? (
                  <span className="text-xs font-semibold text-[var(--status-confirmed-fg,#15803d)]" aria-live="polite">
                    Saved
                  </span>
                ) : null}
                <Button variant="primary" onClick={() => save()} data-attr="vendor-ai-info-save">
                  Save
                </Button>
              </div>
            </PortalSettingsFormBody>
          </>
        )}
      </PortalSettingsGroup>
    </PortalSettingsSection>
  );
}
