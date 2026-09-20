import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  HOUSE_INFO_SECTIONS,
  emptyHouseInfo,
  getHouseInfoValue,
  houseInfoIsEmpty,
  houseInfoRenderSections,
  houseInfoSectionCount,
  houseInfoToPlainText,
  legacyHouseTextHasSplittableContent,
  normalizeHouseInfo,
  parseLegacyHouseText,
  parseQuietHours,
  setHouseInfoValue,
} from "@/lib/house-info";

/**
 * 4709A's real house notes, exactly as the manager typed them into the two
 * free-text boxes. The splitter is judged against this and nothing else —
 * a parser that only works on invented input is not a migration.
 */
const REAL_GENERAL_HOUSE_INFO = `Front door code: 001000

WiFi Username: 4709A
WiFi Password: 4709A4709A$$

House Groupchat: https://chat.whatsapp.com/JVe6jPceStL8pGDBSsVQBB?mode=gi_t

Services:
If something in your room or the house breaks or needs attention, this is how you flag it. Head to Services, hit "Report maintenance," describe the issue, set a priority, and note when you're free for someone to come by. Your property manager gets notified automatically — no need to text or call anyone.
Need something extra during your stay? Services lets you request add-ons directly through the portal. Current offerings include luggage storage ($5/piece), room cleaning ($10), and a bedding set (free for short stays under 5 days, $30 for long-term). Just select what you need and send the request — no chasing down the manager.

Payments, Lease & Inbox:
Pay rent, review your lease terms, and communicate with your property manager all in one place — everything documented and accessible anytime. Additionally if you want to extend lease can do through lease tab.`;

const REAL_HOUSE_RULES = `House Rules

* Quiet hours: 10:00 PM - 8:00 AM daily. No loud music, TV, or gatherings that disturb other residents.
* Kitchen & dining: Clean dishes, pots, and counters after each use (within 24 hours). Label your personal food. Do not leave dirty dishes overnight.
* Bathroom: Keep your assigned bathroom clean. Wipe surfaces after use and remove personal items from shared spaces.
* Trash: Bag all trash and place it in the designated containers. Follow the posted curbside collection schedule.
* Common areas: Vacuum/mop according to the posted schedule. Do not leave personal belongings in common areas for more than 24 hours.
* Cleaning schedule: Professional cleaning is provided every two weeks for shared spaces. Between cleanings, all residents are responsible for keeping common areas clean and tidy.
* Security deposit: A refundable security deposit is required. It will be refunded at move-out, less any deductions for damages or cleaning.
* Smoking: Smoking, vaping, and cannabis use are prohibited inside the property and within 25 feet of any door or window.
* Noise & conflict: Please treat other residents with respect. Persistent nuisance behavior is grounds for lease termination.`;

const REAL_LEGACY = {
  generalHouseInfo: REAL_GENERAL_HOUSE_INFO,
  houseRulesText: REAL_HOUSE_RULES,
  wifiNetworkName: "",
  wifiPassword: "",
};

describe("normalizeHouseInfo", () => {
  it("turns anything into a complete, empty shape", () => {
    for (const input of [null, undefined, "nope", 42, [], { v: 1 }]) {
      const info = normalizeHouseInfo(input);
      expect(info.v).toBe(1);
      expect(info.other).toBe("");
      for (const spec of HOUSE_INFO_SECTIONS) expect(info[spec.id]).toEqual({});
      expect(houseInfoIsEmpty(info)).toBe(true);
    }
  });

  it("drops keys that are not in the schema", () => {
    const info = normalizeHouseInfo({ v: 1, wifi: { network: "4709A", legacyJunk: "x" } });
    expect(info.wifi).toEqual({ network: "4709A" });
  });

  it("treats a whitespace-only value as unset", () => {
    const info = normalizeHouseInfo({ v: 1, access: { doorCode: "   " } });
    expect(houseInfoIsEmpty(info)).toBe(true);
  });
});

describe("setHouseInfoValue", () => {
  it("clears a key rather than storing an empty string", () => {
    let info = setHouseInfoValue(emptyHouseInfo(), "wifi", "password", "hunter2");
    expect(getHouseInfoValue(info, "wifi", "password")).toBe("hunter2");
    info = setHouseInfoValue(info, "wifi", "password", "");
    expect(info.wifi).toEqual({});
    expect(houseInfoIsEmpty(info)).toBe(true);
  });
});

describe("houseInfoSectionCount", () => {
  const rules = HOUSE_INFO_SECTIONS.find((s) => s.id === "rules")!;

  it("counts a half-set time range as unset", () => {
    const info = setHouseInfoValue(emptyHouseInfo(), "rules", "quietFrom", "22:00");
    expect(houseInfoSectionCount(info, rules).filled).toBe(0);
  });

  it("counts a complete time range once", () => {
    let info = setHouseInfoValue(emptyHouseInfo(), "rules", "quietFrom", "22:00");
    info = setHouseInfoValue(info, "rules", "quietTo", "08:00");
    expect(houseInfoSectionCount(info, rules).filled).toBe(1);
  });
});

