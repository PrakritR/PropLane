import { describe, expect, it } from "vitest";
import {
  estimateSmsSegments,
  evaluateManagerSmsNumberSendability,
  managerSmsNumberIsSendable,
  normalizeSmsNumberAttachmentState,
  normalizeSmsNumberRegistrationState,
  normalizeSmsRuntimeMode,
  resolveSmsNumberGraceState,
  smsRuntimeAllowsManager,
  type ManagerSmsNumberSendabilityRecord,
  type ManagerSmsNumberSendabilityOptions,
} from "@/lib/sms/number-registration-policy";

const readyNumber: ManagerSmsNumberSendabilityRecord = {
  provisionState: "active",
  phoneNumber: "+12065550100",
  registrationState: "approved",
  registrationRef: null,
  attachmentState: "attached",
  numberRegistrationState: "registered",
  graceStartedAt: null,
  graceExpiresAt: null,
  quarantinedAt: null,
  quarantineReason: null,
};

const automatic: ManagerSmsNumberSendabilityOptions = {
  runtimeMode: "automatic",
  now: new Date("2026-08-25T12:00:00.000Z"),
  env: {},
};

describe("estimateSmsSegments", () => {
  it("uses GSM-7 single and concatenated limits", () => {
    expect(estimateSmsSegments("a".repeat(160))).toMatchObject({
      encoding: "gsm-7",
      encodedUnits: 160,
      segmentCount: 1,
    });
    expect(estimateSmsSegments("a".repeat(161))).toMatchObject({
      encoding: "gsm-7",
      encodedUnits: 161,
      segmentCount: 2,
    });
    expect(estimateSmsSegments("a".repeat(307)).segmentCount).toBe(3);
  });

  it("counts GSM-7 extension-table characters as two septets", () => {
    expect(estimateSmsSegments("^".repeat(80))).toMatchObject({
      encoding: "gsm-7",
      encodedUnits: 160,
      segmentCount: 1,
    });
    expect(estimateSmsSegments("^".repeat(81))).toMatchObject({
      encoding: "gsm-7",
      encodedUnits: 162,
      segmentCount: 2,
    });
  });

  it("switches the whole body to UCS-2 when any character is outside GSM-7", () => {
    expect(estimateSmsSegments(`${"a".repeat(69)}漢`)).toMatchObject({
      encoding: "ucs-2",
      encodedUnits: 70,
      segmentCount: 1,
    });
    expect(estimateSmsSegments(`${"a".repeat(70)}漢`)).toMatchObject({
      encoding: "ucs-2",
      encodedUnits: 71,
      segmentCount: 2,
    });
  });

  it("counts astral characters as two UCS-2 code units", () => {
    expect(estimateSmsSegments("🙂".repeat(35))).toMatchObject({
      encoding: "ucs-2",
      encodedUnits: 70,
      segmentCount: 1,
    });
    expect(estimateSmsSegments("🙂".repeat(36))).toMatchObject({
      encoding: "ucs-2",
      encodedUnits: 72,
      segmentCount: 2,
    });
  });

  it("reports zero segments for an empty body", () => {
    expect(estimateSmsSegments("")).toMatchObject({
      encoding: "gsm-7",
      encodedUnits: 0,
      segmentCount: 0,
    });
  });
});

describe("SMS runtime and state normalization", () => {
  it("fails closed on unknown control-plane values", () => {
    expect(normalizeSmsRuntimeMode("surprise")).toBe("paused");
    expect(normalizeSmsNumberAttachmentState("surprise")).toBe("not_attached");
    expect(normalizeSmsNumberRegistrationState("surprise")).toBe("not_submitted");
  });

  it("allows everyone in automatic mode and only the pilot in allowlisted mode", () => {
    expect(smsRuntimeAllowsManager("automatic", false)).toBe(true);
    expect(smsRuntimeAllowsManager("allowlisted_self_service", true)).toBe(true);
    expect(smsRuntimeAllowsManager("allowlisted_self_service", false)).toBe(false);
    expect(smsRuntimeAllowsManager("paused", true)).toBe(false);
  });
});

describe("evaluateManagerSmsNumberSendability", () => {
  it("allows a fully ready number in automatic mode", () => {
    expect(evaluateManagerSmsNumberSendability(readyNumber, automatic)).toEqual({
      sendable: true,
      reason: null,
    });
    expect(managerSmsNumberIsSendable(readyNumber, automatic)).toBe(true);
  });

  it("enforces the runtime kill switch and explicit pilot allowlist", () => {
    expect(
      evaluateManagerSmsNumberSendability(readyNumber, {
        ...automatic,
        runtimeMode: "paused",
      }).reason,
    ).toBe("runtime_paused");
    expect(
      evaluateManagerSmsNumberSendability(readyNumber, {
        ...automatic,
        runtimeMode: "allowlisted_self_service",
      }).reason,
    ).toBe("manager_not_allowlisted");
    expect(
      managerSmsNumberIsSendable(readyNumber, {
        ...automatic,
        runtimeMode: "allowlisted_self_service",
        managerIsAllowlisted: true,
      }),
    ).toBe(true);
  });

  it.each([
    [{ ...readyNumber, phoneNumber: null }, "number_missing"],
    [{ ...readyNumber, provisionState: "failed" as const }, "number_not_active"],
    [
      { ...readyNumber, registrationState: "pending" as const },
      "manager_registration_not_approved",
    ],
    [{ ...readyNumber, attachmentState: "attaching" as const }, "number_not_attached"],
    [
      { ...readyNumber, numberRegistrationState: "pending" as const },
      "number_not_registered",
    ],
  ])("blocks an unready control-plane state with %s", (record, reason) => {
    expect(evaluateManagerSmsNumberSendability(record, automatic).reason).toBe(reason);
  });

  it("blocks quarantine when either marker is present", () => {
    expect(
      evaluateManagerSmsNumberSendability(
        { ...readyNumber, quarantinedAt: "2026-08-25T11:00:00.000Z" },
        automatic,
      ).reason,
    ).toBe("number_quarantined");
    expect(
      evaluateManagerSmsNumberSendability(
        { ...readyNumber, quarantineReason: "provider_detached" },
        automatic,
      ).reason,
    ).toBe("number_quarantined");
  });

  it("blocks outbound throughout grace and after it expires", () => {
    const inGrace = {
      ...readyNumber,
      graceStartedAt: "2026-08-25T10:00:00.000Z",
      graceExpiresAt: "2026-08-25T13:00:00.000Z",
    };
    expect(resolveSmsNumberGraceState(inGrace, automatic.now)).toBe("active");
    expect(managerSmsNumberIsSendable(inGrace, automatic)).toBe(false);
    expect(evaluateManagerSmsNumberSendability(inGrace, automatic).reason).toBe(
      "number_in_grace",
    );

    const expiredOptions = { ...automatic, now: new Date("2026-08-25T13:00:00.000Z") };
    expect(resolveSmsNumberGraceState(inGrace, expiredOptions.now)).toBe("expired");
    expect(evaluateManagerSmsNumberSendability(inGrace, expiredOptions).reason).toBe(
      "number_grace_expired",
    );
  });

  it("fails closed on a partial or malformed grace window", () => {
    const invalidGrace = {
      ...readyNumber,
      graceStartedAt: "2026-08-25T10:00:00.000Z",
      graceExpiresAt: null,
    };
    expect(resolveSmsNumberGraceState(invalidGrace, automatic.now)).toBe("invalid");
    expect(evaluateManagerSmsNumberSendability(invalidGrace, automatic).reason).toBe(
      "number_grace_invalid",
    );
  });
});
