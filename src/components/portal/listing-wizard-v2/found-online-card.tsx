"use client";

/**
 * "We found this home" — the card under Street address on the Basics step.
 *
 * Fires once per address the manager PICKS from the autocomplete (never per
 * keystroke), and only while the listing is still blank
 * (`listingIsBlankForPrefill`): a listing that already has a home type, rooms,
 * bathrooms, size or year never shows the card and never spends a lookup.
 * The card lists every entry the click will fill — one row each, the same rows
 * `applyFactsToSubmission` writes — and fills them on one click. Everything
 * filled is marked on its field and undone with one button.
 * Plans: PLAN-0914-2208, PLAN-0915-1947.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { houseDefaultsForSubmission, type ListingHouseDefaults } from "@/lib/listing-house-defaults";
import {
  applyFactsToSubmission,
  draftDescriptionFromFacts,
  listingIsBlankForPrefill,
  prefillEntries,
  undoPrefill,
  type PrefillEntry,
} from "@/lib/listing-prefill/apply";
import { prefillAddressKey, type ListingPrefillResult, type PrefillAddressInput } from "@/lib/listing-prefill/types";

type Patch = (next: Partial<ManagerListingSubmissionV1>) => void;

type CardStatus = "idle" | "loading" | "found" | "none" | "quota" | "error";

const btn = "inline-flex min-h-[32px] items-center gap-1.5 rounded-lg px-3 text-[12.5px] font-bold transition disabled:opacity-50";
const btnPrimary = cn(btn, "bg-primary text-white hover:bg-[var(--pl-blue-deep)]");
const btnSecondary = cn(btn, "border border-border bg-card text-foreground hover:bg-accent/40");

function money(n: number): string {
  return `$${n.toLocaleString("en-US")}`;
}

/** The small "✦ Filled" / "✦ Imported" / "✦ Estimated" tag beside a field the prefill wrote. */
export function FieldMark({ kind }: { kind: "filled" | "imported" | "estimated" | "drafted" | null }) {
  if (!kind) return null;
  const text = kind === "filled" ? "Filled" : kind === "imported" ? "Imported" : kind === "estimated" ? "Estimated" : "Drafted";
  return (
    <span
      data-attr="listing-v2-prefill-mark"
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-bold",
        kind === "estimated" ? "bg-[var(--status-overdue-bg,#fdf0d5)] text-[var(--status-overdue-fg,#a34a06)]" : "bg-primary/[0.08] text-[var(--pl-blue-deep)]",
      )}
    >
      <span aria-hidden>✦</span>
      {text}
    </span>
  );
}

