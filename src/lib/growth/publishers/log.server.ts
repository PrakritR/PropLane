import "server-only";

import { randomUUID } from "node:crypto";
import type { GrowthPublisher, PublishInput } from "../types";

/** Records what would have been published and returns fake ids. For local dev and proofs. */
export const logPublished: Array<{ postId: string; platform: string; caption: string; at: string }> = [];

export const logPublisher: GrowthPublisher = {
  id: "log",
  async publish(input: PublishInput) {
    logPublished.push({ postId: input.post.id, platform: input.platform, caption: input.caption, at: new Date().toISOString() });
    const id = `log_${randomUUID()}`;
    return { ok: true, vendorPostId: id, platformPostId: id, platformUrl: null };
  },
};
