"use client";

/**
 * The resident's manager contact(s), fetched ONCE per page and shared.
 *
 * Two surfaces need it — the contact card at the top of the conversation list
 * and the house line on every row — and they render together, so a per-consumer
 * fetch would double an already-uncached request on every Communication mount.
 * One in-flight promise is reused and the result is memoized for the life of
 * the page, matching how the rest of the portal shares read-only lookups.
 */
import { useEffect, useState } from "react";
import { onPortalSessionViewerChange } from "@/lib/auth/portal-session-gate";
import { isDemoModeActive } from "@/lib/demo/demo-session";

export type ResidentManagerContact = {
  managerName: string | null;
  phone: string | null;
  assistantEmail: string | null;
  propertyLabel: string | null;
  leaseStart: string | null;
  leaseEnd: string | null;
  status: "current" | "upcoming" | "ended";
};

let cached: ResidentManagerContact[] | null = null;
let inFlight: Promise<ResidentManagerContact[]> | null = null;

/**
 * Drop everything when the signed-in account changes.
 *
 * This is a MODULE-LEVEL cache, so without this a sign-out and sign-in in the
 * same tab would hand the next resident the previous one's manager, phone
 * number and house — synchronously, before any fetch could correct it. That is
 * the same leak the inbox caches were hardened against; the route is correctly
 * scoped, so the only way to reintroduce it is here.
 */
export function resetResidentManagerContactsCache(): void {
  cached = null;
  inFlight = null;
}

if (typeof window !== "undefined") {
  onPortalSessionViewerChange(() => resetResidentManagerContactsCache());
}

function load(): Promise<ResidentManagerContact[]> {
  if (cached) return Promise.resolve(cached);
  if (inFlight) return inFlight;
  inFlight = fetch("/api/resident/manager-contact", { credentials: "include", cache: "no-store" })
    .then((res) => (res.ok ? res.json() : null))
    .then((body) => {
      const rows =
        body && typeof body === "object"
          ? (body as { contacts?: ResidentManagerContact[] }).contacts
          : null;
      const next = Array.isArray(rows)
        ? rows.filter((row) => Boolean(row?.phone?.trim() || row?.assistantEmail?.trim()))
        : [];
      cached = next;
      return next;
    })
    .catch(() => {
      // A missing number is not an error worth surfacing — the card is simply
      // absent, exactly as it is for a manager who has none. Not cached, so a
      // later mount retries.
      return [];
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

export function useResidentManagerContacts(): ResidentManagerContact[] {
  const [contacts, setContacts] = useState<ResidentManagerContact[]>(() => cached ?? []);

  useEffect(() => {
    if (isDemoModeActive()) return;
    let cancelled = false;
    void load().then((rows) => {
      if (!cancelled) setContacts(rows);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return contacts;
}
