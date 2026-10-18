import { describe, expect, it } from "vitest";
import {
  AUTOMATION_PRESETS,
  EXTERNAL_PRESETS_LIVE,
  GROUP_FORBIDDEN_VARIABLES,
  effectiveAutomationMode,
  getAutomationPreset,
  presetForScheduledPaymentKind,
  visibleAutomationPresets,
} from "@/lib/automations/presets";
import { validateTemplate } from "@/lib/automations/templates";

describe("preset catalog", () => {
  it("ships the ten texting-plan presets plus the two booking presets", () => {
    expect(AUTOMATION_PRESETS.map((p) => p.id)).toEqual([
      "welcome",
      "move_in_3d",
      "move_in_day",
      "rent_due_3d",
      "rent_due_day",
      "rent_late_3d",
      "announcement",
      "house_reminders",
      "maintenance_booked",
      "move_out",
      "arrival_guide",
      "checkout_reminder",
    ]);
  });

  it("every default template is valid for its own preset", () => {
    for (const preset of AUTOMATION_PRESETS) {
      expect(validateTemplate(preset, preset.template), preset.id).toEqual({ ok: true });
    }
  });

  it("new presets default to draft; the ones that exist today default to auto and offer auto or off only", () => {
    for (const preset of AUTOMATION_PRESETS) {
      if (preset.engine === "automation" && preset.id !== "announcement") expect(preset.defaultMode, preset.id).toBe("draft");
    }
    for (const id of ["rent_due_3d", "rent_late_3d"] as const) {
      const preset = getAutomationPreset(id)!;
      expect(preset.engine).toBe("existing");
      expect(preset.defaultMode).toBe("auto");
      expect(preset.modes).toEqual(["auto", "off"]);
      expect(preset.hasOwnText).toBe(false);
    }
  });

  it("a group preset never offers a name, a room, money, a pay link or a secret", () => {
    for (const preset of AUTOMATION_PRESETS.filter((p) => p.audience === "group")) {
      for (const variable of preset.variables) {
        expect(GROUP_FORBIDDEN_VARIABLES.has(variable), `${preset.id}.${variable}`).toBe(false);
      }
    }
  });

  it("rent late stays one on one and rent due in the group names no amount", () => {
    expect(getAutomationPreset("rent_late_3d")!.audience).toBe("resident");
    const group = getAutomationPreset("rent_due_day")!;
    expect(group.audience).toBe("group");
    expect(group.template).not.toMatch(/\$|\{amount\}|\{first_name\}/);
  });

  it("booking presets draw in Settings once live, as auto-or-off switches with no editable text", () => {
    const ids = visibleAutomationPresets().map((p) => p.id);
    expect([...EXTERNAL_PRESETS_LIVE].sort()).toEqual(["arrival_guide", "checkout_reminder"]);
    expect(ids).toContain("arrival_guide");
    expect(ids).toContain("checkout_reminder");
    expect(ids).toHaveLength(12);
    for (const id of ["arrival_guide", "checkout_reminder"] as const) {
      // The text is built at send time from house facts (door code included), so no held draft
      // stores it and the manager's control is on/off only.
      expect(getAutomationPreset(id)).toMatchObject({ engine: "existing", defaultMode: "auto", modes: ["auto", "off"], hasOwnText: false });
    }
  });
});

describe("effectiveAutomationMode", () => {
  it("uses the saved mode when the preset offers it, else the default", () => {
    const welcome = getAutomationPreset("welcome")!;
    expect(effectiveAutomationMode(welcome, undefined)).toBe("draft");
    expect(effectiveAutomationMode(welcome, "auto")).toBe("auto");
    expect(effectiveAutomationMode(welcome, "off")).toBe("off");
    const rent = getAutomationPreset("rent_due_3d")!;
    // 'draft' is not a mode this preset offers: it reads as the default, not as something chosen.
    expect(effectiveAutomationMode(rent, "draft")).toBe("auto");
  });
});

describe("presetForScheduledPaymentKind", () => {
  it("maps the lead-up to rent due and the late nudges to rent late", () => {
    expect(presetForScheduledPaymentKind("pre_due")).toBe("rent_due_3d");
    expect(presetForScheduledPaymentKind("post_due")).toBe("rent_late_3d");
    expect(presetForScheduledPaymentKind("overdue_daily")).toBe("rent_late_3d");
    expect(presetForScheduledPaymentKind("same_day")).toBeNull();
    expect(presetForScheduledPaymentKind("late_fee")).toBeNull();
    expect(presetForScheduledPaymentKind("set_date")).toBeNull();
  });
});
