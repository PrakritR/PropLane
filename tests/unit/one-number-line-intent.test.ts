import { describe, expect, it } from "vitest";
import {
  classifyLineText,
  isHousingSearchText,
  isPayLinkText,
  isPersonalHousingSearchText,
  isWriteText,
  statusTopicOf,
} from "@/lib/one-number/line-intent";

describe("housing search is decided per text", () => {
  it.each([
    "hey is there any house available",
    "Hi, do you have any rooms available?",
    "I'm looking for another place",
    "looking for a room near UW",
    "need a new place by december",
    "any houses for rent right now",
    "what rooms do you have",
    "I'm moving, anything available?",
    "find me a house",
  ])("%s is a housing search", (text) => {
    expect(isHousingSearchText(text)).toBe(true);
    expect(classifyLineText(text).kind).toBe("housing_search");
  });

  it.each([
    "when is my rent due",
    "send me my rent link",
    "the sink in my room is leaking",
    "can I pay my rent late",
    "thanks",
    "how are my houses doing",
  ])("%s is not", (text) => {
    expect(isHousingSearchText(text)).toBe(false);
  });

  it("a landlord's vacancy question is status, not a search; only first person counts for a member", () => {
    expect(classifyLineText("any rooms available?", { member: true }).kind).not.toBe("housing_search");
    expect(classifyLineText("which rooms are open at my house", { member: true })).toEqual({ kind: "status", topic: "vacancies" });
    expect(classifyLineText("i'm looking for a place for my sister", { member: true }).kind).toBe("housing_search");
    expect(isPersonalHousingSearchText("any rooms available?")).toBe(false);
  });
});

describe("pay link", () => {
  it.each(["send me my rent link", "how do I pay rent", "pay link please", "what do I owe", "need the deposit link"])("%s", (text) => {
    expect(isPayLinkText(text)).toBe(true);
  });
  it("a housing search that mentions rent is not a pay ask", () => {
    expect(isPayLinkText("looking for a room to rent")).toBe(false);
  });
});

describe("write versus status", () => {
  it.each(["text Sam that the plumber is coming", "please mark room 3 rented", "send a reminder to everyone", "cancel the tour tomorrow", "approve the repair"])(
    "%s is a change request",
    (text) => {
      expect(isWriteText(text)).toBe(true);
      expect(classifyLineText(text, { member: true }).kind).toBe("write");
    },
  );
  it.each(["send me the status", "tell me how the houses are doing", "text me a summary"])("%s is a question in command form", (text) => {
    expect(isWriteText(text)).toBe(false);
  });

  it.each([
    ["how are my houses doing", "overview"],
    ["any vacancies", "vacancies"],
    ["who hasn't paid", "rent"],
    ["unpaid rent this month", "rent"],
    ["recent payments", "payments"],
    ["tours this week", "tours"],
    ["open repairs", "services"],
    ["leases ending soon", "leases"],
  ] as const)("%s -> %s", (text, topic) => {
    expect(statusTopicOf(text)).toBe(topic);
    expect(classifyLineText(text, { member: true }).kind === "status" || classifyLineText(text, { member: true }).kind === "pay_link").toBe(true);
  });
});
