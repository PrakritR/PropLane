import "server-only";

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

export function defaultPublisherId(): GrowthPublisherId {
  const v = process.env.GROWTH_PUBLISHER?.trim() as GrowthPublisherId | undefined;
  return v && (GROWTH_PUBLISHER_IDS as readonly string[]).includes(v) ? v : "log";
}

export function getPublisher(id: GrowthPublisherId): GrowthPublisher {
  return DRIVERS[id];
}

/** The account's own publisher wins; otherwise the GROWTH_PUBLISHER default. */
export function resolvePublisher(account: Pick<GrowthAccount, "publisher"> | null): GrowthPublisher {
  const own = account?.publisher;
  // `log` on an account row is the column default, so it defers to the env default when one is set.
  if (own && own !== "log") return DRIVERS[own];
  return DRIVERS[defaultPublisherId()];
}

export function allPublishers(): GrowthPublisher[] {
  return Object.values(DRIVERS);
}
