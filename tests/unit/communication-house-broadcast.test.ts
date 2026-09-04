/**
 * PRP-150 — "select all residents have sub group of select all house and list
 * all resident in that house. imagine there are 20 houses and 10 resident in
 * each house … build system for that."
 *
 * At that scale, picking everyone at one house out of a flat list of 200 names
 * is twenty taps. One row per house makes it one.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { houseBroadcastOptions } from "@/components/portal/pro-communication-compose-modal";
import { PROPLANE_SYSTEM_COUNTERPARTY_KEY, isProplaneSystemSenderEmail } from "@/lib/portal-inbox-storage";
import type { InboxScopedContact } from "@/data/inbox-scoped-directory";

const resident = (id: string, name: string, propertyId?: string, propertyLabel?: string) =>
  ({
    id,
    name,
    email: `${id}@example.com`,
    role: "resident",
    tenancyStatus: "resident",
    propertyId,
    propertyLabel,
  }) as InboxScopedContact;

describe("one row per house", () => {
  const people = [
    resident("a", "Ann", "p1", "Brooklyn House"),
    resident("b", "Ben", "p1", "Brooklyn House"),
    resident("c", "Cal", "p2", "Ballard House"),
    resident("d", "Dee", "p2", "Ballard House"),
    resident("e", "Eve", "p2", "Ballard House"),
  ];

  it("offers each house once, with its headcount", () => {
    expect(houseBroadcastOptions(people)).toEqual([
      { key: "house:p2", label: "Everyone at Ballard House (3)" },
      { key: "house:p1", label: "Everyone at Brooklyn House (2)" },
    ]);
  });

  it("sorts by house name so the list is stable", () => {
    const labels = houseBroadcastOptions(people).map((o) => o.label);
    expect(labels).toEqual([...labels].sort());
  });

  it("skips a house with one resident", () => {
    // "Everyone at X" for a single person is that person with a longer label.
    expect(houseBroadcastOptions([resident("z", "Zed", "p9", "Solo House")])).toEqual([]);
  });

  it("skips a resident with no house attached", () => {
    expect(houseBroadcastOptions([resident("n1", "No House"), resident("n2", "Nor Me")])).toEqual([]);
  });
});

describe("the send path resolves houses late", () => {
  const src = readFileSync("src/components/portal/pro-communication-compose-modal.tsx", "utf8");

  it("expands house: keys when the message is sent, not when the picker opened", () => {
    // A resident who moves in between opening the modal and hitting send should
    // still receive it.
    expect(src).toContain('if (key.startsWith("house:")) {');
    expect(src).toContain('const propertyId = key.slice("house:".length);');
  });

  it("reaches only CURRENT residents of that house", () => {
    expect(src).toContain('(c.tenancyStatus ?? "resident") === "resident" &&');
    expect(src).toContain("c.propertyId?.trim() === propertyId,");
  });
});

describe("PropLane's own threads collapse into one", () => {
  it("treats every PropLane system address as the same counterparty", () => {
    for (const address of [
      "noreply@axis.local",
      "invites@axis.local",
      "all-residents@axis.local",
      "broadcast-management@axis.local",
      "something-new@axis.local",
    ]) {
      expect(isProplaneSystemSenderEmail(address)).toBe(true);
    }
    expect(PROPLANE_SYSTEM_COUNTERPARTY_KEY).toContain("@");
  });

  it("leaves tour notifications alone — the guest is the counterparty there", () => {
    expect(isProplaneSystemSenderEmail("tours@axis.local")).toBe(false);
  });

  it("never claims a real person's address", () => {
    expect(isProplaneSystemSenderEmail("jordan@example.com")).toBe(false);
    expect(isProplaneSystemSenderEmail("")).toBe(false);
  });
});
