import { describe, expect, it } from "vitest";
import { ALL_RECORD_KINDS, orderHeaderActions, recordSections, type RecordHeaderAction } from "@/lib/portals/record-sections";
import { Archive, Copy, Download, Pencil, Share2, Trash2 } from "lucide-react";

/**
 * C011: primary-first and delete-red-last-with-confirm were already real
 * invariants — this locks in the one still missing: whichever of
 * edit/share/export/duplicate a kind's own header actions carry, they always
 * appear in that fixed relative order, and Delete always sorts last, no
 * matter what order a kind's own definition authored them in.
 */
function action(id: string, tone?: RecordHeaderAction["tone"]): RecordHeaderAction {
  const icon = { edit: Pencil, share: Share2, export: Download, download: Download, copy: Copy, duplicate: Copy, archive: Archive, delete: Trash2 }[
    id as "edit"
  ] ?? Pencil;
  return { id, label: id, icon, tone };
}

describe("orderHeaderActions", () => {
  it("leaves an already-canonical order untouched", () => {
    const actions = [action("view-public"), action("edit"), action("share"), action("copy"), action("delete", "danger")];
    expect(orderHeaderActions(actions).map((a) => a.id)).toEqual(["view-public", "edit", "share", "copy", "delete"]);
  });

  it("fixes edit/share/export/duplicate into the canonical relative order regardless of authored order", () => {
    const actions = [action("primary"), action("share"), action("edit"), action("delete", "danger")];
    expect(orderHeaderActions(actions).map((a) => a.id)).toEqual(["primary", "edit", "share", "delete"]);
  });

  it("forces Delete to the end even if a kind authors it early", () => {
    const actions = [action("primary"), action("delete", "danger"), action("edit"), action("share")];
    expect(orderHeaderActions(actions).map((a) => a.id)).toEqual(["primary", "edit", "share", "delete"]);
  });

  it("never moves a kind-specific action (Approve, Decline, Reassign, …) relative to the others", () => {
    // "decline" is not part of the canonical edit/share/export/duplicate
    // vocabulary — this only reorders share/archive among themselves, never
    // pulls decline past them just because it is unranked.
    const actions = [action("approve"), action("decline", "danger"), action("share"), action("archive")];
    expect(orderHeaderActions(actions).map((a) => a.id)).toEqual(["approve", "decline", "share", "archive"]);
  });

  it("never reorders a single action or an empty list", () => {
    expect(orderHeaderActions([action("delete", "danger")]).map((a) => a.id)).toEqual(["delete"]);
    expect(orderHeaderActions([]).map((a) => a.id)).toEqual([]);
  });
});

describe("record-sections: cross-kind header icon order (C011)", () => {
  it.each(ALL_RECORD_KINDS)("$role/$kind: Delete is always last and red when present", ({ role, kind }) => {
    const sections = recordSections(role, kind, { basePath: `/${role === "manager" ? "portal" : role}` });
    const ids = sections.headerActions.map((a) => a.id);
    const deleteIndex = ids.indexOf("delete");
    if (deleteIndex !== -1) {
      expect(deleteIndex).toBe(ids.length - 1);
      expect(sections.headerActions[deleteIndex]!.tone).toBe("danger");
    }
  });

  it.each(ALL_RECORD_KINDS)("$role/$kind: edit precedes share precedes export/download precedes copy/duplicate, whichever follow the kind's own primary action", ({ role, kind }) => {
    const sections = recordSections(role, kind, { basePath: `/${role === "manager" ? "portal" : role}` });
    // The primary (first) action is the kind's own "next step" (View public,
    // Message, Record payment, even Download for a document) and is never
    // part of this canonical ordering — only what follows it is.
    const ids = sections.headerActions.slice(1).map((a) => a.id);
    const rank: Record<string, number> = { edit: 0, share: 1, export: 2, download: 2, copy: 3, duplicate: 3 };
    const present = ids.filter((id) => id in rank).map((id) => rank[id]!);
    const sorted = [...present].sort((a, b) => a - b);
    expect(present).toEqual(sorted);
  });
});
