import { describe, expect, it } from "vitest";
import {
  IOS_APP_STORE_APP_ID,
  iosAppDownloadIsTestFlight,
  iosAppDownloadLabel,
  iosAppDownloadUrl,
} from "@/lib/ios-app-download";
import { isAppNavHiddenInNativeShell } from "@/lib/portals/nav-groups";

describe("ios-app-download", () => {
  it("defaults to the canonical App Store URL", () => {
    expect(iosAppDownloadUrl()).toBe(`https://apps.apple.com/us/app/proplane/id${IOS_APP_STORE_APP_ID}`);
  });

  it("honors NEXT_PUBLIC_IOS_APP_DOWNLOAD_URL override", () => {
    const prev = process.env.NEXT_PUBLIC_IOS_APP_DOWNLOAD_URL;
    process.env.NEXT_PUBLIC_IOS_APP_DOWNLOAD_URL = "https://testflight.apple.com/join/abc123";
    try {
      expect(iosAppDownloadUrl()).toBe("https://testflight.apple.com/join/abc123");
      expect(iosAppDownloadIsTestFlight()).toBe(true);
      expect(iosAppDownloadLabel()).toBe("Join the iOS beta on TestFlight");
    } finally {
      if (prev === undefined) delete process.env.NEXT_PUBLIC_IOS_APP_DOWNLOAD_URL;
      else process.env.NEXT_PUBLIC_IOS_APP_DOWNLOAD_URL = prev;
    }
  });

  it("labels App Store links distinctly from TestFlight", () => {
    expect(iosAppDownloadIsTestFlight(`https://apps.apple.com/app/id${IOS_APP_STORE_APP_ID}`)).toBe(false);
    expect(iosAppDownloadLabel(`https://apps.apple.com/app/id${IOS_APP_STORE_APP_ID}`)).toBe(
      "Download on the App Store",
    );
  });
});

describe("isAppNavHiddenInNativeShell", () => {
  it("hides the manager App tab inside the native shell only", () => {
    expect(isAppNavHiddenInNativeShell("manager", "app", true)).toBe(true);
    expect(isAppNavHiddenInNativeShell("pro", "app", true)).toBe(true);
    expect(isAppNavHiddenInNativeShell("manager", "app", false)).toBe(false);
    expect(isAppNavHiddenInNativeShell("resident", "app", true)).toBe(false);
    expect(isAppNavHiddenInNativeShell("manager", "dashboard", true)).toBe(false);
  });
});
