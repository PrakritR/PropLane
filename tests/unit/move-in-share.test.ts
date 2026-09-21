/**
 * Pure builders behind the room move-in Copy / Share icon actions
 * (`pro-property-room-move-in-panel.tsx`).
 */
import { describe, expect, it } from "vitest";
import { roomMoveInClipboardText, roomMoveInShareUrl } from "@/lib/move-in-share";

describe("roomMoveInShareUrl", () => {
  it("builds a resident move-in link scoped to the room", () => {
    expect(roomMoveInShareUrl("https://proplane.example", "room-1")).toBe(
      "https://proplane.example/resident/move-in?room=room-1",
    );
  });

  it("encodes a room id with special characters", () => {
    expect(roomMoveInShareUrl("https://proplane.example", "room a/b")).toBe(
      "https://proplane.example/resident/move-in?room=room%20a%2Fb",
    );
  });
});

describe("roomMoveInClipboardText", () => {
  it("starts with the room heading", () => {
    const text = roomMoveInClipboardText({
      roomLabel: "Room 2",
      instructions: "",
      photoCount: 0,
      hasVideo: false,
    });
    expect(text).toBe("Room 2 — move-in");
  });

  it("includes room instructions and a singular/plural media line", () => {
    const onePhoto = roomMoveInClipboardText({
      roomLabel: "Room A",
      instructions: "Lockbox on porch.",
      photoCount: 1,
      hasVideo: false,
    });
    expect(onePhoto).toBe("Room A — move-in\nLockbox on porch.\n1 photo");

    const manyPhotosAndVideo = roomMoveInClipboardText({
      roomLabel: "Room A",
      instructions: "Lockbox on porch.",
      photoCount: 2,
      hasVideo: true,
    });
    expect(manyPhotosAndVideo).toBe("Room A — move-in\nLockbox on porch.\n2 photos · 1 video");
  });

  it("omits the media line when there are no photos and no video", () => {
    const text = roomMoveInClipboardText({
      roomLabel: "Room A",
      instructions: "Lockbox on porch.",
      photoCount: 0,
      hasVideo: false,
    });
    expect(text).toBe("Room A — move-in\nLockbox on porch.");
  });

  it("skips blank instructions rather than printing an empty line", () => {
    const text = roomMoveInClipboardText({
      roomLabel: "Room A",
      instructions: "   ",
      photoCount: 1,
      hasVideo: false,
    });
    expect(text).toBe("Room A — move-in\n1 photo");
  });

  it("omits a resident with no content of their own", () => {
    const text = roomMoveInClipboardText({
      roomLabel: "Room A",
      instructions: "Shared instructions.",
      photoCount: 0,
      hasVideo: false,
      residents: [
        { slot: 1, instructions: "", photoCount: 0, hasVideo: false },
        { slot: 2, instructions: "Your bed is by the window.", photoCount: 1, hasVideo: true },
      ],
    });
    expect(text).toBe(
      [
        "Room A — move-in",
        "Shared instructions.",
        "",
        "Resident 2",
        "Your bed is by the window.",
        "1 photo · 1 video",
      ].join("\n"),
    );
    expect(text).not.toContain("Resident 1");
  });

  it("never includes a data URL — the builder only ever receives counts, not the photo/video data itself", () => {
    const text = roomMoveInClipboardText({
      roomLabel: "Room A",
      instructions: "Keys under the mat.",
      photoCount: 3,
      hasVideo: true,
      residents: [{ slot: 1, instructions: "Your closet is the left one.", photoCount: 1, hasVideo: true }],
    });
    expect(text).not.toContain("data:");
    expect(text).not.toContain("base64");
    expect(text).toContain("3 photos · 1 video");
  });
});
