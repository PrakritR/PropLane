/** Browser-safe wire format. Only a per-upload key reaches the browser, never the application key. */
export const APPLICATION_DOCUMENT_MAGIC = "PROPLANE-DOC:1\n";
export const APPLICATION_DOCUMENT_ENCRYPTED_SUFFIX = ".penc";
export const APPLICATION_DOCUMENT_MAX_HEADER_BYTES = 2048;
export const APPLICATION_DOCUMENT_OVERHEAD_BYTES = 4096;
export const APPLICATION_DOCUMENT_STORAGE_MIME = "application/octet-stream";

export type ApplicationDocumentUploadEncryption = {
  version: 1;
  dataKey: string;
  wrappedKey: string;
};

export function applicationDocumentAad(storagePath: string): Uint8Array<ArrayBuffer> {
  const parts = storagePath.split("/");
  if (parts.length !== 3 || parts[0] !== "application" || !/^[A-Z0-9_-]+$/.test(parts[1]) ||
      !/^[A-Za-z0-9_-]+\.(?:jpg|png|webp|heic|heif|pdf)\.penc$/.test(parts[2])) {
    throw new Error("Invalid protected document path.");
  }
  return new TextEncoder().encode(JSON.stringify(["proplane-application-document", "v1", parts[1], storagePath]));
}

/** Encrypt locally before direct Storage upload, preserving the 15 MB phone/PDF transport. */
export async function encryptApplicationDocumentUpload(
  source: Blob,
  storagePath: string,
  encryption: ApplicationDocumentUploadEncryption,
): Promise<Blob> {
  if (encryption?.version !== 1 || !/^[A-Za-z0-9+/]{43}=$/.test(encryption.dataKey) ||
      typeof encryption.wrappedKey !== "string" || !encryption.wrappedKey.startsWith("proplane:v1:")) {
    throw new Error("Invalid document encryption configuration.");
  }
  const additionalData = applicationDocumentAad(storagePath);
  const keyBytes = Uint8Array.from(atob(encryption.dataKey), (character) => character.charCodeAt(0));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
  keyBytes.fill(0);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData, tagLength: 128 }, key, await source.arrayBuffer(),
  );
  const header = new TextEncoder().encode(JSON.stringify({
    wrappedKey: encryption.wrappedKey,
    iv: btoa(String.fromCharCode(...iv)),
  }));
  if (header.byteLength > APPLICATION_DOCUMENT_MAX_HEADER_BYTES) throw new Error("Invalid document encryption header.");
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, header.byteLength, false);
  return new Blob([APPLICATION_DOCUMENT_MAGIC, length, header, ciphertext], { type: APPLICATION_DOCUMENT_STORAGE_MIME });
}
