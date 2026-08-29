import { describe, expect, it } from "vitest";
import {
  DEFAULT_MANAGER_AUTOMATION_SETTINGS,
  normalizeManagerAutomationSettings,
} from "@/lib/payment-automation-settings";
import {
  deliverViaFromManagerSettings,
  patchDeliverViaForKind,
  portalMessageSelectionFromDeliverVia,
} from "@/lib/manager-communication-deliver-via";

describe("manager-communication-deliver-via", () => {
  it("defaults manual compose to email only", () => {
    expect(deliverViaFromManagerSettings(DEFAULT_MANAGER_AUTOMATION_SETTINGS, "inbox_default")).toEqual({
      viaEmail: true,
      viaSms: false,
    });
  });

  it("normalizes new category deliver-via fields", () => {
    const settings = normalizeManagerAutomationSettings({
      leasesDeliverViaSms: true,
      applicationsDeliverViaEmail: false,
      applicationsDeliverViaSms: true,
    });
    expect(settings.leasesDeliverViaSms).toBe(true);
    expect(settings.applicationsDeliverViaEmail).toBe(false);
    expect(settings.applicationsDeliverViaSms).toBe(true);
  });

  it("patches deliver-via by kind", () => {
    const next = patchDeliverViaForKind(DEFAULT_MANAGER_AUTOMATION_SETTINGS, "messages", {
      viaEmail: true,
      viaSms: true,
    });
    expect(next.messagesDeliverViaSms).toBe(true);
  });

  it("maps deliver-via to compose channel selection", () => {
    expect(
      portalMessageSelectionFromDeliverVia({ viaEmail: true, viaSms: true }, true),
    ).toEqual(["email", "sms"]);
    expect(
      portalMessageSelectionFromDeliverVia({ viaEmail: false, viaSms: true }, false),
    ).toEqual(["email"]);
  });
});
