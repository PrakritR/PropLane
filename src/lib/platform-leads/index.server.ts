import "server-only";
import type { PlatformSource } from "@/lib/prospect-spine/contracts";

/** Platform leads (design-1112 §3.0). Stub: Package D replaces. */
export type ChannelCapability = {
  site: PlatformSource;
  label: string;
  /** manual_copy = draft shown in the thread with Copy, opened on the site. */
  replyMode: "email_relay" | "manual_copy";
  allowsLinkInMessage: boolean;
  allowsPhoneInMessage: boolean;
  notes: string;
};

export const CHANNEL_CAPABILITIES = {} as Record<PlatformSource, ChannelCapability>;

/** Strips what the site forbids and says what was removed. */
export function composePlatformReply(input: {
  site: PlatformSource; answer: string; propertyLabel: string; roomLabel?: string | null;
  listingUrl: string | null; textNumberDisplay: string; stitchCode: string | null;
}): { body: string; removed: string[] } {
  void input;
  throw new Error("platform-leads: not built");
}