describe("parseQuietHours", () => {
  it("reads the manager's own formats", () => {
    expect(parseQuietHours("10:00 PM - 8:00 AM daily")).toEqual({ from: "22:00", to: "08:00" });
    expect(parseQuietHours("10pm – 8am")).toEqual({ from: "22:00", to: "08:00" });
    expect(parseQuietHours("22:00 to 08:00")).toEqual({ from: "22:00", to: "08:00" });
    expect(parseQuietHours("12:00 AM - 12:00 PM")).toEqual({ from: "00:00", to: "12:00" });
  });

  it("returns null rather than guessing", () => {
    expect(parseQuietHours("be quiet at night")).toBeNull();
  });
});

describe("parseLegacyHouseText on 4709A's real notes", () => {
  const split = parseLegacyHouseText(REAL_LEGACY);

  it("finds the door code once, not twice", () => {
    expect(getHouseInfoValue(split.info, "access", "doorCode")).toBe("001000");
    const doorMatches = split.matched.filter((m) => m.key === "doorCode");
    expect(doorMatches).toHaveLength(1);
  });

  it("pulls the Wi-Fi out of the paragraph", () => {
    expect(getHouseInfoValue(split.info, "wifi", "network")).toBe("4709A");
    expect(getHouseInfoValue(split.info, "wifi", "password")).toBe("4709A4709A$$");
  });

  it("keeps the group chat URL whole, query string and all", () => {
    expect(getHouseInfoValue(split.info, "contacts", "groupChatUrl")).toBe(
      "https://chat.whatsapp.com/JVe6jPceStL8pGDBSsVQBB?mode=gi_t",
    );
  });

  it("reads quiet hours as a range", () => {
    expect(getHouseInfoValue(split.info, "rules", "quietFrom")).toBe("22:00");
    expect(getHouseInfoValue(split.info, "rules", "quietTo")).toBe("08:00");
  });

  it("routes the bulleted rules to their own fields", () => {
    expect(getHouseInfoValue(split.info, "rules", "kitchen")).toContain("Clean dishes");
    expect(getHouseInfoValue(split.info, "rules", "bathroom")).toContain("assigned bathroom");
    expect(getHouseInfoValue(split.info, "rules", "commonAreas")).toContain("Vacuum/mop");
    expect(getHouseInfoValue(split.info, "rules", "smoking")).toContain("prohibited inside the property");
    expect(getHouseInfoValue(split.info, "rules", "other")).toContain("treat other residents with respect");
    expect(getHouseInfoValue(split.info, "trash", "binLocation")).toContain("designated containers");
    expect(getHouseInfoValue(split.info, "trash", "cleaningCadence")).toContain("every two weeks");
  });

  it("flags PropLane's own portal help instead of keeping it as house info", () => {
    const help = split.portalHelp.join("\n");
    expect(help).toContain("Report maintenance");
    expect(help).toContain("Pay rent, review your lease terms");
    expect(getHouseInfoValue(split.info, "access", "notes")).not.toContain("Report maintenance");
  });

  it("keeps the security deposit paragraph verbatim rather than inventing a field for it", () => {
    // It is a lease term that got typed into house rules. The parser must not
    // quietly drop it just because no section owns it.
    expect(split.leftover).toContain("refundable security deposit");
    expect(split.info.other).toContain("refundable security deposit");
  });

  it("loses nothing — every word of the manager's own prose survives the split", () => {
    // Byte-identical lines are the wrong bar. A matched line legitimately
    // trades the manager's ad-hoc label ("Noise & conflict:") for the schema's
    // own ("Other rules"), and a time range becomes two fields. What must never
    // happen is a word of their actual CONTENT disappearing.
    const helpText = split.portalHelp.join("\n").toLowerCase();
    const haystack = [
      ...split.matched.map((m) => m.value),
      split.leftover,
      // Quiet hours are stored as 24-hour times; the source says "10:00 PM".
      "10:00 pm 8:00 am",
    ]
      .join("\n")
      .toLowerCase();

    const words = (text: string): string[] =>
      (text.toLowerCase().match(/[a-z0-9$@/._-]+/g) ?? [])
        .map((word) => word.replace(/^[._-]+|[._-]+$/g, ""))
        .filter((word) => word.length >= 4);

    const sourceWords = `${REAL_GENERAL_HOUSE_INFO}\n${REAL_HOUSE_RULES}`
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      // Whole blocks PropLane now writes for the manager are proposed for
      // removal on purpose, and are shown to them before anything is applied.
      .filter((line) => !helpText.includes(line.toLowerCase()))
      // Drop the manager's own leading label — the schema supplies one.
      .map((line) => {
        const clean = line.replace(/^\s*[*\-•]\s*/, "");
        const idx = clean.indexOf(":");
        if (idx > 0 && clean.slice(0, idx).trim().split(/\s+/).length <= 4) return clean.slice(idx + 1);
        return clean;
      })
      .flatMap(words);

    const missing = [...new Set(sourceWords)].filter((word) => !haystack.includes(word));
    expect(missing, `content dropped by the splitter: ${missing.join(", ")}`).toEqual([]);
  });

  it("reports that there is something to split", () => {
    expect(legacyHouseTextHasSplittableContent(REAL_LEGACY)).toBe(true);
    expect(legacyHouseTextHasSplittableContent({ generalHouseInfo: "just some prose" })).toBe(false);
  });
});

