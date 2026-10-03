import { describe, expect, it } from "vitest";
import {
  MOVE_IN_FORM_ID_PATTERN, MOVE_IN_FORM_STARTERS, moveInFormDueAt, newMoveInFormTemplate, normalizeMoveInFormTemplates,
  readMoveInFormSettings, readMoveInFormTemplates, templateAppliesToRoom,
} from "@/lib/move-in-forms/templates";
import { DEFAULT_MOVE_IN_FORM_SETTINGS } from "@/lib/move-in-forms/types";

describe("move-in form starters", () => {
  it("ships exactly five built starters, all off", () => {
    expect(MOVE_IN_FORM_STARTERS.map((t) => t.starterKey)).toEqual([
      "move-in-checklist", "key-receipt", "vehicle-parking", "pet-agreement", "emergency-contacts",
    ]);
    for (const starter of MOVE_IN_FORM_STARTERS) {
      expect(starter.enabled).toBe(false);
      expect(starter.source).toBe("built");
      expect(starter.pdf ?? null).toBeNull();
      expect(MOVE_IN_FORM_ID_PATTERN.test(starter.id)).toBe(true);
      expect(starter.questions.length).toBeGreaterThan(2);
    }
  });

  it("covers keys, room condition with photos, contact and a signature in the checklist", () => {
    const checklist = MOVE_IN_FORM_STARTERS.find((t) => t.starterKey === "move-in-checklist")!;
    const types = checklist.questions.map((q) => q.type);
    expect(checklist.questions.some((q) => /key/i.test(q.label))).toBe(true);
    expect(types).toContain("photos");
    expect(types).toContain("phone");
    expect(types).toContain("signature");
  });

  it("builds the pet agreement from questions, so it needs no upload", () => {
    const pet = MOVE_IN_FORM_STARTERS.find((t) => t.starterKey === "pet-agreement")!;
    expect(pet.source).toBe("built");
    expect(pet.questions.length).toBeGreaterThan(3);
  });

  it("every starter survives its own normalizer unchanged", () => {
    expect(normalizeMoveInFormTemplates(MOVE_IN_FORM_STARTERS)).toEqual(MOVE_IN_FORM_STARTERS);
  });
});

describe("newMoveInFormTemplate", () => {
  it("copies a starter under a fresh, valid id and leaves it off", () => {
    const copy = newMoveInFormTemplate("built", "key-receipt");
    expect(copy.id).not.toBe("starter-key-receipt");
    expect(MOVE_IN_FORM_ID_PATTERN.test(copy.id)).toBe(true);
    expect(copy.enabled).toBe(false);
    expect(copy.questions).toEqual(MOVE_IN_FORM_STARTERS.find((t) => t.starterKey === "key-receipt")!.questions);
    copy.questions[0]!.label = "changed";
    expect(MOVE_IN_FORM_STARTERS.find((t) => t.starterKey === "key-receipt")!.questions[0]!.label).not.toBe("changed");
  });

  it("starts an upload form with a required signature", () => {
    const upload = newMoveInFormTemplate("upload");
    expect(upload.source).toBe("upload");
    expect(upload.questions.map((q) => q.type)).toEqual(["signature"]);
    expect(upload.enabled).toBe(false);
  });
});

describe("normalizeMoveInFormTemplates", () => {
  it("drops anything malformed rather than repairing it", () => {
    const good = newMoveInFormTemplate("built");
    good.name = "Good";
    const out = normalizeMoveInFormTemplates([
      good, null, "x", { id: "../etc", name: "path" }, { id: "no-name-ok" },
      { ...good, id: "dupe" }, { ...good, id: "dupe", name: "second" },
    ]);
    expect(out.map((t) => t.id)).toEqual([good.id, "no-name-ok", "dupe"]);
    expect(normalizeMoveInFormTemplates("nope")).toEqual([]);
    expect(normalizeMoveInFormTemplates(undefined)).toEqual([]);
  });

  it("drops bad questions, duplicate keys and forces signatures required", () => {
    const [template] = normalizeMoveInFormTemplates([{
      id: "f1", name: "F", source: "built", enabled: true,
      questions: [
        { id: "a", key: "a", label: "A", type: "text", required: true },
        { id: "b", key: "a", label: "Duplicate key", type: "text" },
        { id: "c", key: "c", label: "Bad type", type: "script" },
        { id: "d", key: "d", label: "", type: "text" },
        { id: "e", key: "sig", label: "Sign", type: "signature", required: false },
        { id: "f", key: "pick", label: "Pick", type: "select", options: ["x", "", 3] },
      ],
    }]);
    expect(template!.questions.map((q) => q.key)).toEqual(["a", "sig", "pick"]);
    expect(template!.questions.find((q) => q.key === "sig")!.required).toBe(true);
    expect(template!.questions.find((q) => q.key === "pick")!.options).toEqual(["x"]);
    expect(template!.enabled).toBe(true);
  });

  it("rejects an upload form's pdf that is not a well-formed stored reference", () => {
    const base = { id: "f1", name: "F", source: "upload", questions: [] };
    expect(normalizeMoveInFormTemplates([{ ...base, pdf: { storagePath: "a/../b.pdf", fileName: "x", pageCount: 1, sha256: "a".repeat(64) } }])[0]!.pdf).toBeNull();
    expect(normalizeMoveInFormTemplates([{ ...base, pdf: { storagePath: "a/b.pdf", fileName: "x", pageCount: 2, sha256: "z" } }])[0]!.pdf).toBeNull();
    expect(normalizeMoveInFormTemplates([{ ...base, pdf: { storagePath: "a/b.pdf", fileName: "x", pageCount: 2, sha256: "a".repeat(64) } }])[0]!.pdf)
      .toEqual({ storagePath: "a/b.pdf", fileName: "x", pageCount: 2, sha256: "a".repeat(64) });
  });
});

