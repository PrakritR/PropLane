import { afterEach, describe, expect, it } from "vitest";
import { isSmsCommUiEnabled } from "@/lib/sms-comm-ui-flag.server";

const ORIGINAL = process.env.SMS_COMM_UI_ENABLED;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.SMS_COMM_UI_ENABLED;
  else process.env.SMS_COMM_UI_ENABLED = ORIGINAL;
});

describe("isSmsCommUiEnabled", () => {
  it("defaults ON when unset (SMS is a live product surface)", () => {
    delete process.env.SMS_COMM_UI_ENABLED;
    expect(isSmsCommUiEnabled()).toBe(true);
  });

  it("stays ON for explicit enables and unrecognized values", () => {
    for (const v of ["1", "true", "TRUE", "yes", ""]) {
      process.env.SMS_COMM_UI_ENABLED = v;
      expect(isSmsCommUiEnabled()).toBe(true);
    }
  });

  it("is OFF only for an explicit 0/false", () => {
    process.env.SMS_COMM_UI_ENABLED = "0";
    expect(isSmsCommUiEnabled()).toBe(false);
    process.env.SMS_COMM_UI_ENABLED = "false";
    expect(isSmsCommUiEnabled()).toBe(false);
    process.env.SMS_COMM_UI_ENABLED = "FALSE";
    expect(isSmsCommUiEnabled()).toBe(false);
  });
});
