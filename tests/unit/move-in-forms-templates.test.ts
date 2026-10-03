import { describe, expect, it } from "vitest";
import {
  defaultMoveInForm, isDefaultMoveInForm, MOVE_IN_FORM_DEFAULT_IDS, MOVE_IN_FORM_ID_PATTERN, MOVE_IN_FORM_STARTERS,
  moveInFormDueAt, moveInFormDueFor, newMoveInFormTemplate, normalizeMoveInFormTemplates, readMoveInFormSettings,
  readMoveInFormTemplates, resetMoveInFormToDefault, templateAppliesToRoom, templateLinkMatches, withDefaultMoveInForms,
} from "@/lib/move-in-forms/templates";
import { DEFAULT_MOVE_IN_FORM_SETTINGS } from "@/lib/move-in-forms/types";

describe("move-in form starters", () => {
  it("ships exactly five built starters: the checklist sends on lease signing, the other four by hand", () => {
    expect(MOVE_IN_FORM_STARTERS.map((t) => t.starterKey)).toEqual([
      "move-in-checklist", "key-receipt", "vehicle-parking", "pet-agreement", "emergency-contacts",
    ]);
    for (const starter of MOVE_IN_FORM_STARTERS) {
      expect("enabled" in starter).toBe(false);
      expect(starter.trigger).toBe(starter.starterKey === "move-in-checklist" ? "lease-signed" : "manual");
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
  it("copies a starter under a fresh, valid id and keeps its own sends setting", () => {
    const copy = newMoveInFormTemplate("built", "key-receipt");
    expect(copy.id).not.toBe("starter-key-receipt");
    expect(MOVE_IN_FORM_ID_PATTERN.test(copy.id)).toBe(true);
    expect(copy.trigger).toBe("manual");
    expect(copy.questions).toEqual(MOVE_IN_FORM_STARTERS.find((t) => t.starterKey === "key-receipt")!.questions);
    copy.questions[0]!.label = "changed";
    expect(MOVE_IN_FORM_STARTERS.find((t) => t.starterKey === "key-receipt")!.questions[0]!.label).not.toBe("changed");
  });

  it("starts an upload form with a required signature", () => {
    const upload = newMoveInFormTemplate("upload");
    expect(upload.source).toBe("upload");
    expect(upload.questions.map((q) => q.type)).toEqual(["signature"]);
    expect("enabled" in upload).toBe(false);
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
    expect(template!.trigger).toBe("lease-signed");
  });

  it("reads a form stored turned off as send-by-hand, so nothing that was off starts sending", () => {
    const base = { id: "f1", name: "F", source: "built", questions: [], trigger: "lease-signed" };
    expect(normalizeMoveInFormTemplates([{ ...base, enabled: false }])[0]!.trigger).toBe("manual");
    expect(normalizeMoveInFormTemplates([{ ...base, enabled: true }])[0]!.trigger).toBe("lease-signed");
    expect(normalizeMoveInFormTemplates([{ ...base, trigger: "application-approved", enabled: true }])[0]!.trigger).toBe("application-approved");
    expect("enabled" in normalizeMoveInFormTemplates([{ ...base, enabled: true }])[0]!).toBe(false);
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
  it("returns the three default forms and the five starters when the key was never written", () => {
    for (const absent of [undefined, null, {}, { moveInFormSettings: {} }, "junk"]) {
      const out = readMoveInFormTemplates(absent);
      expect(out).toHaveLength(8);
      expect(out.slice(0, 3).map((t) => t.id)).toEqual(["default-intake", "default-move-in", "default-move-out"]);
      expect(out.filter((t) => t.trigger !== "manual").map((t) => t.starterKey ?? t.kind)).toEqual(["intake", "move-in", "move-out", "move-in-checklist"]);
    }
  });

  it("returns the stored forms once the key exists, with the three default forms always pinned first", () => {
    const empty = readMoveInFormTemplates({ moveInFormTemplates: [] });
    expect(empty.map((t) => t.id)).toEqual(["default-intake", "default-move-in", "default-move-out"]);
    // A list saved before these existed must not start messaging residents on its own.
    expect(empty.every((t) => t.trigger === "manual")).toBe(true);
    const stored = newMoveInFormTemplate("built");
    stored.name = "Mine";
    expect(readMoveInFormTemplates({ moveInFormTemplates: [stored] }).map((t) => t.name)).toEqual(["Intake form", "Move-in form", "Move-out form", "Mine"]);
  });

  it("returns a fresh copy of the starters each time", () => {
    const first = readMoveInFormTemplates(undefined);
    const checklist = first.find((t) => t.starterKey === "move-in-checklist")!;
    checklist.trigger = "manual";
    expect(readMoveInFormTemplates(undefined).find((t) => t.starterKey === "move-in-checklist")!.trigger).toBe("lease-signed");
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

describe("default kind forms", () => {
  it("ships Intake, Move-in and Move-out with the spec's sends, due and questions", () => {
    const intake = defaultMoveInForm("intake");
    const moveIn = defaultMoveInForm("move-in");
    const moveOut = defaultMoveInForm("move-out");
    expect([intake.id, moveIn.id, moveOut.id]).toEqual(Object.values(MOVE_IN_FORM_DEFAULT_IDS));
    expect([intake.trigger, moveIn.trigger, moveOut.trigger]).toEqual(["application-submitted", "lease-signed", "before-move-out"]);
    expect([intake.due, moveIn.due, moveOut.due]).toEqual(["3-days-after-sent", "day-before", "move-out-day"]);
    expect(moveOut.moveOutDaysBefore).toBe(14);
    for (const form of [intake, moveIn, moveOut]) {
      expect(form.questions.at(-1)!.type).toBe("signature");
      expect(form.questions.every((q) => q.id.startsWith("q-"))).toBe(true);
      expect(normalizeMoveInFormTemplates([form])[0]).toEqual(form);
    }
    // Vehicle and pets follow-ups only show on "yes".
    const showIf = (key: string) => intake.questions.find((q) => q.key === key)!.showIf;
    expect(showIf("vehicle_make")).toEqual({ fieldKey: "has_vehicle", equals: "yes" });
    expect(showIf("pet_description")).toEqual({ fieldKey: "has_pets", equals: "yes" });
    expect(moveOut.questions.find((q) => q.key === "deposit_refund_method")!.options).toEqual(["Direct deposit", "Check", "Other"]);
  });

  it("re-adds a deleted default and keeps every default before the other forms", () => {
    const mine = newMoveInFormTemplate("built");
    const edited = { ...defaultMoveInForm("move-in"), name: "Our move-in", trigger: "manual" as const };
    const out = withDefaultMoveInForms([mine, edited]);
    expect(out.map((t) => t.id)).toEqual(["default-intake", "default-move-in", "default-move-out", mine.id]);
    expect(out[1]!.name).toBe("Our move-in");
    expect(isDefaultMoveInForm(out[0]!)).toBe(true);
    expect(isDefaultMoveInForm(mine)).toBe(false);
  });

  it("reads a form stored before kinds existed as 'other', and pins a default's kind to its id", () => {
    const [legacy, spoofed] = normalizeMoveInFormTemplates([
      { id: "old", name: "Old", source: "built", questions: [], trigger: "lease-signed" },
      { id: "default-intake", name: "X", source: "built", questions: [], kind: "other" },
    ]);
    expect(legacy!.kind).toBe("other");
    expect(legacy!.linkedApplicationTemplateIds).toEqual([]);
    expect(legacy!.linkedLeaseTemplateIds).toEqual([]);
    expect(legacy!.moveOutDaysBefore).toBe(14);
    expect(legacy!.trigger).toBe("lease-signed");
    expect(spoofed!.kind).toBe("intake");
  });

  it("normalizes the new sends, the days before move-out and the linked ids", () => {
    const [form] = normalizeMoveInFormTemplates([{
      id: "f1", name: "F", source: "built", questions: [], trigger: "before-move-out", moveOutDaysBefore: 30,
      due: "3-days-before-move-out", linkedApplicationTemplateIds: ["a", "a", " b ", 4, ""], linkedLeaseTemplateIds: "nope",
    }, ]);
    expect(form!.trigger).toBe("before-move-out");
    expect(form!.moveOutDaysBefore).toBe(30);
    expect(form!.due).toBe("3-days-before-move-out");
    expect(form!.linkedApplicationTemplateIds).toEqual(["a", "b"]);
    expect(form!.linkedLeaseTemplateIds).toEqual([]);
    expect(normalizeMoveInFormTemplates([{ id: "f2", name: "F", moveOutDaysBefore: 5 }])[0]!.moveOutDaysBefore).toBe(14);
  });

  it("resets a default to its shipped questions but keeps its audience and links", () => {
    const edited = { ...defaultMoveInForm("intake"), questions: [], trigger: "manual" as const, linkedApplicationTemplateIds: ["a"], audience: { kind: "whole-house" as const } };
    const reset = resetMoveInFormToDefault(edited);
    expect(reset.questions).toEqual(defaultMoveInForm("intake").questions);
    expect(reset.trigger).toBe("application-submitted");
    expect(reset.linkedApplicationTemplateIds).toEqual(["a"]);
    expect(reset.audience).toEqual({ kind: "whole-house" });
  });
});

describe("linked templates and due anchors", () => {
  it("an empty link list admits everyone; a listed one admits only its own ids, never an unknown", () => {
    expect(templateLinkMatches([], null)).toBe(true);
    expect(templateLinkMatches([], "a")).toBe(true);
    expect(templateLinkMatches(["a"], "a")).toBe(true);
    expect(templateLinkMatches(["a"], "b")).toBe(false);
    expect(templateLinkMatches(["a"], "")).toBe(false);
    expect(templateLinkMatches(["a"], undefined)).toBe(false);
  });

  it("anchors due on move-in, on the day it is sent, or on the lease end (end of the Pacific day)", () => {
    expect(moveInFormDueFor("day-before", { moveInDate: "2026-10-10" })).toBe(moveInFormDueAt("day-before", "2026-10-10"));
    expect(moveInFormDueFor("move-out-day", { leaseEnd: "2026-12-31" })).toBe("2027-01-01T07:59:59.000Z");
    expect(moveInFormDueFor("7-days-before-move-out", { leaseEnd: "2026-12-31" })).toBe("2026-12-25T07:59:59.000Z");
    // Sent Oct 1, 2026 at noon Pacific: 3 days later is the end of Oct 4 Pacific (PDT).
    expect(moveInFormDueFor("3-days-after-sent", { sentAt: new Date("2026-10-01T19:00:00Z") })).toBe("2026-10-05T06:59:59.000Z");
    expect(moveInFormDueFor("move-out-day", { moveInDate: "2026-10-10" })).toBeNull();
  });
});
