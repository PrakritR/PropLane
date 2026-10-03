"use client";

import { useEffect, useState } from "react";
import { useWorkspaces } from "@/components/portal/workspace-provider";
import type { MockProperty } from "@/data/types";
import { cacheLeasingPipelinePreferences } from "@/lib/leasing-pipeline-client-cache";
import {
  normalizeLeasingPipelinePreferences,
  signingContextForPipeline,
  type PublicSigningContext,
} from "@/lib/leasing-pipeline-preferences";

/**
 * The manager's Preview must say "Sign lease" exactly when the public page will.
 * The public projection stamps `signingOrder` / `leaseSigningFeeCents` server-side
 * from the manager's leasing-pipeline preference; this reads the same preference
 * (the settings route already resolves it for the property) and collapses it with
 * the SAME `signingContextForPipeline` the projection uses — one rule, not a copy.
 * Returns `null` until loaded (the page then renders as application-first, like an
 * anonymous visitor's first paint, and flips the moment the answer lands).
 */
export function useListingSigningContext(opts: {
  listingId?: string | null;
  enabled?: boolean;
}): PublicSigningContext | null {
  const workspace = useWorkspaces();
  const listingId = opts.listingId?.trim() || null;
  const workspaceId =
    workspace?.workspaces.find((w) => listingId && w.propertyIds.includes(listingId))?.id ?? workspace?.active?.id;
  const enabled = opts.enabled !== false && Boolean(listingId);
  const [context, setContext] = useState<PublicSigningContext | null>(null);

  useEffect(() => {
    if (!enabled || !listingId) {
      setContext(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const params = new URLSearchParams();
        if (workspaceId) params.set("workspaceId", workspaceId);
        params.set("propertyId", listingId);
        const res = await fetch(`/api/portal/manager-application-settings?${params.toString()}`, {
          credentials: "include",
          cache: "no-store",
        });
        if (!res.ok) return;
        const data = (await res.json()) as { leasingPipeline?: unknown };
        if (cancelled) return;
        const prefs = normalizeLeasingPipelinePreferences(data.leasingPipeline);
        // Workspace-wide order, so caching the resolved prefs keeps the sync send-gate helpers honest too.
        cacheLeasingPipelinePreferences(prefs);
        setContext(signingContextForPipeline(prefs));
      } catch {
        /* keep the application-first default rather than guess */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, listingId, workspaceId]);

  return context;
}

/** Stamp the resolved pair onto the preview's property, the way `publicListingProjection` stamps the public one. */
export function withListingSigningContext(
  property: MockProperty,
  context: PublicSigningContext | null | undefined,
): MockProperty {
  if (!context) return property;
  if (
    property.signingOrder === context.signingOrder &&
    property.leaseSigningFeeCents === context.leaseSigningFeeCents &&
    property.applicationBeforeTour === context.applicationBeforeTour
  ) {
    return property;
  }
  return {
    ...property,
    signingOrder: context.signingOrder,
    leaseSigningFeeCents: context.leaseSigningFeeCents,
    applicationBeforeTour: context.applicationBeforeTour,
  };
}
