import type { AccountLinkInviteDto } from "@/lib/account-links";
import { syncScheduleRecordsFromServer } from "@/lib/demo-admin-scheduling";
import { syncHouseholdChargesFromServer } from "@/lib/household-charges";
import { syncLeasePipelineFromServer } from "@/lib/lease-pipeline-storage";
import {
  MANAGER_APPLICATIONS_EVENT,
  syncManagerApplicationsFromServer,
} from "@/lib/manager-applications-storage";
import {
  MANAGER_INBOX_STORAGE_KEY,
  RESIDENT_INBOX_STORAGE_KEY,
  VENDOR_INBOX_STORAGE_KEY,
  syncPersistedInboxFromServer,
} from "@/lib/portal-inbox-storage";
import type { PortalKind } from "@/lib/portal-types";

const PREFETCH_TTL_MS = 15_000;
const ACCOUNT_LINKS_TTL_MS = 30_000;

export type AccountLinksResponse = {
  invites: AccountLinkInviteDto[];
  migrationRequired?: boolean;
};

let managerPrefetchAt = 0;
let managerPrefetchPromise: Promise<void> | null = null;

let residentPrefetchAt = 0;
let residentPrefetchPromise: Promise<void> | null = null;

let vendorPrefetchAt = 0;
let vendorPrefetchPromise: Promise<void> | null = null;

let accountLinksAt = 0;
let accountLinksPromise: Promise<AccountLinksResponse> | null = null;
let cachedAccountLinksResponse: AccountLinksResponse = { invites: [] };
/**
 * Has a real answer about this account's links ever landed?
 *
 * The cache starts `{ invites: [] }`, which reads identically to "fetched, and
 * this account co-manages nothing". Anything that treats an empty link list as
 * a FACT — the first-listing seed does — has to be able to tell those apart, or
 * it acts on a portfolio it has not finished loading. A failed fetch CLEARS this
 * even after an earlier success: not knowing is not the same as knowing there
 * are none, and a stale `true` over a wiped cache is the confident wrong answer.
 */
let accountLinksKnownOk = false;

/** Last successful account-links payload (for co-manager property access before relationship sync settles). */
export function readCachedAccountLinkInvites(): AccountLinkInviteDto[] {
  return cachedAccountLinksResponse.invites;
}

/** True once a successful account-links answer has landed. See {@link accountLinksKnownOk}. */
export function accountLinksKnown(): boolean {
  return accountLinksKnownOk;
}

/** Drop the TTL so the next fetchAccountLinksCached round-trip hits the network. */
export function invalidateAccountLinksCache(): void {
  accountLinksAt = 0;
  accountLinksPromise = null;
}

/** Replace the invite cache immediately after a local accept/unlink (before the next fetch). */
export function seedAccountLinksCache(invites: AccountLinkInviteDto[], migrationRequired?: boolean): void {
  cachedAccountLinksResponse = { invites, migrationRequired };
  accountLinksAt = Date.now();
  accountLinksKnownOk = true;
}

/**
 * What a refused, unreachable or malformed account-links response leaves behind.
 *
 * An empty list here is ignorance, not an answer, so it must not read as one:
 * the known flag drops (even if an earlier fetch had set it), the last KNOWN
 * invites are kept rather than clobbered — they still gate co-manager property
 * access — and the TTL is dropped so the next call retries instead of serving
 * this non-answer for the rest of the window.
 */
function forgetAccountLinks(): AccountLinksResponse {
  cachedAccountLinksResponse = {
    invites: cachedAccountLinksResponse.invites,
    migrationRequired: true,
  };
  accountLinksKnownOk = false;
  accountLinksAt = 0;
  accountLinksPromise = null;
  return cachedAccountLinksResponse;
}

/** Deduped fetch for co-manager nav + account link sync. */
export async function fetchAccountLinksCached(): Promise<AccountLinksResponse> {
  const now = Date.now();
  if (accountLinksPromise && now - accountLinksAt < ACCOUNT_LINKS_TTL_MS) {
    return accountLinksPromise;
  }

  accountLinksAt = now;
  accountLinksPromise = (async () => {
    const res = await fetch("/api/pro/account-links", { credentials: "include", cache: "no-store" });
    const body = (await res.json()) as AccountLinksResponse & { error?: string };
    if (!res.ok || !Array.isArray(body?.invites)) return forgetAccountLinks();
    cachedAccountLinksResponse = {
      invites: body.invites,
      migrationRequired: body.migrationRequired,
    };
    accountLinksKnownOk = true;
    return cachedAccountLinksResponse;
  })().catch(() => forgetAccountLinks());

  return accountLinksPromise;
}

/** Warm shared portal caches once per session (sidebar + first panel mount). */
export function prefetchPortalData(kind: PortalKind, userId?: string | null): Promise<void> {
  if (kind === "manager" || kind === "pro") {
    const now = Date.now();
    if (managerPrefetchPromise && now - managerPrefetchAt < PREFETCH_TTL_MS) {
      return managerPrefetchPromise;
    }
    managerPrefetchAt = now;
    managerPrefetchPromise = Promise.allSettled([
      syncManagerApplicationsFromServer({ managerUserId: userId ?? undefined }),
      syncPersistedInboxFromServer(MANAGER_INBOX_STORAGE_KEY),
      syncLeasePipelineFromServer(userId ?? null),
      syncHouseholdChargesFromServer(),
      syncScheduleRecordsFromServer(),
    ]).then(() => undefined);
    return managerPrefetchPromise;
  }

  if (kind === "resident") {
    const now = Date.now();
    if (residentPrefetchPromise && now - residentPrefetchAt < PREFETCH_TTL_MS) {
      return residentPrefetchPromise;
    }
    residentPrefetchAt = now;
    residentPrefetchPromise = syncPersistedInboxFromServer(RESIDENT_INBOX_STORAGE_KEY).then(() => undefined);
    return residentPrefetchPromise;
  }

  if (kind === "vendor") {
    const now = Date.now();
    if (vendorPrefetchPromise && now - vendorPrefetchAt < PREFETCH_TTL_MS) {
      return vendorPrefetchPromise;
    }
    vendorPrefetchAt = now;
    vendorPrefetchPromise = syncPersistedInboxFromServer(VENDOR_INBOX_STORAGE_KEY).then(() => undefined);
    return vendorPrefetchPromise;
  }

  return Promise.resolve();
}

/** Bump application storage listeners after prefetch. */
export function notifyManagerApplicationsSynced(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(MANAGER_APPLICATIONS_EVENT));
  }
}
