import { describe, expect, it } from "vitest";
import {
  PORTAL_INBOX_COMPOSER_INPUT_CLASS,
  PORTAL_INBOX_COMPOSER_MAX_HEIGHT_PX,
  PORTAL_INBOX_COMPOSER_SEND_CLASS,
  composerAutoHeight,
} from "@/components/portal/portal-inbox-ui";

describe("reply composer is a one-line auto-growing field", () => {
  it("is empty-height by CSS (no inline height) and never reads free space", () => {
    expect(composerAutoHeight(500, false)).toBeNull();
    expect(PORTAL_INBOX_COMPOSER_INPUT_CLASS).not.toMatch(/\bflex-1\b|\bh-full\b|\bmin-h-full\b/);
  });
  it("is a 44px field above a tools row whose send button is 30px (36px on a phone)", () => {
    expect(PORTAL_INBOX_COMPOSER_INPUT_CLASS).toContain("min-h-11");
    expect(PORTAL_INBOX_COMPOSER_INPUT_CLASS).toContain("border-0");
    expect(PORTAL_INBOX_COMPOSER_SEND_CLASS).toContain("size-[30px]");
    expect(PORTAL_INBOX_COMPOSER_SEND_CLASS).toContain("max-md:size-9");
  });
  it("grows with content and caps at six lines, then scrolls", () => {
    expect(composerAutoHeight(64, true)).toBe(66);
    expect(composerAutoHeight(5000, true)).toBe(PORTAL_INBOX_COMPOSER_MAX_HEIGHT_PX);
    expect(PORTAL_INBOX_COMPOSER_MAX_HEIGHT_PX).toBe(162);
    expect(PORTAL_INBOX_COMPOSER_INPUT_CLASS).toContain("overflow-y-auto");
    expect(PORTAL_INBOX_COMPOSER_INPUT_CLASS).toContain("max-h-[162px]");
  });
});
