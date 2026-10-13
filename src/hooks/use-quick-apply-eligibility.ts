"use client";

import { useEffect, useState } from "react";
import { useProspectContactAutofill } from "@/hooks/use-prospect-contact-autofill";
import { sharedGet } from "@/lib/shared-get-cache";

export const QUICK_APPLY_PROFILE_URL = "/api/portal/resident-application-autofill";

export type QuickApplyIdentity = { name: string; email: string; phone: string };

/**
 * Whether the signed-in account has saved application answers to reuse. One request per page load
 * (`sharedGet`), and only when `enabled`: a signed-out visitor never calls the route.
 */
export function useQuickApplyProfile(enabled: boolean): { ready: boolean; hasProfile: boolean } {
  const [state, setState] = useState<{ ready: boolean; hasProfile: boolean }>({ ready: false, hasProfile: false });
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void sharedGet(QUICK_APPLY_PROFILE_URL).then((result) => {
      if (cancelled) return;
      const profile = result.ok ? (result.data as { profile?: unknown } | null)?.profile : null;
      setState({ ready: true, hasProfile: Boolean(profile && typeof profile === "object") });
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return enabled ? state : { ready: false, hasProfile: false };
}

/**
 * Quick apply shows only for a signed-in resident (the public listing's session read) whose account
 * holds a saved application. Everyone else keeps the plain Apply door.
 */
export function useQuickApplyEligibility(): { ready: boolean; eligible: boolean; identity: QuickApplyIdentity } {
  const autofill = useProspectContactAutofill();
  const signedInResident = autofill.ready && Boolean(autofill.userId) && autofill.hasResidentRole;
  const profile = useQuickApplyProfile(signedInResident);
  return {
    ready: autofill.ready && (!signedInResident || profile.ready),
    eligible: signedInResident && profile.hasProfile,
    identity: { name: autofill.name, email: autofill.email, phone: autofill.phone },
  };
}

export type QuickApplyReadiness =
  | { kind: "checking" }
  | { kind: "ready" }
  /** The saved answers do not cover this listing, or a fee is owed: the button says Continue application. */
  | { kind: "continue"; href: string }
  /** The resident already applied to this room: the button opens that application. */
  | { kind: "applied"; href: string }
  | { kind: "unavailable" };

const READINESS_TTL_MS = 30_000;
const readinessCache = new Map<string, { at: number; promise: Promise<QuickApplyReadiness> }>();

async function fetchReadiness(propertyId: string, roomId: string): Promise<QuickApplyReadiness> {
  try {
    const res = await fetch("/api/portal/quick-apply", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ propertyId, roomId: roomId || undefined, dryRun: true }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      ready?: boolean;
      needsWizard?: boolean;
      needsPayment?: boolean;
      href?: string;
      existingApplicationId?: string;
    };
    if (body.ready) return { kind: "ready" };
    if ((body.needsWizard || body.needsPayment) && body.href) return { kind: "continue", href: body.href };
    if (res.status === 409 && body.existingApplicationId) {
      return { kind: "applied", href: `/resident/applications/pending/${encodeURIComponent(body.existingApplicationId)}` };
    }
  } catch {
    /* the plain Apply door stays */
  }
  return { kind: "unavailable" };
}

/** One request per listing and room per half minute, however many buttons on the page ask. */
function readinessFor(propertyId: string, roomId: string): Promise<QuickApplyReadiness> {
  const key = `${propertyId}|${roomId}`;
  const hit = readinessCache.get(key);
  if (hit && Date.now() - hit.at < READINESS_TTL_MS) return hit.promise;
  const promise = fetchReadiness(propertyId, roomId);
  readinessCache.set(key, { at: Date.now(), promise });
  return promise;
}

/** Forget what was learned (after a submit, so the next read sees the new application). */
export function resetQuickApplyReadiness(): void {
  readinessCache.clear();
}

/**
 * What the primary button should say for this listing: asks the server for a read-only verdict
 * (`dryRun`), once per listing and room. Nothing is saved by it.
 */
export function useQuickApplyReadiness(input: { enabled: boolean; propertyId: string; roomId: string }): QuickApplyReadiness {
  const { enabled, propertyId, roomId } = input;
  const key = enabled && propertyId ? `${propertyId}|${roomId}` : "";
  const [verdict, setVerdict] = useState<{ key: string; readiness: QuickApplyReadiness } | null>(null);
  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    void readinessFor(propertyId, roomId).then((readiness) => {
      if (!cancelled) setVerdict({ key, readiness });
    });
    return () => {
      cancelled = true;
    };
  }, [key, propertyId, roomId]);
  if (!key) return { kind: "unavailable" };
  return verdict?.key === key ? verdict.readiness : { kind: "checking" };
}