export function FoundOnlineCard({
  sub,
  patch,
  lookup,
  onHouseDefaults,
}: {
  sub: ManagerListingSubmissionV1;
  patch: Patch;
  /** The address the manager picked from the dropdown; null until they do. */
  lookup: PrefillAddressInput | null;
  /**
   * The editor keeps the Default room in its own state, read once from the
   * listing; a fill or an undo that moves the Default room's rent tells it so
   * the Pricing step shows the same number the rooms carry.
   */
  onHouseDefaults?: (next: ListingHouseDefaults) => void;
}) {
  const [drafting, setDrafting] = useState(false);
  /** Bumped by "Try again" so the lookup below runs for the same address once more. */
  const [attempt, setAttempt] = useState(0);
  /** The last answer, stamped with the address key and attempt it belongs to. */
  const [answer, setAnswer] = useState<{ key: string; attempt: number; data: ListingPrefillResult | null } | null>(null);

  const record = sub.prefill;
  const filledCount = record?.fields.length ?? 0;
  const applied = filledCount > 0;
  const blank = listingIsBlankForPrefill(sub);
  // Leaving and returning to this step forgets the picked address; while
  // something is filled, the listing's own address stands in for it, and it
  // stays pinned through Undo so "We found this home" can come back (a repeat
  // lookup is a free cache hit). A new pick or "Not this home" replaces it.
  const derivedLookup: PrefillAddressInput | null =
    lookup ?? (applied && sub.address.trim() ? { address: sub.address, city: sub.city, state: sub.state, zip: sub.zip } : null);
  const [pinned, setPinned] = useState<PrefillAddressInput | null>(null);
  // Derived state, adjusted during render (the React-sanctioned shape): the
  // pin follows whatever address is currently in play.
  if (derivedLookup && (!pinned || prefillAddressKey(pinned) !== prefillAddressKey(derivedLookup))) setPinned(derivedLookup);
  const effectiveLookup = derivedLookup ?? pinned;
  const key = effectiveLookup ? prefillAddressKey(effectiveLookup) : null;
  const dismissed = Boolean(key && sub.prefill?.dismissedAddressKey === key);
  // The gate: a lookup runs only while there is something to fill. Once the
  // click filled the listing it is no longer blank, so the fill itself must
  // not close the gate — `applied` keeps the answer alive for Undo.
  const active = Boolean(effectiveLookup && key && !dismissed && (blank || applied));

  useEffect(() => {
    if (!active || !effectiveLookup || !key) return;
    // No "already ran" guard here: React's development double-invoke of a
    // mount effect would leave the second run early-returning while the first
    // run's answer is discarded as cancelled, and the card would sit on
    // "Looking up…". The cancel flag is the whole guard; a repeat is a free
    // cache hit. Nothing is set synchronously — loading is derived below.
    let cancelled = false;
    const requested = attempt;
    fetch("/api/portal/listing-prefill", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(effectiveLookup),
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        return (await res.json()) as ListingPrefillResult;
      })
      .then((data) => {
        if (!cancelled) setAnswer({ key, attempt: requested, data });
      })
      .catch(() => {
        if (!cancelled) setAnswer({ key, attempt: requested, data: null });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, active, attempt]);

  const current = answer && answer.key === key && answer.attempt === attempt ? answer : null;
  const result = current?.data ?? null;
  const status: CardStatus = !active ? "idle" : !current ? "loading" : !result ? "error" : result.status === "unavailable" ? "idle" : result.status;

  // Once something is filled the card stays (with Undo) even after the manager
  // leaves and returns to this step, which resets the picked address.
  if (!applied && (!active || status === "idle")) return null;

  const retry = () => setAttempt((n) => n + 1);

  const entries: PrefillEntry[] = status === "found" && !applied && result?.facts ? prefillEntries(sub, result.facts, result.rent) : [];

  const useDetails = () => {
    if (!result?.facts) return;
    const { patch: next } = applyFactsToSubmission(sub, result.facts, result.rent, result.source ?? "rentcast");
    patch(next);
    if (next.houseDefaults) onHouseDefaults?.(houseDefaultsForSubmission({ ...sub, ...next }));
  };

  const notThisHome = () => {
    const base = sub.prefill ?? { source: result?.source ?? "rentcast", fetchedAt: new Date().toISOString(), fields: [], adFields: [], previous: {} };
    patch({ prefill: { ...base, dismissedAddressKey: key ?? undefined } });
  };

  const undo = () => {
    const next = undoPrefill(sub);
    patch(next);
    if ("houseDefaults" in next) onHouseDefaults?.(houseDefaultsForSubmission({ ...sub, ...next }));
  };

  const writeDescription = async () => {
    setDrafting(true);
    try {
      const facts = draftDescriptionFromFacts(sub);
      let body = facts;
      let hook = sub.tagline;
      // The same traced copywriter the Promotion tab uses; the facts are its only input.
      try {
        const res = await fetch("/api/portal/promotion-text-generate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            format: "listing_blurb",
            propertyLabel: sub.buildingName || sub.address,
            inputs: { address: [sub.address, sub.city].filter(Boolean).join(", "), customDetails: facts, headline: sub.tagline },
          }),
        });
        if (res.ok) {
          const data = (await res.json()) as { copy?: { hook?: string; body?: string } };
          if (data.copy?.body?.trim()) body = data.copy.body.trim();
          if (!hook.trim() && data.copy?.hook?.trim()) hook = data.copy.hook.trim();
        }
      } catch {
        /* the offline draft stands */
      }
      const base = sub.prefill ?? { source: "rentcast" as const, fetchedAt: new Date().toISOString(), fields: [], adFields: [], previous: {} };
      const previous = { ...base.previous };
      const adFields = [...base.adFields];
      const next: Partial<ManagerListingSubmissionV1> = {};
      if (!sub.houseOverview.trim()) {
        if (!("houseOverview" in previous)) previous.houseOverview = sub.houseOverview;
        if (!adFields.includes("houseOverview")) adFields.push("houseOverview");
        next.houseOverview = body;
      }
      if (!sub.tagline.trim() && hook.trim()) {
        if (!("tagline" in previous)) previous.tagline = sub.tagline;
        if (!adFields.includes("tagline")) adFields.push("tagline");
        next.tagline = hook;
      }
      patch({ ...next, prefill: { ...base, previous, adFields } });
    } finally {
      setDrafting(false);
    }
  };

  return (
    <div
      className="mb-4 rounded-xl border border-[var(--pl-blue-soft)] bg-[linear-gradient(180deg,rgba(40,99,240,.06),rgba(40,99,240,.02))] px-3 py-2.5"
      data-attr="listing-v2-prefill-card"
      data-state={status}
    >
      {status === "loading" && !applied ? (
        <>
          <div className="text-[13.5px] font-bold text-foreground">Looking up {effectiveLookup?.address ?? "this address"}…</div>
          <div className="mt-2 grid gap-1.5" aria-hidden>
            <div className="h-2.5 w-[70%] rounded bg-foreground/[0.06]" />
            <div className="h-2.5 w-[40%] rounded bg-foreground/[0.06]" />
          </div>
        </>
      ) : null}

      {status === "found" && !applied && result?.facts ? (
        <>
          <div className="text-[13.5px] font-bold text-foreground">We found this home</div>
          <div className="mt-2 overflow-hidden rounded-lg border border-border bg-card" data-attr="listing-v2-prefill-entries">
            {entries.map((e) => (
              <div
                key={e.key}
                className="grid min-h-[36px] grid-cols-[minmax(84px,120px)_minmax(0,1fr)_auto] items-center gap-2.5 border-t border-border px-3 py-1.5 text-[13px] first:border-t-0"
                data-attr={`listing-v2-prefill-entry-${e.key}`}
              >
                <span className="font-semibold text-muted">{e.label}</span>
                <span className="min-w-0 font-bold text-foreground">
                  {e.value}
                  {e.detail ? <span className="ml-1 text-[11.5px] font-semibold text-muted">{e.detail}</span> : null}
                  {e.makes ? <span className="ml-1 text-[11.5px] font-semibold text-muted">→ {e.makes}</span> : null}
                </span>
                {e.kind === "estimated" ? (
                  <FieldMark kind="estimated" />
                ) : e.kind === "reference" ? (
                  <span className="whitespace-nowrap rounded-full bg-muted/40 px-2 py-0.5 text-[10.5px] font-bold text-muted">shown on Pricing</span>
                ) : (
                  <span />
                )}
              </div>
            ))}
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <button type="button" className={btnPrimary} data-attr="listing-v2-prefill-apply" onClick={useDetails}>
              Use these details
            </button>
            <button type="button" className={btnSecondary} data-attr="listing-v2-prefill-dismiss" onClick={notThisHome}>
              Not this home
            </button>
          </div>
        </>
      ) : null}

      {applied ? (
        <>
          <div className="flex flex-wrap items-center gap-2 text-[13.5px] font-bold text-foreground">
            Filled in {filledCount} {filledCount === 1 ? "detail" : "details"}
            <span className="rounded-full bg-[var(--status-confirmed-bg)] px-1.5 text-[11px] text-[var(--status-confirmed-fg)]" aria-hidden>
              ✦
            </span>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <button type="button" className={btnSecondary} data-attr="listing-v2-prefill-undo" onClick={undo}>
              Undo
            </button>
            {!sub.houseOverview.trim() ? (
              <button type="button" className={btnSecondary} disabled={drafting} data-attr="listing-v2-prefill-draft" onClick={writeDescription}>
                {drafting ? "Writing…" : "Write a description"}
              </button>
            ) : null}
          </div>
        </>
      ) : null}

      {status === "none" && !applied ? (
        <>
          <div className="text-[13.5px] font-bold text-foreground">
            {result?.rent ? <>Nothing on record for this home · rent estimate ≈ {money(result.rent.rentUsd)}/mo</> : "Nothing found for this address."}
          </div>
          <div className="mt-2">
            <button type="button" className={btnSecondary} onClick={retry}>
              Try again
            </button>
          </div>
        </>
      ) : null}

      {status === "quota" ? (
        <>
          <div className="flex flex-wrap items-center gap-2 text-[13.5px] font-bold text-foreground">
            3 free lookups used this month
            <span className="rounded-full bg-[var(--status-overdue-bg,#fdf0d5)] px-2 py-0.5 text-[10.5px] text-[var(--status-overdue-fg,#a34a06)]">Free</span>
          </div>
          <div className="mt-2">
            <Link href="/portal/profile?tab=billing" className={btnPrimary} data-attr="listing-v2-prefill-upgrade">
              Upgrade to Pro
            </Link>
          </div>
        </>
      ) : null}

      {status === "error" ? (
        <>
          <div className="text-[13.5px] font-bold text-foreground">Lookup unavailable right now.</div>
          <div className="mt-2">
            <button type="button" className={btnSecondary} onClick={retry}>
              Try again
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}
