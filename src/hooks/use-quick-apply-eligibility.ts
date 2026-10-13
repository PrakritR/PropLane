"use client";

import { useEffect, useState } from "react";
import { useProspectContactAutofill } from "@/hooks/use-prospect-contact-autofill";
import { roomChoiceValue } from "@/lib/rental-application/room-choice-value";
import { sharedGet } from "@/lib/shared-get-cache";

/**
 * The EXISTENCE-only read. The saved answers themselves (SSN, licence, ID photos, income proof) are the
 * wizard's business; a button that only has to decide its own label asks for the boolean and nothing else,
 * so none of that is ever pulled into the public listing bundle or left in the shared-GET cache.
 */
export const QUICK_APPLY_PROFILE_URL = "/api/portal/resident-application-autofill?exists=1";

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
      const hasProfile = result.ok && (result.data as { hasProfile?: unknown } | null)?.hasProfile === true;
      setState({ ready: true, hasProfile });
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
export function useQuickApplyEligibility(): {
  ready: boolean;
  eligible: boolean;
  identity: QuickApplyIdentity;
  /** The account every verdict below belongs to: the readiness cache is keyed on it, never shared. */
  accountId: string;
} {
  const autofill = useProspectContactAutofill();
  const signedInResident = autofill.ready && Boolean(autofill.userId) && autofill.hasResidentRole;
  const profile = useQuickApplyProfile(signedInResident);
  return {
    ready: autofill.ready && (!signedInResident || profile.ready),
    eligible: signedInResident && profile.hasProfile,
    identity: { name: autofill.name, email: autofill.email, phone: autofill.phone },
    accountId: autofill.userId ?? "",
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

/**
 * One listing's verdict: what the button says before a room is named, plus every room of the listing the
 * caller already applied to. The dry run costs a multi-read server round trip, so it is asked once per
 * listing and the per-room "you already applied" answer is read out of the SAME reply — picking a room,
 * or switching to Short stay and back, never spends another one.
 */
type ListingReadiness = { base: QuickApplyReadiness; appliedRooms: Record<string, string> };

const readinessCache = new Map<string, { at: number; promise: Promise<ListingReadiness> }>();

const appliedHref = (applicationId: string) =>
  `/resident/applications/pending/${encodeURIComponent(applicationId)}`;

/**
 * The listing's verdict is asked without a room, so the room the visitor actually picked is added to
 * the wizard link here — opening the full application on the room they were looking at, exactly as
 * when the room was part of the request.
 */
function withRoom(href: string, roomId: string): string {
  if (!roomId || href.includes("listingRoomId=")) return href;
  return `${href}${href.includes("?") ? "&" : "?"}listingRoomId=${encodeURIComponent(roomId)}`;
}

async function fetchReadiness(propertyId: string): Promise<ListingReadiness> {
  try {
    const res = await fetch("/api/portal/quick-apply", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ propertyId, dryRun: true }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      ready?: boolean;
      needsWizard?: boolean;
      needsPayment?: boolean;
      href?: string;
      existingApplicationId?: string;
      appliedRooms?: Record<string, string>;
    };
    const appliedRooms = body.appliedRooms && typeof body.appliedRooms === "object" ? body.appliedRooms : {};
    if (body.ready) return { base: { kind: "ready" }, appliedRooms };
    if ((body.needsWizard || body.needsPayment) && body.href) {
      return { base: { kind: "continue", href: body.href }, appliedRooms };
    }
    if (res.status === 409 && body.existingApplicationId) {
      return { base: { kind: "applied", href: appliedHref(body.existingApplicationId) }, appliedRooms };
    }
  } catch {
    /* the plain Apply door stays */
  }
  return { base: { kind: "unavailable" }, appliedRooms: {} };
}

/**
 * One request per listing per half minute, however many buttons on the page ask and whatever room they
 * hold. The key carries the ACCOUNT: the verdict names the caller's own application ids, so a sign-in
 * or account switch inside the window reads its own answer, never the previous account's.
 */
function readinessFor(accountId: string, propertyId: string): Promise<ListingReadiness> {
  const key = `${accountId}|${propertyId}`;
  const hit = readinessCache.get(key);
  if (hit && Date.now() - hit.at < READINESS_TTL_MS) return hit.promise;
  const promise = fetchReadiness(propertyId);
  readinessCache.set(key, { at: Date.now(), promise });
  return promise;
}

/** Forget what was learned (after a submit, so the next read sees the new application). */
export function resetQuickApplyReadiness(): void {
  readinessCache.clear();
}

/**
 * What the primary button should say for this listing: asks the server for a read-only verdict
 * (`dryRun`), once per listing. Nothing is saved by it. A named room is answered from the rooms that
 * same verdict already listed as applied to, so changing the room costs nothing.
 */
export function useQuickApplyReadiness(input: {
  enabled: boolean;
  propertyId: string;
  roomId: string;
  /** The signed-in account the verdict is asked for (`useQuickApplyEligibility().accountId`). */
  accountId: string;
}): QuickApplyReadiness {
  const { enabled, propertyId, roomId, accountId } = input;
  const key = enabled && propertyId && accountId ? `${accountId}|${propertyId}` : "";
  const [verdict, setVerdict] = useState<{ key: string; readiness: ListingReadiness } | null>(null);
  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    void readinessFor(accountId, propertyId).then((readiness) => {
      if (!cancelled) setVerdict({ key, readiness });
    });
    return () => {
      cancelled = true;
    };
  }, [accountId, key, propertyId]);
  if (!key) return { kind: "unavailable" };
  if (verdict?.key !== key) return { kind: "checking" };
  const applied = roomId ? verdict.readiness.appliedRooms[roomChoiceValue(propertyId, roomId)] : undefined;
  if (applied) return { kind: "applied", href: appliedHref(applied) };
  const base = verdict.readiness.base;
  return base.kind === "continue" ? { kind: "continue", href: withRoom(base.href, roomId) } : base;
}
