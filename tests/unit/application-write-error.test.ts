import { describe, expect, it } from "vitest";
import { managerApplicationDatabaseWriteMessage } from "@/lib/rental-application/application-write-error";

describe("manager application database refusal", () => {
  it.each([
    "This room is blocked for the requested dates.",
    "No bed is available in this room for the requested dates.",
    "That resident slot is already held for this room.",
  ])("returns the known capacity message", (message) => {
    expect(managerApplicationDatabaseWriteMessage({ code: "P4001", message })).toBe(message);
  });
  it("does not expose unknown database messages", () => {
    expect(managerApplicationDatabaseWriteMessage({ code: "P4001", message: "private data" })).toBe("The selected room is unavailable for these dates.");
    expect(managerApplicationDatabaseWriteMessage({ code: "23514", message: "private data" })).toBe("Could not save application.");
  });
});
