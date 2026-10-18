import { describe, expect, it } from "vitest";
import { BUBBLE_MAX_CHARS, MAX_BUBBLES, splitIntoBubbles, stripMarkdown, textHasEmoji } from "@/lib/one-number/bubbles";
import { isGsm7, smsSegmentCount } from "@/lib/one-number/segments";

describe("stripMarkdown", () => {
  it("removes formatting symbols and keeps link URLs", () => {
    expect(stripMarkdown("**Rent** is due `Nov 1`. See [your link](https://pay.proplane.ai/x).")).toBe(
      "Rent is due Nov 1. See your link: https://pay.proplane.ai/x.",
    );
    expect(stripMarkdown("# Heading\n* one\n* two")).toBe("Heading\n- one\n- two");
    expect(stripMarkdown("[https://a.co/b](https://a.co/b)")).toBe("https://a.co/b");
    expect(stripMarkdown("snake_case_word stays")).toBe("snake_case_word stays");
  });
});

describe("splitIntoBubbles", () => {
  it("returns nothing for an empty reply and one bubble for a short one", () => {
    expect(splitIntoBubbles("")).toEqual([]);
    expect(splitIntoBubbles("   ")).toEqual([]);
    expect(splitIntoBubbles("Wi-Fi is 4709A, password sunny42.")).toEqual(["Wi-Fi is 4709A, password sunny42."]);
  });

  it("packs sentences greedily so a reply that fits one segment stays one bubble", () => {
    const text = "Got it, Maya. The plumber comes Tuesday 10-12. I will text you when he is on the way.";
    expect(text.length).toBeLessThanOrEqual(BUBBLE_MAX_CHARS);
    expect(splitIntoBubbles(text)).toEqual([text]);
  });

  it("splits on sentence boundaries into bubbles of at most one segment, answer first", () => {
    const text =
      "Yes, Room 3 is open and rent is $950 a month. Tours run weekdays after 4 pm and weekends from 10 am. " +
      "Tell me which day works and I will book it. You can also apply any time from the link I send after the tour.";
    const bubbles = splitIntoBubbles(text);
    expect(bubbles.length).toBeGreaterThan(1);
    expect(bubbles.length).toBeLessThanOrEqual(MAX_BUBBLES);
    expect(bubbles[0]).toMatch(/^Yes, Room 3 is open/);
    for (const b of bubbles) expect(smsSegmentCount(b)).toBe(1);
    expect(bubbles.join(" ")).toBe(text);
  });

  it("never splits a URL, even one longer than a segment", () => {
    const url = `https://app.proplane.ai/l/${"a1b2c3d4".repeat(24)}`;
    expect(url.length).toBeGreaterThan(BUBBLE_MAX_CHARS);
    const text = `Here is your private payment link, it works only for your number: ${url} Let me know if it does not open.`;
    const bubbles = splitIntoBubbles(text);
    expect(bubbles.some((b) => b.includes(url))).toBe(true);
    expect(bubbles.filter((b) => b.includes("aaaa") || b.includes("a1b2c3d4")).every((b) => b.includes(url))).toBe(true);
    expect(bubbles.join(" ").replace(/\s+/g, " ")).toBe(text);
  });

  it("does not cut a sentence at a trailing dot inside a URL or an abbreviation", () => {
    const text = "Open https://proplane.ai/pay. Quiet hours start at 10 p.m. Tuesday is trash day. Bins go on the curb.";
    const joined = splitIntoBubbles(text).join(" ");
    expect(joined).toBe(text);
    expect(splitIntoBubbles(text).every((b) => !/p\.m\.$/.test(b) || b.endsWith("Tuesday is trash day."))).toBe(true);
  });

  it("caps at three bubbles and keeps the overflow in the last one", () => {
    const sentence = "This sentence is exactly long enough to nearly fill one text bubble all by itself ok.";
    const text = Array.from({ length: 7 }, () => sentence).join(" ");
    const bubbles = splitIntoBubbles(text);
    expect(bubbles).toHaveLength(MAX_BUBBLES);
    expect(bubbles.slice(0, -1).every((b) => smsSegmentCount(b) === 1)).toBe(true);
    expect(bubbles.join(" ")).toBe(text);
  });

  it("cuts one over-long sentence at a clause break, then at a word", () => {
    const clause = "the house has a shared kitchen with two fridges, a back deck that everyone uses on weekends";
    const text = `${clause}, ${clause}, ${clause}.`;
    const bubbles = splitIntoBubbles(text);
    expect(bubbles.length).toBeGreaterThan(1);
    for (const b of bubbles) expect(b.length).toBeLessThanOrEqual(BUBBLE_MAX_CHARS);
    expect(bubbles.join(" ")).toBe(text);
  });

  it("strips markdown and emoji unless the texter used one, and stays GSM-7", () => {
    const text = "**Great news** \u{1F389} your tour is booked. It’s Tuesday — see you then.";
    const plain = splitIntoBubbles(text);
    expect(plain).toEqual(["Great news your tour is booked. It's Tuesday - see you then."]);
    expect(isGsm7(plain[0]!)).toBe(true);
    const mirrored = splitIntoBubbles(text, { allowEmoji: true });
    expect(mirrored.join(" ")).toContain("\u{1F389}");
    expect(mirrored.join(" ")).not.toContain("**");
    expect(mirrored.join(" ")).toContain("It's Tuesday - see you then.");
  });

  it("keeps list lines on their own lines inside a bubble", () => {
    const bubbles = splitIntoBubbles("Openings:\n- Room 1 $900\n- Room 3 $950");
    expect(bubbles).toEqual(["Openings:\n- Room 1 $900\n- Room 3 $950"]);
  });

  it("respects a smaller cap", () => {
    const text = "One short sentence here. Another short sentence there. " + "x".repeat(0);
    expect(splitIntoBubbles(`${"A fairly long sentence goes right here and takes space. ".repeat(6)}`, { maxBubbles: 2 })).toHaveLength(2);
    expect(splitIntoBubbles(text, { maxBubbles: 1 })).toHaveLength(1);
  });
});

describe("textHasEmoji", () => {
  it("detects emoji and ignores plain text", () => {
    expect(textHasEmoji("ok thanks \u{1F44D}")).toBe(true);
    expect(textHasEmoji("ok thanks")).toBe(false);
    expect(textHasEmoji("")).toBe(false);
  });
});
