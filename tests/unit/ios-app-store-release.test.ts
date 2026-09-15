import { describe, expect, it } from "vitest";

import {
  bumpPatch,
  compareVersions,
  planBuildVersion,
  planRelease,
  pngSize,
  readXcodeMarketingVersion,
  screenshotsMatch,
  uploadHeaders,
  validateCopy,
} from "../../scripts/ios-app-store-release.mjs";

function version(versionString: string, state: string, id = versionString) {
  return { id, type: "appStoreVersions", attributes: { platform: "IOS", versionString, appVersionState: state } };
}

describe("App Store release: which version a push ships", () => {
  it("creates the next patch when everything Apple has seen is released", () => {
    const plan = planRelease([version("1.0", "READY_FOR_DISTRIBUTION"), version("1.1.0", "READY_FOR_DISTRIBUTION")]);
    expect(plan).toEqual({ action: "create", versionString: "1.1.1" });
  });

  it("reuses the one editable version instead of creating a second", () => {
    const editable = version("1.2.0", "PREPARE_FOR_SUBMISSION");
    const plan = planRelease([version("1.1.0", "READY_FOR_DISTRIBUTION"), editable]);
    expect(plan).toEqual({ action: "reuse", version: editable });
  });

  it("holds while Apple is reviewing a version — the queue is not ours to fight", () => {
    const plan = planRelease([version("1.1.0", "WAITING_FOR_REVIEW")]);
    expect(plan.action).toBe("hold");
    expect(plan.reason).toContain("1.1.0");
    expect(plan.reason).toContain("WAITING_FOR_REVIEW");
  });

  it("holds on an approved version waiting for a manual release", () => {
    const plan = planRelease([version("1.1.0", "PENDING_DEVELOPER_RELEASE")]);
    expect(plan.action).toBe("hold");
    expect(plan.reason).toContain("manual release");
  });

  it("never resubmits a rejected version on its own", () => {
    const rejected = version("1.1.0", "REJECTED");
    const plan = planRelease([rejected]);
    expect(plan.action).toBe("hold");
    expect(plan.reason).toContain("rejected");
    expect(planRelease([rejected], { forceResubmit: true })).toEqual({ action: "reuse", version: rejected });
  });

  it("honours a deliberate minor/major bump in Xcode as a floor", () => {
    const plan = planRelease([version("1.1.0", "READY_FOR_DISTRIBUTION")], { xcodeVersion: "2.0.0" });
    expect(plan).toEqual({ action: "create", versionString: "2.0.0" });
    const lower = planRelease([version("1.1.0", "READY_FOR_DISTRIBUTION")], { xcodeVersion: "1.0.0" });
    expect(lower).toEqual({ action: "create", versionString: "1.1.1" });
  });

  it("refuses to guess between two editable versions", () => {
    expect(() => planRelease([version("1.2.0", "PREPARE_FOR_SUBMISSION"), version("1.3.0", "DEVELOPER_REJECTED")])).toThrow(
      /refusing to guess/,
    );
  });

  it("ignores other platforms", () => {
    const plan = planRelease([{ id: "mac", attributes: { platform: "MAC_OS", versionString: "9.9", appVersionState: "IN_REVIEW" } }]);
    expect(plan).toEqual({ action: "create", versionString: "1.0.0" });
  });
});

describe("App Store release: the version the next build carries", () => {
  it("builds on the next train while the current one is in review", () => {
    expect(planBuildVersion([version("1.0", "READY_FOR_DISTRIBUTION"), version("1.1.0", "WAITING_FOR_REVIEW")])).toBe("1.1.1");
  });

  it("keeps building the editable version when it is already ahead", () => {
    expect(planBuildVersion([version("1.1.0", "READY_FOR_DISTRIBUTION"), version("1.2.0", "PREPARE_FOR_SUBMISSION")])).toBe("1.2.0");
    expect(planBuildVersion([version("1.0", "READY_FOR_DISTRIBUTION"), version("1.1.0", "REJECTED")])).toBe("1.1.0");
  });

  it("moves past an editable version whose train Apple has closed", () => {
    // 1.1.0 was rejected, then a hand-made 1.1.0 build cannot exist because 1.1.1 shipped.
    expect(planBuildVersion([version("1.1.1", "READY_FOR_DISTRIBUTION"), version("1.1.0", "DEVELOPER_REJECTED")])).toBe("1.1.2");
  });

  it("starts at 1.0.0 with nothing on the store and honours the Xcode floor", () => {
    expect(planBuildVersion([])).toBe("1.0.0");
    expect(planBuildVersion([version("1.1.0", "READY_FOR_DISTRIBUTION")], { xcodeVersion: "1.5" })).toBe("1.5");
  });
});

describe("App Store release: helpers", () => {
  it("compares and bumps dotted versions, padding missing parts", () => {
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.1.0", "1.0.9")).toBe(1);
    expect(compareVersions("1.9.9", "1.10.0")).toBe(-1);
    expect(bumpPatch("1.1")).toBe("1.1.1");
    expect(() => bumpPatch("v1")).toThrow();
  });

  it("reads MARKETING_VERSION out of the Xcode project", () => {
    expect(readXcodeMarketingVersion("\t\t\t\tMARKETING_VERSION = 1.1.0;\n")).toBe("1.1.0");
    expect(readXcodeMarketingVersion("nothing here")).toBeNull();
  });

  it("matches the store's screenshot set to the local files by checksum and order", () => {
    const local = [{ checksum: "aa" }, { checksum: "bb" }];
    const remote = (sums: string[]) => sums.map((sum) => ({ attributes: { sourceFileChecksum: sum.toUpperCase() } }));
    expect(screenshotsMatch(remote(["aa", "bb"]), local)).toBe(true);
    expect(screenshotsMatch(remote(["bb", "aa"]), local)).toBe(false);
    expect(screenshotsMatch(remote(["aa"]), local)).toBe(false);
    expect(screenshotsMatch([], [])).toBe(true);
  });

  it("never forwards an Authorization header to Apple's pre-signed upload host", () => {
    const headers = uploadHeaders({
      requestHeaders: [
        { name: "Content-Type", value: "image/png" },
        { name: "Authorization", value: "Bearer leaked" },
      ],
    });
    expect(headers).toEqual({ "Content-Type": "image/png" });
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain("authorization");
  });

  it("reads a PNG's dimensions from its header and rejects other bytes", () => {
    const png = Buffer.alloc(24);
    Buffer.from("89504e470d0a1a0a", "hex").copy(png, 0);
    png.writeUInt32BE(1320, 16);
    png.writeUInt32BE(2868, 20);
    expect(pngSize(png)).toEqual({ width: 1320, height: 2868 });
    expect(pngSize(Buffer.from("not a png at all, really not"))).toBeNull();
  });

  it("enforces Apple's copy limits", () => {
    const ok = { promotionalText: "p", description: "d", whatsNew: "w", keywords: "a,b" };
    expect(validateCopy(ok)).toBe(ok);
    expect(() => validateCopy({ ...ok, promotionalText: "x".repeat(171) })).toThrow(/promotionalText is 171/);
    expect(() => validateCopy({ ...ok, keywords: "a, b" })).toThrow(/without spaces/);
    expect(() => validateCopy({ ...ok, whatsNew: "" })).toThrow(/whatsNew is missing/);
  });
});
