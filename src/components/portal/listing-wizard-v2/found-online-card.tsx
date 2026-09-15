"use client";

/**
 * "We found this home" — the card under Street address on the Basics step.
 *
 * Fires once per address the manager PICKS from the autocomplete (never per
 * keystroke), shows the facts and rent estimate a records lookup returned, and
 * fills the step on one click. An earlier public ad is only pointed at; its
 * words arrive by the manager pasting them. Everything filled is marked on the
 * field and undone with one button. Plan: PLAN-0914-2208.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { Textarea } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { applyListingBedroomSlots, type ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import {
  applyExtractedAdToSubmission,
  applyFactsToSubmission,
  draftDescriptionFromFacts,
  undoPrefill,
} from "@/lib/listing-prefill/apply";
import {
  prefillAddressKey,
  type ExtractedAd,
  type ListingPrefillResult,
  type PrefillAddressInput,
} from "@/lib/listing-prefill/types";

type Patch = (next: Partial<ManagerListingSubmissionV1>) => void;

type CardStatus = "idle" | "loading" | "found" | "none" | "quota" | "error";

const btn = "inline-flex min-h-[32px] items-center gap-1.5 rounded-lg px-3 text-[12.5px] font-bold transition disabled:opacity-50";
const btnPrimary = cn(btn, "bg-primary text-white hover:bg-[var(--pl-blue-deep)]");
const btnSecondary = cn(btn, "border border-border bg-card text-foreground hover:bg-accent/40");

function money(n: number): string {
  return `$${n.toLocaleString("en-US")}`;
}

function monthLabel(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** The small "✦ Filled" / "✦ Imported" tag beside a field the prefill wrote. */
export function FieldMark({ kind }: { kind: "filled" | "imported" | "drafted" | null }) {
  if (!kind) return null;
  const text = kind === "filled" ? "Filled" : kind === "imported" ? "Imported" : "Drafted";
  return (
    <span
      data-attr="listing-v2-prefill-mark"
      className="inline-flex items-center gap-1 rounded-full bg-primary/[0.08] px-2 py-0.5 text-[10.5px] font-bold text-[var(--pl-blue-deep)]"
    >
      <span aria-hidden>✦</span>
      {text}
    </span>
  );
}

/** Merge a facts/ad patch into ONE editor patch, syncing rooms when bedrooms changed. */
function withRoomsSynced(sub: ManagerListingSubmissionV1, patch: Partial<ManagerListingSubmissionV1>): Partial<ManagerListingSubmissionV1> {
  if (patch.listingBedroomSlots == null) return patch;
  const merged = { ...sub, ...patch };
  const applied = applyListingBedroomSlots(merged, patch.listingBedroomSlots);
  if (!applied.ok || !patch.prefill) return patch;
  // The rooms the count created are remembered too, so Undo puts them back.
  const previous = "rooms" in patch.prefill.previous ? patch.prefill.previous : { ...patch.prefill.previous, rooms: sub.rooms };
  return { ...patch, rooms: applied.sub.rooms, prefill: { ...patch.prefill, previous } };
}

