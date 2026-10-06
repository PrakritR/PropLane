import { describe, expect, it } from "vitest";

import { META_OAUTH_STATE_TTL_MS, signMetaOAuthState, verifyMetaOAuthState } from "@/lib/listing-channels/meta/oauth-state";

const SECRET = "meta-app-secret";
const STATE = { userId: "user-1", workspaceId: "ws-1", returnPath: "/portal/profile?tab=spreadsheets" };

describe("Meta OAuth state", () => {
  it("round-trips the manager, workspace and return path", () => {
    expect(verifyMetaOAuthState(signMetaOAuthState(STATE, SECRET), SECRET)).toEqual(STATE);
  });

  it("rejects a state signed with another secret, a tampered payload, and garbage", () => {
    const state = signMetaOAuthState(STATE, SECRET);
    expect(verifyMetaOAuthState(state, "other-secret")).toBeNull();
    const decoded = Buffer.from(state, "base64url").toString("utf8");
    const forged = Buffer.from(decoded.replace("user-1", "user-2")).toString("base64url");
    expect(verifyMetaOAuthState(forged, SECRET)).toBeNull();
    expect(verifyMetaOAuthState("not-a-state", SECRET)).toBeNull();
    expect(verifyMetaOAuthState("", SECRET)).toBeNull();
    expect(verifyMetaOAuthState(null, SECRET)).toBeNull();
  });

  it("expires after 15 minutes and refuses a state from the future", () => {
    const now = 1_700_000_000_000;
    const state = signMetaOAuthState(STATE, SECRET, now);
    expect(verifyMetaOAuthState(state, SECRET, now + META_OAUTH_STATE_TTL_MS - 1)).toEqual(STATE);
    expect(verifyMetaOAuthState(state, SECRET, now + META_OAUTH_STATE_TTL_MS + 1)).toBeNull();
    expect(verifyMetaOAuthState(state, SECRET, now - 5 * 60_000)).toBeNull();
  });

  it("never returns an off-site path", () => {
    for (const bad of ["https://evil.test/x", "//evil.test/x", "javascript:alert(1)"]) {
      const out = verifyMetaOAuthState(signMetaOAuthState({ ...STATE, returnPath: bad }, SECRET), SECRET);
      expect(out?.returnPath).toBe("/portal/profile");
    }
  });
});
