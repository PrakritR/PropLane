import { describe, expect, it } from "vitest";
import {
  classifyRecordActionId,
  isPostDividerRecordActionId,
  MAX_OWN_RECORD_ACTIONS,
  orderRecordActions,
} from "@/lib/portals/record-action-order";

describe("classifyRecordActionId", () => {
  it("recognizes the trailing ids case-insensitively", () => {
    expect(classifyRecordActionId("message")).toBe("message");
    expect(classifyRecordActionId("Message")).toBe("message");
    expect(classifyRecordActionId("copy")).toBe("link");
    expect(classifyRecordActionId("share")).toBe("link");
    expect(classifyRecordActionId("copy-link")).toBe("link");
    expect(classifyRecordActionId("archive")).toBe("archive");
    expect(classifyRecordActionId("delete")).toBe("delete");
    expect(classifyRecordActionId("remove")).toBe("delete");
  });

  it("classifies anything else as the record's own action", () => {
    expect(classifyRecordActionId("record-payment")).toBe("own");
    expect(classifyRecordActionId("edit")).toBe("own");
    expect(classifyRecordActionId("mark-done")).toBe("own");
  });
});

describe("isPostDividerRecordActionId", () => {
  it("is true only for archive and delete", () => {
    expect(isPostDividerRecordActionId("archive")).toBe(true);
    expect(isPostDividerRecordActionId("delete")).toBe(true);
    expect(isPostDividerRecordActionId("message")).toBe(false);
    expect(isPostDividerRecordActionId("copy")).toBe(false);
    expect(isPostDividerRecordActionId("edit")).toBe(false);
  });
});

describe("orderRecordActions", () => {
  it("sorts into own · message · copy/share · archive · delete, given in reverse", () => {
    const items = [
      { id: "delete" },
      { id: "archive" },
      { id: "share" },
      { id: "message" },
      { id: "edit" },
    ];
    expect(orderRecordActions(items).map((i) => i.id)).toEqual([
      "edit",
      "message",
      "share",
      "archive",
      "delete",
    ]);
  });

  it("keeps own actions in their given relative order", () => {
    const items = [{ id: "assign-vendor" }, { id: "schedule" }, { id: "close" }];
    expect(orderRecordActions(items).map((i) => i.id)).toEqual(["assign-vendor", "schedule", "close"]);
  });

  it("caps own actions at MAX_OWN_RECORD_ACTIONS", () => {
    expect(MAX_OWN_RECORD_ACTIONS).toBe(4);
    const items = [
      { id: "one" },
      { id: "two" },
      { id: "three" },
      { id: "four" },
      { id: "five" },
      { id: "message" },
    ];
    const ordered = orderRecordActions(items);
    expect(ordered.map((i) => i.id)).toEqual(["one", "two", "three", "four", "message"]);
  });

  it("puts the divider group (archive, delete) after copy/share even when declared first", () => {
    const items = [{ id: "archive" }, { id: "delete" }, { id: "copy" }, { id: "own-thing" }];
    expect(orderRecordActions(items).map((i) => i.id)).toEqual(["own-thing", "copy", "archive", "delete"]);
  });

  it("does not include Open — callers render it separately, always first", () => {
    const items = [{ id: "edit" }, { id: "delete" }];
    const ordered = orderRecordActions(items);
    expect(ordered.some((i) => i.id === "open")).toBe(false);
  });

  it("passes reversible through untouched", () => {
    const items = [
      { id: "mark-paid", reversible: true },
      { id: "delete", reversible: false },
    ];
    const ordered = orderRecordActions(items);
    expect(ordered[0]).toEqual({ id: "mark-paid", reversible: true });
    expect(ordered[1]).toEqual({ id: "delete", reversible: false });
  });

  it("handles an empty list", () => {
    expect(orderRecordActions([])).toEqual([]);
  });
});
