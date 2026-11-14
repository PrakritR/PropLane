/** CodeQL js/polynomial-redos: the flagged patterns stay linear on pathological input and keep their matches. */
import { describe, expect, it } from "vitest";
import { parseChannelFinanceEmail } from "@/lib/channel-finance/email-parsers";
import { moneyToCents } from "@/lib/channel-finance/money-dates";
import { roomHintFrom, urlIn } from "@/lib/inbound-email/platform-lead-parsers/common";
import { composePlatformReply } from "@/lib/platform-leads/index.server";
import { roomFromText } from "@/lib/prospect-spine/context.server";
import { buildTeamNoticeLine } from "@/lib/team-notice-line";
import { trimTrailingChars } from "@/lib/trim-trailing-chars";

const BIG = 50_000;
function fast(fn: () => unknown) {
  const start = performance.now();
  fn();
  expect(performance.now() - start).toBeLessThan(200);
}

describe("redos hardening", () => {
  it("trimTrailingChars", () => {
    expect(trimTrailingChars("a.b,.;", ".,;")).toBe("a.b");
    expect(trimTrailingChars("abc", ".")).toBe("abc");
    fast(() => trimTrailingChars(".".repeat(BIG) + "x", ".,"));
  });

  it("channel-finance email parser", () => {
    const mail = parseChannelFinanceEmail({ platform: "booking_com", subject: "Payout", text: `Reservation number: 12345678\n${"reservation ".repeat(BIG / 12)}` });
    expect(JSON.stringify(mail)).toContain("12345678");
    fast(() => parseChannelFinanceEmail({ platform: "booking_com", subject: "x", text: " ".repeat(BIG) + "reservation" + " ".repeat(BIG) }));
    fast(() => parseChannelFinanceEmail({ platform: "airbnb", subject: "x", text: "Guest: " + ".,:!".repeat(BIG / 4) + " y" }));
  });

  it("moneyToCents", () => {
    expect(moneyToCents("$1,234.50 USD")).toBe(123450);
    expect(moneyToCents("USD 12")).toBe(1200);
    fast(() => moneyToCents("1" + " ".repeat(BIG) + "x"));
  });

  it("platform lead parsers", () => {
    expect(roomHintFrom("see Room #9 now")).toBe("Room 9");
    expect(urlIn("go https://zillow.com/a/b.,;", ["zillow.com"])).toBe("https://zillow.com/a/b");
    fast(() => roomHintFrom("room" + " ".repeat(BIG) + "x"));
    fast(() => urlIn("https://zillow.com/" + ".".repeat(BIG), ["zillow.com"]));
  });

  it("composePlatformReply tidy", () => {
    const { body } = composePlatformReply({ site: "zillow", answer: "Hello , there !", propertyLabel: "P", listingUrl: null, textNumberDisplay: "(206) 678-1909", stitchCode: null });
    expect(body).toContain("Hello, there!");
    fast(() => composePlatformReply({ site: "zillow", answer: "a" + " ".repeat(BIG) + "b", propertyLabel: "P", listingUrl: null, textNumberDisplay: "(206) 678-1909", stitchCode: null }));
  });

  it("roomFromText", () => {
    expect(roomFromText("is room # 4 free", [{ id: "r4", label: "Room 4" }])?.id).toBe("r4");
    fast(() => roomFromText("room" + " ".repeat(BIG), []));
  });

  it("team notice line", () => {
    expect(buildTeamNoticeLine({ domain: "service", subject: "Work order: Leaky tap · Payment update", place: "5257 Brooklyn Ave · Room 2" })).toContain("Leaky tap, 5257 Brooklyn Ave, Room 2");
    fast(() => buildTeamNoticeLine({ subject: "x" + " ".repeat(BIG) + "·", place: " · ".repeat(BIG / 3) }));
    fast(() => buildTeamNoticeLine({ subject: "work" + " ".repeat(BIG) }));
  });
});
