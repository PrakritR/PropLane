import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import {
  listingSyndicationHasStreetAddress,
  listingSyndicationPhotoUrls,
} from "@/lib/listing-syndication/zillow-feed";

export type ZillowSyndicationStatusCode =
  | "off"
  | "unlisted"
  | "blocked"
  | "queued"
  | "sent"
  | "live"
  | "rejected";

export type ZillowSyndicationBlocker = "street_address" | "photo";

export type ZillowSyndicationStatus = {
  code: ZillowSyndicationStatusCode;
  /** User-visible status line (matches studio replica). */
  text: string;
  blockers: ZillowSyndicationBlocker[];
};

function syndicationBlockers(sub: ManagerListingSubmissionV1): ZillowSyndicationBlocker[] {
  const blockers: ZillowSyndicationBlocker[] = [];
  if (!listingSyndicationHasStreetAddress(sub.address)) blockers.push("street_address");
  if (listingSyndicationPhotoUrls(sub).length === 0) blockers.push("photo");
  return blockers;
}

function blockerPhrase(blockers: ZillowSyndicationBlocker[]): string {
  const parts: string[] = [];
  if (blockers.includes("street_address")) parts.push("a street address");
  if (blockers.includes("photo")) parts.push("a photo");
  return parts.join(" and ");
}

function formatPacificStamp(iso: string | undefined): string {
  if (!iso?.trim()) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  try {
    return d
      .toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZone: "America/Los_Angeles",
      })
      .replace(",", "");
  } catch {
    return "";
  }
}

/**
 * Honest manager-facing syndication status. `listingStatus` is the property
 * pipeline bucket the UI already knows (`live` | `draft` | `unlisted` | …).
 */
export function resolveZillowSyndicationStatus(args: {
  sub: ManagerListingSubmissionV1;
  listingStatus?: string | null;
  /** When false, the manager turned syndication off without clearing history. */
  syndicationSwitchOn?: boolean;
}): ZillowSyndicationStatus {
  const { sub, listingStatus, syndicationSwitchOn = true } = args;
  const zillow = sub.syndication?.zillow;
  const enabled = syndicationSwitchOn && zillow?.enabled === true;
  const blockers = syndicationBlockers(sub);

  if (!enabled) {
    return { code: "off", text: "Not sent", blockers };
  }
  if (listingStatus === "unlisted" || listingStatus === "queue") {
    return { code: "unlisted", text: "Unlisted", blockers };
  }
  if (blockers.length > 0) {
    return {
      code: "blocked",
      text: `Not sent: needs ${blockerPhrase(blockers)}`,
      blockers,
    };
  }
  if (listingStatus === "draft") {
    return { code: "queued", text: "Queued · sends when you publish", blockers };
  }
  if (zillow?.status === "rejected") {
    return { code: "rejected", text: "Rejected by Zillow", blockers };
  }
  if (zillow?.status === "live" && zillow.sentAt) {
    const stamp = formatPacificStamp(zillow.sentAt);
    return { code: "live", text: stamp ? `Live · sent ${stamp}` : "Live", blockers };
  }
  if (zillow?.status === "sent" && zillow.sentAt) {
    const stamp = formatPacificStamp(zillow.sentAt);
    return { code: "sent", text: stamp ? `Sent · ${stamp}` : "Sent · usually live within 24 hours", blockers };
  }
  if (zillow?.sentAt) {
    const stamp = formatPacificStamp(zillow.sentAt);
    return { code: "queued", text: stamp ? `Queued · ${stamp}` : "Queued", blockers };
  }
  return { code: "queued", text: "Queued · sends when you publish", blockers };
}
