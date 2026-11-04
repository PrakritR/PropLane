import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exactVendorQuoteCode, openVendorQuoteCode, sealVendorQuoteCode, vendorQuoteWireDigest, type QuoteIngressIdentity } from "@/lib/sms/vendor-quote-ingress.server";
const code = "123456789123";
const now = 1_800_000_000_000;
const identity: QuoteIngressIdentity = { messageSid: `SM${"1".repeat(32)}`, wireFrom: "+12065552222", wireTo: "+12065553333",
 accountSid: `AC${"2".repeat(32)}`, runtime: "development", providerMessagingServiceSid: null, payloadDigest: "a".repeat(64) };
beforeEach(() => vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "synthetic-quote-service-secret"));
afterEach(() => vi.unstubAllEnvs());
function sealed() { return sealVendorQuoteCode(code, identity, now); }
function open(capsule = sealed(), bound = identity, at = now + 1) { return openVendorQuoteCode(capsule, bound, new Date(capsule.expiresAt).toISOString(), at); }
describe("sealed quote ingress", () => {
 it("recognizes exact case-insensitive syntax including non-Luhn proofs", () => {
  expect(exactVendorQuoteCode(` quote ${code} `)).toBe(code);
  for (const body of [`QUOTE ${code} extra`, `QUOTE  ${code}`, "QUOTE [redacted]", "hello"]) expect(exactVendorQuoteCode(body)).toBeNull();
 });
 it("round-trips only in memory and uses fresh nonces", () => {
  const a = sealed(); const b = sealed(); expect(open(a)).toBe(code); expect(a.nonce).not.toBe(b.nonce);
  expect(JSON.stringify(a)).not.toContain(code);
 });
 it.each(Object.keys(identity) as Array<keyof QuoteIngressIdentity>)("authenticates transport %s", field => {
  expect(open(sealed(), { ...identity, [field]: `${identity[field] ?? ""}changed` })).toBeNull();
 });
 it.each(["nonce", "ciphertext", "tag"] as const)("rejects corrupt %s", field => {
  const value = { ...sealed() }; value[field] = `${value[field][0] === "a" ? "b" : "a"}${value[field].slice(1)}`; expect(open(value)).toBeNull();
 });
 it("rejects missing deadline, unknown version, invalid time, future issue, expiry and excessive horizon", () => {
  const value = sealed();
  expect(openVendorQuoteCode(value, identity, null, now + 1)).toBeNull();
  expect(open({ ...value, version: 2 } as unknown as typeof value)).toBeNull();
  expect(open({ ...value, issuedAt: NaN })).toBeNull(); expect(open(value, identity, now - 1)).toBeNull();
  expect(open(value, identity, value.expiresAt)).toBeNull(); expect(open({ ...value, expiresAt: now + 600_001 })).toBeNull();
 });
 it("separates key purposes and fails closed on service-key rotation", () => {
  const a = sealed(); const digest = vendorQuoteWireDigest(`Body=QUOTE+${code}`);
  expect(digest).toMatch(/^[a-f0-9]{64}$/); expect(vendorQuoteWireDigest(`Body=QUOTE+${code}`)).toBe(digest);
  expect(digest).not.toBe(createHash("sha256").update(`Body=QUOTE+${code}`).digest("hex"));
  expect(vendorQuoteWireDigest(`Body=QUOTE+${code}&extra=1`)).not.toBe(digest);
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "rotated-secret"); expect(open(a)).toBeNull(); expect(vendorQuoteWireDigest(`Body=QUOTE+${code}`)).not.toBe(digest);
 });
});
