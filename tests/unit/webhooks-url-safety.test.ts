import { describe, expect, it } from "vitest";

import { checkWebhookUrl, isPrivateWebhookHost } from "@/lib/webhooks/url-safety";

/**
 * SSRF guard. The URL is attacker-chosen (anyone with a manager account types
 * it in) and PropLane's server then dials it from inside its own network, so
 * this refusal list is the feature's main safety property. It is allowlist
 * shaped: anything not recognised as public is refused.
 */
describe("webhook URL safety", () => {
  it("accepts an ordinary public HTTPS endpoint", () => {
    const result = checkWebhookUrl("https://hooks.example.com/proplane?tenant=7");
    expect(result.ok).toBe(true);
  });

  it("refuses anything but https on the default port", () => {
    expect(checkWebhookUrl("http://hooks.example.com/x")).toMatchObject({ ok: false, reason: "scheme" });
    expect(checkWebhookUrl("ftp://hooks.example.com/x")).toMatchObject({ ok: false, reason: "scheme" });
    // A non-default port is how an internal service is usually reached.
    expect(checkWebhookUrl("https://hooks.example.com:8080/x")).toMatchObject({ ok: false, reason: "port" });
    expect(checkWebhookUrl("not a url")).toMatchObject({ ok: false, reason: "invalid" });
    expect(checkWebhookUrl("https://user:pass@hooks.example.com/x")).toMatchObject({
      ok: false,
      reason: "credentials",
    });
  });

  it("refuses loopback and localhost in every spelling", () => {
    for (const url of [
      "https://localhost/hook",
      "https://LOCALHOST./hook",
      "https://127.0.0.1/hook",
      "https://127.1.2.3/hook",
      "https://[::1]/hook",
      "https://app.localhost/hook",
    ]) {
      expect(checkWebhookUrl(url), url).toMatchObject({ ok: false, reason: "private_host" });
    }
  });

  it("refuses private, link-local and metadata addresses", () => {
    for (const host of [
      "10.0.0.5",
      "172.16.4.4",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254", // cloud instance metadata — the classic SSRF target
      "100.64.0.1", // CGNAT
      "0.0.0.0",
      "224.0.0.1",
      "255.255.255.255",
    ]) {
      expect(isPrivateWebhookHost(host), host).toBe(true);
      expect(checkWebhookUrl(`https://${host}/hook`), host).toMatchObject({ ok: false, reason: "private_host" });
    }
  });

  it("refuses IPv6 private space, including v4-mapped loopback", () => {
    for (const host of ["::1", "::", "fd00::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:169.254.169.254"]) {
      expect(isPrivateWebhookHost(host), host).toBe(true);
    }
    expect(isPrivateWebhookHost("2606:4700:4700::1111")).toBe(false);
  });

  it("refuses private-network name suffixes and bare labels", () => {
    for (const host of ["printer.local", "db.internal", "svc.home.arpa", "intranet"]) {
      expect(isPrivateWebhookHost(host), host).toBe(true);
    }
  });

  it("172.15 and 172.32 are public — the private block is 172.16-31 only", () => {
    expect(isPrivateWebhookHost("172.15.0.1")).toBe(false);
    expect(isPrivateWebhookHost("172.32.0.1")).toBe(false);
  });
});
