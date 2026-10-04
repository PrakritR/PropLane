/**
 * Who's doing what on the shared Calendar: stable colours, initials, the pale availability blocks
 * and the open-slot union behind "N open".
 */
import { describe, expect, it } from "vitest";
import {
  PERSON_COLORS,
  assignPersonColors,
  buildCalendarPeople,
  contrastRatio,
  inkOnPersonColor,
  openTourSlotKeys,
  peerAvailabilityBlocks,
  personAvailabilityBlocks,
  personAvailabilityStyle,
  personInitials,
} from "@/lib/calendar-people";
import { defaultTourSlotExclusionKey } from "@/lib/tour-slot-math";

describe("person colours", () => {
  it("uses the validated categorical order", () => {
    expect([...PERSON_COLORS]).toEqual(["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4"]);
  });

  it("assigns by the stable sort of the user id, whatever order people arrive in", () => {
    const a = assignPersonColors(["user-c", "user-a", "user-b"]);
    const b = assignPersonColors(["user-b", "user-c", "user-a"]);
    expect([...a.entries()].sort()).toEqual([...b.entries()].sort());
    expect(a.get("user-a")).toBe(PERSON_COLORS[0]);
    expect(a.get("user-b")).toBe(PERSON_COLORS[1]);
    expect(a.get("user-c")).toBe(PERSON_COLORS[2]);
  });

  it("reuses a colour only from the sixth person on", () => {
    const ids = ["u1", "u2", "u3", "u4", "u5", "u6"];
    const colors = assignPersonColors(ids);
    expect(new Set(ids.slice(0, 5).map((id) => colors.get(id))).size).toBe(5);
    expect(colors.get("u6")).toBe(colors.get("u1"));
  });

  it("never repaints a survivor: colours come from the full people set, not from who is shown", () => {
    const peers = [
      { userId: "user-a", label: "Ana Diaz", isSelf: true },
      { userId: "user-b", label: "Ben Ito", isSelf: false },
      { userId: "user-c", label: "Cy Park", isSelf: false },
    ];
    const everyone = buildCalendarPeople(peers);
    // Hiding is a client filter over these same people; the colour table is the same one.
    const colorOf = (id: string) => everyone.find((person) => person.userId === id)!.color;
    const again = buildCalendarPeople([...peers].reverse());
    for (const person of again) expect(person.color).toBe(colorOf(person.userId));
    expect(colorOf("user-c")).toBe(PERSON_COLORS[2]);
  });

  it("lists you first, then everyone else by name, with initials", () => {
    const people = buildCalendarPeople([
      { userId: "z", label: "Zed Zhao", isSelf: false },
      { userId: "a", label: "You", isSelf: true },
      { userId: "m", label: "Maya Chen", isSelf: false },
    ]);
    expect(people.map((person) => person.userId)).toEqual(["a", "m", "z"]);
    expect(people.map((person) => person.initials)).toEqual(["YO", "MC", "ZZ"]);
  });
});

describe("initials", () => {
  it("takes first and last word, one word gives two letters, nothing gives ?", () => {
    expect(personInitials("Maya Chen")).toBe("MC");
    expect(personInitials("Maya Louise Chen")).toBe("MC");
    expect(personInitials("Primary manager")).toBe("PM");
    expect(personInitials("maya")).toBe("MA");
    expect(personInitials("")).toBe("?");
  });
});

describe("availability blocks", () => {
  it("merges contiguous half hours into one block per day and drops other dates", () => {
    const blocks = personAvailabilityBlocks({
      userId: "u1",
      kind: "services",
      slots: ["2026-10-06:18", "2026-10-06:19", "2026-10-06:20", "2026-10-06:30", "2026-10-09:18"],
      dateStrs: ["2026-10-05", "2026-10-06", "2026-10-07"],
    });
    expect(blocks.map((b) => [b.dateStr, b.startMin, b.endMin])).toEqual([
      ["2026-10-06", 540, 630],
      ["2026-10-06", 900, 930],
    ]);
    expect(blocks.every((b) => b.kind === "services" && b.userId === "u1")).toBe(true);
  });

  it("does not draw the default-window exclusion markers of a tours slot set", () => {
    const blocks = personAvailabilityBlocks({
      userId: "u1",
      kind: "tours",
      slots: ["2026-10-06:18", defaultTourSlotExclusionKey("2026-10-06", 19)],
      dateStrs: ["2026-10-06"],
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ startMin: 540, endMin: 570 });
  });

  it("reads a peer's three kinds in a fixed order", () => {
    const blocks = peerAvailabilityBlocks({
      userId: "p",
      toursSlots: ["2026-10-06:18"],
      kindSlots: { services: ["2026-10-06:20"], tasks: ["2026-10-06:22"] },
      dateStrs: ["2026-10-06"],
    });
    expect(blocks.map((b) => b.kind)).toEqual(["tours", "services", "tasks"]);
  });

  it("draws pale: a 12% tint and a 45% border of the person's colour", () => {
    const style = personAvailabilityStyle("#2a78d6");
    expect(style.background).toContain("#2a78d6 12%");
    expect(style.borderColor).toContain("#2a78d6 45%");
  });
});

describe("ink on a solid block", () => {
  it("is white or the dark ink token, whichever reads better, for every person colour", () => {
    for (const color of PERSON_COLORS) {
      const ink = inkOnPersonColor(color);
      const other = ink === "#ffffff" ? "#0f172a" : "#ffffff";
      expect(contrastRatio(color, ink)).toBeGreaterThanOrEqual(contrastRatio(color, other));
      expect(contrastRatio(color, ink)).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("N open across everyone available", () => {
  const slot = (n: number) => `2026-10-06:${n}`;

  it("keeps a slot open while at least one person offers it and is free", () => {
    const open = openTourSlotKeys([
      { userId: "me", offered: new Set([slot(18), slot(19)]), busy: new Set([slot(18)]) },
      { userId: "peer", offered: new Set([slot(18), slot(20)]), busy: new Set() },
    ]);
    expect([...open].sort()).toEqual([slot(18), slot(19), slot(20)]);
  });

  it("closes a slot only when everyone who offers it is busy", () => {
    const open = openTourSlotKeys([
      { userId: "me", offered: new Set([slot(18)]), busy: new Set([slot(18)]) },
      { userId: "peer", offered: new Set([slot(18)]), busy: new Set([slot(18)]) },
    ]);
    expect(open.size).toBe(0);
  });

  it("with only the viewer it is offered minus busy, as before", () => {
    const open = openTourSlotKeys([{ userId: "me", offered: new Set([slot(18), slot(19)]), busy: new Set([slot(19)]) }]);
    expect([...open]).toEqual([slot(18)]);
  });
});
