import { createHash, generateKeyPairSync, createSign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyPlaidWebhook, type PlaidVerificationKey } from "@/lib/plaid/webhook-verify.server";

const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwk = publicKey.export({ format: "jwk" }) as PlaidVerificationKey;
const key: PlaidVerificationKey = { ...jwk, alg: "ES256", kid: "k1", expired_at: null };
const fetchKey = async (kid: string) => (kid === "k1" ? key : null);

const b64u = (v: Buffer | string) => Buffer.from(v).toString("base64url");
const NOW = 1_800_000_000;
const body = JSON.stringify({ webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: "item-1" });

function sign(opts: { iat?: number; hash?: string; kid?: string; alg?: string; priv?: typeof privateKey } = {}) {
  const header = b64u(JSON.stringify({ alg: opts.alg ?? "ES256", kid: opts.kid ?? "k1", typ: "JWT" }));
  const payload = b64u(JSON.stringify({ iat: opts.iat ?? NOW, request_body_sha256: opts.hash ?? createHash("sha256").update(body).digest("hex") }));
  const signer = createSign("SHA256");
  signer.update(`${header}.${payload}`);
  const sig = signer.sign({ key: opts.priv ?? privateKey, dsaEncoding: "ieee-p1363" });
  return `${header}.${payload}.${b64u(sig)}`;
}

const verify = (header: string | null, raw = body) => verifyPlaidWebhook(raw, header, { fetchKey, nowSeconds: NOW });

describe("verifyPlaidWebhook", () => {
  it("accepts a valid signature", async () => {
    expect(await verify(sign())).toEqual({ ok: true });
  });
  it("refuses a missing header", async () => {
    expect(await verify(null)).toEqual({ ok: false, reason: "missing_signature" });
  });
  it("refuses a malformed JWT", async () => {
    expect((await verify("abc.def")).ok).toBe(false);
    expect((await verify("a.b.c")).ok).toBe(false);
  });
  it("refuses a wrong algorithm", async () => {
    expect(await verify(sign({ alg: "HS256" }))).toEqual({ ok: false, reason: "bad_header" });
  });
  it("refuses an unknown kid", async () => {
    expect(await verify(sign({ kid: "other" }))).toEqual({ ok: false, reason: "unknown_key" });
  });
  it("refuses a signature from a different key", async () => {
    const other = generateKeyPairSync("ec", { namedCurve: "P-256" });
    expect(await verify(sign({ priv: other.privateKey }))).toEqual({ ok: false, reason: "bad_signature" });
  });
  it("refuses a stale iat", async () => {
    expect(await verify(sign({ iat: NOW - 301 }))).toEqual({ ok: false, reason: "stale" });
    expect((await verify(sign({ iat: NOW - 299 }))).ok).toBe(true);
  });
  it("refuses a body hash mismatch", async () => {
    expect(await verify(sign(), body + " ")).toEqual({ ok: false, reason: "body_mismatch" });
    expect(await verify(sign({ hash: "0".repeat(64) }))).toEqual({ ok: false, reason: "body_mismatch" });
  });
  it("refuses an expired key", async () => {
    const expired = async () => ({ ...key, expired_at: 1 });
    expect(await verifyPlaidWebhook(body, sign(), { fetchKey: expired, nowSeconds: NOW })).toEqual({ ok: false, reason: "expired_key" });
  });
});
