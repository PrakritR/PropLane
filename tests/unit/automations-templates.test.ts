import { describe, expect, it } from "vitest";
import { emptyHouseInfo, setHouseInfoValue } from "@/lib/house-info";
import { getAutomationPreset } from "@/lib/automations/presets";
import {
  MAX_TEMPLATE_LENGTH,
  SAMPLE_VARS,
  groupTextViolations,
  missingRequiredVariables,
  renderTemplate,
  templateVariablesUsed,
  validateTemplate,
} from "@/lib/automations/templates";

const info = (() => {
  let i = emptyHouseInfo();
  i = setHouseInfoValue(i, "access", "doorCode", "4821");
  i = setHouseInfoValue(i, "wifi", "password", "Sunset-Maple-9");
  return i;
})();

describe("renderTemplate", () => {
  it("fills names, dates and amounts from data and nowhere else", () => {
    expect(renderTemplate("Hi {first_name}, rent of {amount} is due {due_date}.", { first_name: "Maya", amount: "$850.00", due_date: "Nov 1" })).toBe(
      "Hi Maya, rent of $850.00 is due Nov 1.",
    );
  });

  it("drops a sentence whose variable has no value instead of sending it half empty", () => {
    const welcome = getAutomationPreset("move_in_3d")!;
    const text = renderTemplate(welcome.template, { first_name: "Maya", move_in_date: "Nov 1", wifi_name: "Net", wifi_password: "pw" });
    expect(text).toContain("move-in is Nov 1");
    expect(text).not.toMatch(/Door code/);
    expect(text).not.toMatch(/Parking/);
    expect(text).toContain("Wi-Fi Net, password pw");
  });

  it("is GSM-7: no curly quotes or long dashes survive", () => {
    expect(renderTemplate("{announcement}", { announcement: "It’s off — Tuesday" })).toBe("It's off - Tuesday");
  });

  it("reports the required facts a text cannot go out without", () => {
    expect(missingRequiredVariables("Welcome {first_name} to {house}", { first_name: "Maya" })).toEqual(["house"]);
  });

  it("lists variables once, in order", () => {
    expect(templateVariablesUsed("{a_b} {c} {a_b}")).toEqual(["a_b", "c"]);
  });
});

describe("validateTemplate", () => {
  const welcome = getAutomationPreset("welcome")!;
  const groupRent = getAutomationPreset("rent_due_day")!;
  it("refuses empty, over-long and unknown", () => {
    expect(validateTemplate(welcome, "  ").ok).toBe(false);
    expect(validateTemplate(welcome, "x".repeat(MAX_TEMPLATE_LENGTH + 1)).ok).toBe(false);
    expect(validateTemplate(welcome, "Hi {nope}")).toMatchObject({ ok: false });
  });
  it("refuses a variable the preset does not offer", () => {
    expect(validateTemplate(welcome, "Pay {amount}")).toMatchObject({ ok: false });
  });
  it("refuses a name, amount, pay link or code in a group preset", () => {
    for (const bad of ["Hi {first_name}", "Rent {amount}", "Pay {pay_link}", "Code {door_code}"]) {
      expect(validateTemplate(groupRent, bad), bad).toMatchObject({ ok: false });
    }
    expect(validateTemplate(groupRent, "Rent is due today at {house}.")).toEqual({ ok: true });
  });
});

describe("groupTextViolations", () => {
  const ctx = { residentFirstNames: ["Maya", "Jo"], houseInfo: info };
  it("lets a neutral house text through", () => {
    expect(groupTextViolations("Friendly reminder: rent is due today. Check your texts for your pay link.", ctx)).toEqual([]);
    expect(groupTextViolations(renderTemplate(getAutomationPreset("rent_due_day")!.template, SAMPLE_VARS), ctx)).toEqual([]);
  });
  it("refuses money", () => {
    expect(groupTextViolations("Rent is $850 today", ctx)).toContain("money");
    expect(groupTextViolations("Rent is 850.00 today", ctx)).toContain("money");
    expect(groupTextViolations("pay 20 dollars", ctx)).toContain("money");
  });
  it("refuses a resident's first name as a whole word", () => {
    expect(groupTextViolations("Maya owes rent", ctx)).toContain("name");
    expect(groupTextViolations("jo please move your bike", ctx)).toContain("name");
    expect(groupTextViolations("Majority of rooms are clean", ctx)).not.toContain("name");
  });
  it("refuses the door code and the Wi-Fi password, spaced or not", () => {
    expect(groupTextViolations("The code is 4821", ctx)).toContain("secret");
    expect(groupTextViolations("code 4 8 2 1", ctx)).toContain("secret");
    expect(groupTextViolations("wifi sunset maple 9", ctx)).toContain("secret");
    expect(groupTextViolations("wifi Sunset-Maple-9", ctx)).toContain("secret");
  });
});