describe("readMoveInFormTemplates / readMoveInFormSettings", () => {
  it("returns the five off starters when the key was never written", () => {
    for (const absent of [undefined, null, {}, { moveInFormSettings: {} }, "junk"]) {
      const out = readMoveInFormTemplates(absent);
      expect(out).toHaveLength(5);
      expect(out.every((t) => !t.enabled)).toBe(true);
    }
  });

  it("returns exactly what was stored once the key exists, even when empty", () => {
    expect(readMoveInFormTemplates({ moveInFormTemplates: [] })).toEqual([]);
    const stored = newMoveInFormTemplate("built");
    stored.name = "Mine";
    expect(readMoveInFormTemplates({ moveInFormTemplates: [stored] }).map((t) => t.name)).toEqual(["Mine"]);
  });

  it("returns a fresh copy of the starters each time", () => {
    const first = readMoveInFormTemplates(undefined);
    first[0]!.enabled = true;
    expect(readMoveInFormTemplates(undefined)[0]!.enabled).toBe(false);
  });

  it("defaults and sanitizes settings", () => {
    expect(readMoveInFormSettings(undefined)).toEqual(DEFAULT_MOVE_IN_FORM_SETTINGS);
    expect(readMoveInFormSettings({ moveInFormSettings: { remind: "due-only", notifyOnSubmit: "none" } })).toEqual({ remind: "due-only", notifyOnSubmit: "none" });
    expect(readMoveInFormSettings({ moveInFormSettings: { remind: "weekly", notifyOnSubmit: 4 } })).toEqual(DEFAULT_MOVE_IN_FORM_SETTINGS);
  });
});

describe("moveInFormDueAt", () => {
  const pacificDay = (iso: string) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date(iso));
  const pacificTime = (iso: string) =>
    new Intl.DateTimeFormat("en-GB", { timeZone: "America/Los_Angeles", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));

  it("is the end of the due day in Pacific time", () => {
    const due = moveInFormDueAt("day-before", "2026-10-10")!;
    expect(pacificDay(due)).toBe("2026-10-09");
    expect(pacificTime(due)).toBe("23:59");
  });

  it("applies every rule, across the November clock change", () => {
    expect(pacificDay(moveInFormDueAt("move-in-day", "2026-10-10")!)).toBe("2026-10-10");
    expect(pacificDay(moveInFormDueAt("3-days-before", "2026-10-10")!)).toBe("2026-10-07");
    expect(pacificDay(moveInFormDueAt("7-days-before", "2026-11-03")!)).toBe("2026-10-27");
    const winter = moveInFormDueAt("day-before", "2026-11-10")!;
    expect(pacificDay(winter)).toBe("2026-11-09");
    expect(pacificTime(winter)).toBe("23:59");
  });

  it("is null without a usable date", () => {
    expect(moveInFormDueAt("day-before", "")).toBeNull();
    expect(moveInFormDueAt("day-before", null)).toBeNull();
    expect(moveInFormDueAt("day-before", "soon")).toBeNull();
  });
});

describe("templateAppliesToRoom", () => {
  it("covers every room and the whole house regardless of room", () => {
    expect(templateAppliesToRoom({ audience: { kind: "every-room" } }, "r1")).toBe(true);
    expect(templateAppliesToRoom({ audience: { kind: "every-room" } }, null)).toBe(true);
    expect(templateAppliesToRoom({ audience: { kind: "whole-house" } }, null)).toBe(true);
  });

  it("limits a rooms audience to the listed rooms, and never matches an unknown room", () => {
    const audience = { kind: "rooms" as const, roomIds: ["r1", "r2"] };
    expect(templateAppliesToRoom({ audience }, "r2")).toBe(true);
    expect(templateAppliesToRoom({ audience }, "r3")).toBe(false);
    expect(templateAppliesToRoom({ audience }, null)).toBe(false);
    expect(templateAppliesToRoom({ audience }, "")).toBe(false);
  });
});

describe("MOVE_IN_FORM_ID_PATTERN", () => {
  it("accepts plain ids and refuses anything path-like", () => {
    for (const ok of ["mif-abc123", "a_b-c", "x".repeat(120)]) expect(MOVE_IN_FORM_ID_PATTERN.test(ok)).toBe(true);
    for (const bad of ["", "a/b", "../a", "a b", "a.pdf", "x".repeat(121)]) expect(MOVE_IN_FORM_ID_PATTERN.test(bad)).toBe(false);
  });
});
