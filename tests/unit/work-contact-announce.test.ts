// @vitest-environment node
/**
 * One "here is how to reach me", not one per channel.
 *
 * A manager who sets up a work number and a work email on the same afternoon
 * would otherwise broadcast to their whole portfolio twice with two halves of
 * the same instruction.
 */
import { describe, expect, it } from "vitest";
import {
  buildWorkContactAnnounceCopy,
  hasAnyWorkContactChannel,
  workContactAnnounceChannelTag,
  workContactAnnounceStorageKey,
} from "@/lib/work-contact-announce";

const PHONE = "+12065550137";
const EMAIL = "assist-jane@prop-lane.space";

describe("hasAnyWorkContactChannel", () => {
  it.each([
    [{ phone: PHONE, email: EMAIL }, true],
    [{ phone: PHONE, email: null }, true],
    [{ phone: null, email: EMAIL }, true],
    [{ phone: null, email: null }, false],
    [{ phone: "   ", email: "  " }, false],
  ])("%o → %s", (channels, expected) => {
    expect(hasAnyWorkContactChannel(channels)).toBe(expected);
  });
});

describe("buildWorkContactAnnounceCopy", () => {
  it("names both channels in one message when both are live", () => {
    const copy = buildWorkContactAnnounceCopy({ phone: PHONE, email: EMAIL });
    expect(copy.subject).toBe("New ways to reach me");
    expect(copy.text).toContain("Text: +1 (206) 555-0137");
    expect(copy.text).toContain(`Email: ${EMAIL}`);
    // One instruction, not two stitched together.
    expect(copy.text.match(/Save/g)).toHaveLength(1);
  });

  it("is the number-only message when there is no work email", () => {
    const copy = buildWorkContactAnnounceCopy({ phone: PHONE, email: null });
    expect(copy.subject).toBe("New number to reach me");
    expect(copy.text).toContain("Please text me at this new number: +1 (206) 555-0137");
    expect(copy.text).not.toContain("Email:");
  });

  it("is the email-only message when there is no work number", () => {
    const copy = buildWorkContactAnnounceCopy({ phone: null, email: EMAIL });
    expect(copy.subject).toBe("New email address to reach me");
    expect(copy.text).toContain(`Please email me at this new address: ${EMAIL}`);
    expect(copy.text).not.toContain("Text:");
  });

  it("always signs off the same way", () => {
    for (const channels of [
      { phone: PHONE, email: EMAIL },
      { phone: PHONE, email: null },
      { phone: null, email: EMAIL },
    ]) {
      expect(buildWorkContactAnnounceCopy(channels).text.endsWith("Thanks,\nYour property manager")).toBe(true);
    }
  });
});

describe("dismissal key", () => {
  it("is distinct per channel pair, so adding a channel re-offers the announcement", () => {
    const numberOnly = workContactAnnounceStorageKey({ phone: PHONE, email: null });
    const both = workContactAnnounceStorageKey({ phone: PHONE, email: EMAIL });
    expect(numberOnly).not.toBe(both);
  });

  it("ignores casing and whitespace so one dismissal stays one dismissal", () => {
    expect(workContactAnnounceStorageKey({ phone: ` ${PHONE} `, email: ` ${EMAIL.toUpperCase()} ` })).toBe(
      workContactAnnounceStorageKey({ phone: PHONE, email: EMAIL }),
    );
  });
});

describe("analytics tag", () => {
  it.each([
    [{ phone: PHONE, email: EMAIL }, "number_email"],
    [{ phone: null, email: EMAIL }, "email"],
    [{ phone: PHONE, email: null }, "number"],
  ])("%o → %s", (channels, expected) => {
    expect(workContactAnnounceChannelTag(channels)).toBe(expected);
  });
});
