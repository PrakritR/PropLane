import { describe, expect, it } from "vitest";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { SERVER_OWNED_PUBLISH_KEYS, restoreServerPublishState } from "@/lib/service-publish-state";

const row = (extra: Partial<DemoManagerWorkOrderRow> = {}) => ({ id: "wo-1", title: "Sink", ...extra }) as DemoManagerWorkOrderRow;

describe("restoreServerPublishState", () => {
  it("a stale client copy cannot unpublish: the stored publish state wins", () => {
    const incoming = row({ published: false, title: "Edited title" });
    restoreServerPublishState(incoming, row({ published: true, publishRef: "pub_" + "a".repeat(32), publishBudgetCents: 25000, publishSharePhotos: true }));
    expect(incoming).toMatchObject({ title: "Edited title", published: true, publishRef: "pub_" + "a".repeat(32), publishBudgetCents: 25000, publishSharePhotos: true });
  });

  it("a client cannot forge a publish state on a row that has none", () => {
    const incoming = row({ published: true, publishRef: "pub_" + "b".repeat(32), publishBudgetCents: 1 });
    restoreServerPublishState(incoming, null);
    for (const key of SERVER_OWNED_PUBLISH_KEYS) expect(incoming[key]).toBeUndefined();
    expect(incoming.title).toBe("Sink");
  });

  it("a hire that took the service off the board is not undone by a stale republish", () => {
    const incoming = row({ published: true, publishRef: "pub_" + "c".repeat(32) });
    restoreServerPublishState(incoming, row({ published: false, publishRef: "pub_" + "c".repeat(32) }));
    expect(incoming.published).toBe(false);
  });
});
