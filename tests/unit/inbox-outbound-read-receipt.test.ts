import { describe, expect, it } from "vitest";
import { annotateInboxOutboundReadReceipts } from "@/lib/inbox-outbound-read-receipt";

describe("annotateInboxOutboundReadReceipts", () => {
  it("marks an outbound turn read when a later inbound turn exists", () => {
    const out = annotateInboxOutboundReadReceipts([
      { direction: "outbound", delivery: "sent" },
      { direction: "inbound" },
    ]);
    expect(out[0]?.readByRecipient).toBe(true);
    expect(out[1]?.readByRecipient).toBeUndefined();
  });

  it("leaves the last outbound turn without a read tick", () => {
    const out = annotateInboxOutboundReadReceipts([{ direction: "outbound", delivery: "sent" }]);
    expect(out[0]?.readByRecipient).toBeUndefined();
  });
});