export function FoundOnlineCard({
  sub,
  patch,
  lookup,
}: {
  sub: ManagerListingSubmissionV1;
  patch: Patch;
  /** The address the manager picked from the dropdown; null until they do. */
  lookup: PrefillAddressInput | null;
}) {
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(false);
  /** Bumped by "Try again" so the lookup below runs for the same address once more. */
  const [attempt, setAttempt] = useState(0);
  /** The last answer, stamped with the address key and attempt it belongs to. */
  const [answer, setAnswer] = useState<{ key: string; attempt: number; data: ListingPrefillResult | null } | null>(null);

  const record = sub.prefill;
  const filledCount = (record?.fields.length ?? 0) + (record?.adFields.length ?? 0);
  const applied = filledCount > 0;
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

  useEffect(() => {
    if (!effectiveLookup || !key || dismissed) return;
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
        if (cancelled) return;
        setAnswer({ key, attempt: requested, data });
        setPasteOpen(false);
        setImportError(null);
      })
      .catch(() => {
        if (!cancelled) setAnswer({ key, attempt: requested, data: null });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, dismissed, attempt]);

  const current = answer && answer.key === key && answer.attempt === attempt ? answer : null;
  const result = current?.data ?? null;
  const status: CardStatus =
    !effectiveLookup || dismissed ? "idle" : !current ? "loading" : !result ? "error" : result.status === "unavailable" ? "idle" : result.status;
  const adImported = (record?.adFields.length ?? 0) > 0;
  const adHidden = record?.adDismissed === true;

  // Once something is filled the card stays (with Undo) even after the manager
  // leaves and returns to this step, which resets the picked address.
  if (!applied && (!effectiveLookup || dismissed || status === "idle")) return null;

  const retry = () => setAttempt((n) => n + 1);

  const useDetails = () => {
    if (!result?.facts) return;
    const { patch: next } = applyFactsToSubmission(sub, result.facts, result.rent, result.source ?? "rentcast");
    patch(withRoomsSynced(sub, next));
  };

  const notThisHome = () => {
    const base = sub.prefill ?? { source: result?.source ?? "rentcast", fetchedAt: new Date().toISOString(), fields: [], adFields: [], previous: {} };
    patch({ prefill: { ...base, dismissedAddressKey: key ?? undefined } });
  };

  const notMine = () => {
    const base = sub.prefill ?? { source: result?.source ?? "rentcast", fetchedAt: new Date().toISOString(), fields: [], adFields: [], previous: {} };
    patch({ prefill: { ...base, adDismissed: true } });
    setPasteOpen(false);
  };

  const undo = () => {
    patch(undoPrefill(sub));
    setPasteOpen(false);
    setPasteText("");
  };

  const importText = async () => {
    const text = pasteText.trim();
    if (text.length < 20) {
      setImportError("Paste the ad's headline and body first.");
      return;
    }
    setImporting(true);
    setImportError(null);
    try {
      const res = await fetch("/api/portal/listing-extract-ad", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const data = (await res.json()) as { ad?: ExtractedAd; error?: string };
      if (!res.ok || !data.ad) {
        setImportError(data.error ?? "Couldn't read a listing in that text.");
        return;
      }
      const { patch: next, fields } = applyExtractedAdToSubmission(sub, data.ad, result?.priorAd?.postedAt ?? null);
      if (fields.length === 0 && !data.ad.listedRentUsd) {
        setImportError("Couldn't read a listing in that text.");
        return;
      }
      patch(withRoomsSynced(sub, next));
      setPasteOpen(false);
      setPasteText("");
    } catch {
      setImportError("Couldn't read that text right now. Try again in a minute.");
    } finally {
      setImporting(false);
    }
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

  const priorAd = result?.priorAd ?? null;
  const showAd = Boolean(priorAd) && !adImported && !adHidden;

  const adBlock = showAd && priorAd ? (
    <div className="mt-2 border-t border-dashed border-primary/30 pt-2" data-attr="listing-v2-prefill-prior-ad">
      <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-1.5">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12.5px] font-bold text-foreground">
            Your {priorAd.site} ad{monthLabel(priorAd.postedAt) ? ` from ${monthLabel(priorAd.postedAt)}` : ""}?
          </div>
          <div className="truncate text-[11px] text-muted">
            {priorAd.title}
            {priorAd.listedRentUsd ? ` · ${money(priorAd.listedRentUsd)}/mo` : ""}
            {" · "}
            <a href={priorAd.url} target="_blank" rel="noreferrer noopener" className="font-semibold text-[var(--pl-blue-deep)] hover:underline">
              Open ↗
            </a>
          </div>
        </div>
      </div>
      {pasteOpen ? null : (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          <button type="button" className={btnPrimary} data-attr="listing-v2-prefill-paste" onClick={() => setPasteOpen(true)}>
            Paste it
          </button>
          <button type="button" className={btnSecondary} data-attr="listing-v2-prefill-not-mine" onClick={notMine}>
            Not mine
          </button>
        </div>
      )}
    </div>
  ) : null;

  const pasteBox =
    pasteOpen || (!showAd && !adImported && status !== "loading" && status !== "quota" && (status === "none" || applied)) ? (
      <div className="mt-2" data-attr="listing-v2-prefill-paste-box">
        {!showAd ? <div className="mb-1 text-[12.5px] font-bold text-foreground">Paste your ad</div> : null}
        <Textarea
          rows={3}
          value={pasteText}
          onChange={(e) => setPasteText(e.target.value)}
          placeholder="Paste the headline and body of your ad…"
          aria-label="Ad text"
          className="text-[12.5px]"
        />
        {importError ? <p className="mt-1 text-[11.5px] font-semibold text-red-600">{importError}</p> : null}
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <button type="button" className={btnPrimary} disabled={importing} data-attr="listing-v2-prefill-import" onClick={importText}>
            {importing ? "Reading…" : "Import"}
          </button>
          {showAd ? (
            <button type="button" className={btnSecondary} onClick={() => setPasteOpen(false)}>
              Cancel
            </button>
          ) : null}
        </div>
      </div>
    ) : null;

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
          <div className="mt-1.5 flex flex-wrap gap-1.5" data-attr="listing-v2-prefill-facts">
            {result.facts.propertyType ? <Chip>{{ house: "House", townhouse: "Townhouse", condo: "Condo", apartment: "Apartment", duplex: "Small building", other: "Home" }[result.facts.propertyType]}</Chip> : null}
            {result.facts.bedrooms ? <Chip>{result.facts.bedrooms} <Dim>bd</Dim></Chip> : null}
            {result.facts.bathrooms ? <Chip>{result.facts.bathrooms} <Dim>ba</Dim></Chip> : null}
            {result.facts.squareFeet ? <Chip>{result.facts.squareFeet.toLocaleString("en-US")} <Dim>sq ft</Dim></Chip> : null}
            {result.facts.yearBuilt ? <Chip>{result.facts.yearBuilt}</Chip> : null}
            {result.rent ? <Chip>≈ {money(result.rent.rentUsd)}<Dim>/mo</Dim></Chip> : null}
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <button type="button" className={btnPrimary} data-attr="listing-v2-prefill-apply" onClick={useDetails}>
              Use these details
            </button>
            <button type="button" className={btnSecondary} data-attr="listing-v2-prefill-dismiss" onClick={notThisHome}>
              Not this home
            </button>
          </div>
          {adBlock}
          {pasteBox}
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
          {adImported ? (
            <div className="mt-2 border-t border-dashed border-primary/30 pt-2 text-[12.5px] font-bold text-foreground" data-attr="listing-v2-prefill-ad-imported">
              Ad imported <span className="text-[var(--status-confirmed-fg)]">✦</span>
              <span className="ml-1.5 font-normal text-muted">
                {record?.listedRentUsd ? `Listed at ${money(record.listedRentUsd)} — shown on the Pricing step.` : "headline, description, amenities, pets"}
              </span>
            </div>
          ) : null}
          {adBlock}
          {pasteBox}
        </>
      ) : null}

      {status === "none" && !applied ? (
        <>
          <div className="text-[13.5px] font-bold text-foreground">Nothing found for this address.</div>
          {adBlock}
          {pasteBox}
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
            <Link href="/portal/settings?tab=plan" className={btnPrimary} data-attr="listing-v2-prefill-upgrade">
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

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-baseline gap-1 rounded-full border border-border bg-card px-2.5 py-0.5 text-[12.5px] font-bold text-foreground">
      {children}
    </span>
  );
}

function Dim({ children }: { children: React.ReactNode }) {
  return <span className="text-[10.5px] font-semibold text-muted">{children}</span>;
}
