import "server-only";

/** Platform leads (design-1112 §3.0 / §3.4). Signatures are the contract Package A and the inbox read; keep them exactly. */
export { CHANNEL_CAPABILITIES } from "@/lib/platform-leads/capabilities";
export type { ChannelCapability } from "@/lib/platform-leads/capabilities";
export { composePlatformReply } from "@/lib/platform-leads/compose";
