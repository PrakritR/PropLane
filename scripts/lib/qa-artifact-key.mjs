/** Pure shared 256-bit QA artifact key validation. */
export function decodeArtifactKey(value, refusal = (message) => new Error(message)) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw refusal("QA artifact encryption key must be exactly 64 lowercase hexadecimal characters.");
  }
  const bytes = Buffer.from(value, "hex");
  if (bytes.length !== 32) throw refusal("QA artifact encryption key must be 32 bytes.");
  return bytes;
}