describe("parseLegacyHouseText migration of the dead Wi-Fi pair", () => {
  it("carries the old structured fields across", () => {
    const split = parseLegacyHouseText({
      generalHouseInfo: "",
      houseRulesText: "",
      wifiNetworkName: "OldNet",
      wifiPassword: "OldPass",
    });
    expect(getHouseInfoValue(split.info, "wifi", "network")).toBe("OldNet");
    expect(getHouseInfoValue(split.info, "wifi", "password")).toBe("OldPass");
  });

  it("lets the old structured field win over a repeated line, without dropping the line", () => {
    const split = parseLegacyHouseText({
      generalHouseInfo: "WiFi Username: FromText",
      wifiNetworkName: "FromField",
    });
    expect(getHouseInfoValue(split.info, "wifi", "network")).toBe("FromField");
    expect(split.info.other).toContain("FromText");
  });
});

describe("houseInfoRenderSections", () => {
  it("drops empty fields and empty sections", () => {
    let info = setHouseInfoValue(emptyHouseInfo(), "wifi", "network", "4709A");
    info = setHouseInfoValue(info, "wifi", "password", "4709A4709A$$");
    const sections = houseInfoRenderSections(info);
    expect(sections).toHaveLength(1);
    expect(sections[0].label).toBe("Wi-Fi");
    expect(sections[0].rows.map((r) => r.label)).toEqual(["Network name", "Password"]);
    expect(sections[0].rows.every((r) => r.copyable)).toBe(true);
  });

  it("renders a quiet-hours range as one human row", () => {
    let info = setHouseInfoValue(emptyHouseInfo(), "rules", "quietFrom", "22:00");
    info = setHouseInfoValue(info, "rules", "quietTo", "08:00");
    const rows = houseInfoRenderSections(info)[0].rows;
    expect(rows).toEqual([{ label: "Quiet hours", value: "10:00 PM – 8:00 AM", copyable: false }]);
  });

  it("hides a half-set range rather than showing a dangling time", () => {
    const info = setHouseInfoValue(emptyHouseInfo(), "rules", "quietFrom", "22:00");
    expect(houseInfoRenderSections(info)).toHaveLength(0);
  });

  it("marks a real URL as a link and leaves other text alone", () => {
    const linked = setHouseInfoValue(emptyHouseInfo(), "contacts", "groupChatUrl", "https://chat.whatsapp.com/x");
    expect(houseInfoRenderSections(linked)[0].rows[0].url).toBe("https://chat.whatsapp.com/x");

    const notLinked = setHouseInfoValue(emptyHouseInfo(), "contacts", "groupChatUrl", "ask me for the invite");
    expect(houseInfoRenderSections(notLinked)[0].rows[0].url).toBeUndefined();
  });

  it("returns nothing for an empty or missing record", () => {
    expect(houseInfoRenderSections(emptyHouseInfo())).toEqual([]);
    expect(houseInfoRenderSections(null)).toEqual([]);
  });
});

describe("house details editor chrome", () => {
  it("puts the expand mark at the end of each section row", () => {
    const src = readFileSync("src/components/portal/house-info-sections.tsx", "utf8");
    expect(src).toContain("export function HouseDetailsExpandable");
    expect(src).toContain("PortalTableExpandChevron");
    expect(src.indexOf("SectionCountPill")).toBeLessThan(src.lastIndexOf("PortalTableExpandChevron"));
  });
});

describe("houseInfoToPlainText", () => {
  it("labels every row for the move-in email", () => {
    const info = parseLegacyHouseText(REAL_LEGACY).info;
    const text = houseInfoToPlainText(info);
    expect(text).toContain("Getting in:");
    expect(text).toContain("  Front door code: 001000");
    expect(text).toContain("  Password: 4709A4709A$$");
    // The leftover still travels, so the email is not thinner than the notes.
    expect(text).toContain("refundable security deposit");
  });

  it("is empty when nothing is filled in", () => {
    expect(houseInfoToPlainText(emptyHouseInfo())).toBe("");
    expect(houseInfoToPlainText(null)).toBe("");
  });
});

describe("split review presentation", () => {
  const split = parseLegacyHouseText(REAL_LEGACY);

  it("shows quiet hours once, as the manager wrote them", () => {
    const rows = split.matched.filter((m) => m.label === "Quiet hours");
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe("10:00 PM – 8:00 AM");
  });

  it("keeps leftover text as prose, without the list markers", () => {
    expect(split.leftover).not.toMatch(/^\s*\*/m);
    expect(split.leftover).toContain("Security deposit: A refundable security deposit is required.");
  });
});
