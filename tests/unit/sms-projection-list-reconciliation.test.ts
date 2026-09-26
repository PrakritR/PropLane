import { describe, expect, it } from "vitest";
import type { ManagerSmsResidentConversation } from "@/lib/manager-sms-messages";
import { applySmsProjectionListMutation } from "@/lib/sms-projection-list-reconciliation";

const row = (projectionId: string, archived = false, stateVersion = 1) =>
  ({ projectionId, archived, stateVersion } as ManagerSmsResidentConversation);

describe("loaded SMS projection pages", () => {
  it("archives and restores a second-page row using the returned versions", () => {
    const loaded = [row("page-one"), row("page-two"), row("page-two-neighbor")];
    const archived = applySmsProjectionListMutation(loaded, {
      updated: [{ projectionId: "page-two", archived: true, version: 2 }], deleted: [],
    });
    expect(archived.filter((item) => item.archived)).toHaveLength(1);
    expect(archived.find((item) => item.projectionId === "page-two")?.stateVersion).toBe(2);
    const restored = applySmsProjectionListMutation(archived, {
      updated: [{ projectionId: "page-two", archived: false, version: 3 }], deleted: [],
    });
    expect(restored.filter((item) => item.archived)).toHaveLength(0);
    expect(restored.find((item) => item.projectionId === "page-two")?.stateVersion).toBe(3);
    expect(restored.map((item) => item.projectionId)).toEqual(loaded.map((item) => item.projectionId));
  });

  it("removes only a successfully deleted second-page row", () => {
    const loaded = [row("page-one"), row("page-two"), row("page-two-neighbor")];
    expect(applySmsProjectionListMutation(loaded, { updated: [], deleted: ["page-two"] })
      .map((item) => item.projectionId)).toEqual(["page-one", "page-two-neighbor"]);
  });

  it("keeps a conflicted row for detail reconciliation and ignores stale versions", () => {
    const loaded = [row("page-one"), row("page-two", false, 7), row("page-two-neighbor")];
    const next = applySmsProjectionListMutation(loaded, {
      updated: [{ projectionId: "page-one", archived: true, version: 2 },
        { projectionId: "page-two", archived: true, version: 6 }], deleted: [],
    });
    expect(next.find((item) => item.projectionId === "page-one")?.archived).toBe(true);
    expect(next.find((item) => item.projectionId === "page-two")).toEqual(loaded[1]);
    expect(next[2]).toEqual(loaded[2]);
  });
});
