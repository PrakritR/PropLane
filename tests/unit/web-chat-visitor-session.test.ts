// The anonymous web-chat visitor: a signed httpOnly cookie id and nothing else. Tampering, a foreign secret, expiry and a
// malformed value all read as "no visitor"; rotation re-signs the SAME id.
import { describe, expect, it } from "vitest";
import {
  VISITOR_MAX_AGE_SEC,
  VISITOR_ROTATE_AFTER_SEC,
  cookieFromHeader,
  newVisitorId,
  signVisitorCookie,
  verifyVisitorCookie,
  visitorHandle,
} from "@/lib/web-chat/visitor-session";

const SECRET = "test-secret-one";
const NOW = 1_800_000_000_000;

describe("web chat visitor cookie", () => {
  it("round-trips an id and never needs rotation when fresh", () => {
    const id = newVisitorId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    const check = verifyVisitorCookie(SECRET, signVisitorCookie(SECRET, id, NOW), NOW + 1000);
    expect(check).toEqual({ ok: true, visitorId: id, needsRotation: false });
  });

  it("rejects a tampered id, a foreign secret, a forged mac and malformed values", () => {
    const id = newVisitorId();
    const good = signVisitorCookie(SECRET, id, NOW);
    const other = newVisitorId();
    expect(verifyVisitorCookie(SECRET, good.replace(id, other), NOW).ok).toBe(false);
    expect(verifyVisitorCookie("another-secret", good, NOW).ok).toBe(false);
    expect(verifyVisitorCookie(SECRET, `${good.slice(0, -2)}xx`, NOW).ok).toBe(false);
    for (const bad of ["", null, undefined, "v1", "v2.a.b.c", "x".repeat(300), `v1.${id}.notanumber.sig`]) {
      expect(verifyVisitorCookie(SECRET, bad as string | null, NOW).ok).toBe(false);
    }
  });

  it("expires after the max age and rejects a cookie from the future", () => {
    const id = newVisitorId();
    const cookie = signVisitorCookie(SECRET, id, NOW);
    expect(verifyVisitorCookie(SECRET, cookie, NOW + (VISITOR_MAX_AGE_SEC + 10) * 1000).ok).toBe(false);
    expect(verifyVisitorCookie(SECRET, signVisitorCookie(SECRET, id, NOW + 3_600_000), NOW).ok).toBe(false);
  });

  it("asks for rotation after a week and keeps the SAME visitor id when re-signed", () => {
    const id = newVisitorId();
    const cookie = signVisitorCookie(SECRET, id, NOW);
    const later = NOW + (VISITOR_ROTATE_AFTER_SEC + 60) * 1000;
    const check = verifyVisitorCookie(SECRET, cookie, later);
    expect(check).toEqual({ ok: true, visitorId: id, needsRotation: true });
    const rotated = signVisitorCookie(SECRET, id, later);
    expect(rotated).not.toBe(cookie);
    expect(verifyVisitorCookie(SECRET, rotated, later)).toEqual({ ok: true, visitorId: id, needsRotation: false });
  });

  it("derives the spine handle from the id alone and reads one cookie from a header", () => {
    expect(visitorHandle("abc")).toBe("web_abc");
    expect(cookieFromHeader("a=1; pl_wc=v1.x.y.z; b=2", "pl_wc")).toBe("v1.x.y.z");
    expect(cookieFromHeader("a=1", "pl_wc")).toBeNull();
  });
});
