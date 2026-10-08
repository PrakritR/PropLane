import "server-only";

import { isProductionRuntime } from "@/lib/server-env";
import { GROWTH_PUBLISHER_IDS, type GrowthAccount, type GrowthPublisher, type GrowthPublisherId } from "../types";
import { latePublisher } from "./late.server";
import { logPublisher } from "./log.server";
import { metaPublisher } from "./meta.server";
import { uploadPostPublisher } from "./upload-post.server";

const DRIVERS: Record<GrowthPublisherId, GrowthPublisher> = {
  log: logPublisher,
  late: latePublisher,
  upload_post: uploadPostPublisher,
  meta: metaPublisher,
};

/** The explicitly configured default publisher, or null when GROWTH_PUBLISHER is unset/invalid. */
export function configuredPublisherId(): GrowthPublisherId | null {
  const v = process.env.GROWTH_PUBLISHER?.trim() as GrowthPublisherId | undefined;
  return v && (GROWTH_PUBLISHER_IDS as readonly string[]).includes(v) ? v : null;
}

/**
 * `log` fakes publishing, so it is allowed only outside production, or when GROWTH_PUBLISHER=log is set
 * explicitly. It is never allowed when VERCEL_ENV is "production", even if set explicitly.
 */
export function logDriverAllowed(): boolean {
  if (process.env.VERCEL_ENV === "production") return false;
  return configuredPublisherId() === "log" || !isProductionRuntime();
}

export function defaultPublisherId(): GrowthPublisherId | null {
  return configuredPublisherId() ?? (logDriverAllowed() ? "log" : null);
}

export function getPublisher(id: GrowthPublisherId): GrowthPublisher {
  return DRIVERS[id];
}

/**
 * The account's own (non-log) publisher wins; otherwise the GROWTH_PUBLISHER default. Returns null when
 * nothing real is configured and the log driver is not allowed (production), so the tick pauses instead of
 * fake-publishing.
 */
export function resolvePublisher(account: Pick<GrowthAccount, "publisher"> | null): GrowthPublisher | null {
  const own = account?.publisher;
  if (own && own !== "log") return DRIVERS[own];
  const id = defaultPublisherId();
  if (!id) return null;
  if (id === "log" && !logDriverAllowed()) return null;
  return DRIVERS[id];
}

/** Surfaced by the accounts/analytics APIs so the admin UI can show a "no publisher configured" banner. */
export function publisherStatus() {
  const resolved = resolvePublisher(null);
  return { configured: resolved !== null, publisher: resolved?.id ?? null, logDriverAllowed: logDriverAllowed(), message: resolved ? null : NO_PUBLISHER };
}

export const NO_PUBLISHER = "no publisher configured";

export function allPublishers(): GrowthPublisher[] {
  return Object.values(DRIVERS);
}
