// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { markNativeSession, NATIVE_SESSION_MARKER_COOKIE } from "@/lib/native/native-session-marker";

function fakeDocument(protocol: string): { doc: Document; cookies: string[] } {
  const cookies: string[] = [];
  const doc = {
    location: { protocol },
    get cookie() {
      return cookies.join("; ");
    },
    set cookie(value: string) {
      cookies.push(value);
    },
  } as unknown as Document;
  return { doc, cookies };
}

describe("markNativeSession", () => {
  it("sets a first-party, one-year, SameSite=Lax cookie on the current host", () => {
    const { doc, cookies } = fakeDocument("https:");
    markNativeSession(doc);
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toContain(`${NATIVE_SESSION_MARKER_COOKIE}=1`);
    expect(cookies[0]).toContain("path=/");
    expect(cookies[0]).toContain("max-age=31536000");
    expect(cookies[0]).toContain("SameSite=Lax");
    expect(cookies[0]).not.toContain("domain=");
  });

  it("adds Secure only over https", () => {
    const https = fakeDocument("https:");
    markNativeSession(https.doc);
    expect(https.cookies[0]).toContain("Secure");

    const http = fakeDocument("http:");
    markNativeSession(http.doc);
    expect(http.cookies[0]).not.toContain("Secure");
  });

  it("never throws when document.cookie access fails", () => {
    const doc = {
      location: { protocol: "https:" },
      set cookie(_value: string) {
        throw new Error("cookies disabled");
      },
    } as unknown as Document;
    expect(() => markNativeSession(doc)).not.toThrow();
  });

  it("defaults to the global document when no argument is given", () => {
    const setter = vi.fn();
    const originalDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, "cookie");
    Object.defineProperty(document, "cookie", {
      configurable: true,
      get: () => "",
      set: setter,
    });
    try {
      markNativeSession();
      expect(setter).toHaveBeenCalledTimes(1);
    } finally {
      if (originalDescriptor) Object.defineProperty(Document.prototype, "cookie", originalDescriptor);
    }
  });
});
