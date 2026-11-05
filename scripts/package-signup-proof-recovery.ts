/** Encrypt only validated, secret-free journals using the existing QA key contract. */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { decodeArtifactKey as encryptionKeyBytes } from "./lib/qa-artifact-key.mjs";
import { readSignupJournal } from "../tests/helpers/signup-proof-journal";

const format = "proplane-signup-proof-recovery/v1";
const aad = (sha: string) => { if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("Signup recovery commit refused."); return Buffer.from(`${format}/${sha}`); };
export function packageSignupRecovery(dir: string, output: string, keyHex: string, sha: string): number {
  const key = encryptionKeyBytes(keyHex), binding = aad(sha);
  const stat = lstatSync(dir);
  if (!path.isAbsolute(dir) || !stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700 || realpathSync(dir) !== dir) throw new Error("Signup recovery directory refused.");
  const names = readdirSync(dir).filter((name) => /^p8-[a-f0-9]{32}\.manifest\.json$/.test(name)).sort();
  if (names.length > 10) throw new Error("Signup recovery journal bound exceeded.");
  const journals = names.map((name) => readSignupJournal(path.join(dir, name)));
  const bytes = Buffer.from(JSON.stringify({ format, sha, journals }));
  if (bytes.length > 1024 * 1024 || bytes.includes(Buffer.from(keyHex))) throw new Error("Signup recovery payload refused.");
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(binding);
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  writeFileSync(output, JSON.stringify({ format, sha, iv: iv.toString("hex"), tag: cipher.getAuthTag().toString("hex"), ciphertext: ciphertext.toString("base64") }), { flag: "wx", mode: 0o600 });
  return journals.length;
}
export function decryptSignupRecovery(file: string, keyHex: string, sha: string): unknown {
  const raw = readFileSync(file);
  if (raw.length > 2 * 1024 * 1024) throw new Error("Signup recovery payload refused.");
  const envelope = JSON.parse(raw.toString());
  if (envelope.format !== format || envelope.sha !== sha || !/^[a-f0-9]{24}$/.test(envelope.iv) || !/^[a-f0-9]{32}$/.test(envelope.tag)) throw new Error("Signup recovery envelope refused.");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKeyBytes(keyHex), Buffer.from(envelope.iv, "hex"));
  decipher.setAAD(aad(sha)); decipher.setAuthTag(Buffer.from(envelope.tag, "hex"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]).toString());
}
if (typeof require !== "undefined" && require.main === module) {
  try {
    const count = packageSignupRecovery(process.env.AUTH_PROOF_CAPTURE_DIR ?? "", process.env.SIGNUP_PROOF_RECOVERY_FILE ?? "", process.env.QA_ARTIFACT_ENCRYPTION_KEY ?? "", process.env.GITHUB_SHA ?? "");
    console.log(`Signup reconciliation: encrypted journals=${count}.`);
  } catch { console.error("Signup recovery packaging refused; retain the private capture directory."); process.exitCode = 1; }
}
