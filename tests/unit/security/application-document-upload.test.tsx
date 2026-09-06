// @vitest-environment jsdom
import { Blob as NodeBlob, File as NodeFile } from "node:buffer";
import { randomBytes, webcrypto } from "node:crypto";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApplicationDocumentUploadEncryption, decryptApplicationDocumentBytes } from "@/lib/security/application-document-crypto.server";

const mocks = vi.hoisted(() => ({ upload: vi.fn(), settle: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase/browser", () => ({
  createSupabaseBrowserClient: () => ({ storage: { from: () => ({ uploadToSignedUrl: mocks.upload }) } }),
}));
vi.mock("@/lib/manager-applications-storage", () => ({ settlePendingApplicationRowUpserts: mocks.settle }));

import { ApplicationPhotoField } from "@/components/marketing/application-photo-field";

const path = "application/PROPLANE-APP1/idFront-123-uuid.jpg.penc";
const original = Buffer.from("synthetic phone photo");

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("DATA_ENCRYPTION_ACTIVE_KEY_ID", "test");
  vi.stubEnv("DATA_ENCRYPTION_KEYS_JSON", JSON.stringify({ test: randomBytes(32).toString("base64") }));
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("Blob", NodeBlob);
  vi.stubGlobal("File", NodeFile);
  const BaseURL = URL;
  vi.stubGlobal("URL", class extends BaseURL {
    static createObjectURL() { return "blob:synthetic-preview"; }
    static revokeObjectURL() {}
  });
  mocks.upload.mockResolvedValue({ error: null });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it.each(["camera", "file"])("encrypts %s picker bytes and passes only safe attachment metadata to autosave", async (picker) => {
  const encryption = createApplicationDocumentUploadEncryption(path, original.length);
  const secret = encryption.dataKey;
  const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ path, token: "upload-token", fileName: "identity.jpg", encryption }));
  vi.stubGlobal("fetch", fetchMock);
  const onChange = vi.fn();
  const { container } = render(<ApplicationPhotoField
    slot="idFront" label="Photo ID" attachment={null} onChange={onChange}
    getApplicationId={() => "PROPLANE-APP1"} setupTokenRequired getSetupToken={() => "guest-token"}
  />);
  const inputs = container.querySelectorAll('input[type="file"]');
  const input = inputs[picker === "camera" ? 0 : 1];
  if (picker === "camera") expect(input).toHaveAttribute("capture", "environment");
  fireEvent.change(input, { target: { files: [new NodeFile([original], "identity.jpg", { type: "image/jpeg" })] } });

  await waitFor(() => expect(onChange).toHaveBeenCalledOnce());
  expect(mocks.settle).toHaveBeenCalledWith("PROPLANE-APP1");
  expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ encryptionVersion: 1, setupToken: "guest-token" });
  const [objectPath, , stored, options] = mocks.upload.mock.calls[0];
  expect(objectPath).toBe(path);
  expect(options).toEqual({ contentType: "application/octet-stream" });
  const bytes = Buffer.from(await stored.arrayBuffer());
  expect(bytes.includes(original)).toBe(false);
  expect(decryptApplicationDocumentBytes(bytes, path)).toEqual(original);
  expect(onChange.mock.calls[0][0]).toMatchObject({ storagePath: path, mimeType: "image/jpeg", sizeBytes: original.length });
  expect(JSON.stringify(onChange.mock.calls)).not.toContain(secret);
  expect(JSON.stringify(onChange.mock.calls)).not.toContain("wrappedKey");
  for (const storage of [window.localStorage, window.sessionStorage]) {
    for (let i = 0; i < storage.length; i++) expect(storage.getItem(storage.key(i)!)).not.toContain(secret);
  }
});

it("shows a recoverable error and never uploads plaintext if the signer omits encryption", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ path, token: "upload-token" })));
  const onChange = vi.fn();
  const { container } = render(<ApplicationPhotoField slot="idFront" label="Photo ID" attachment={null}
    onChange={onChange} getApplicationId={() => "PROPLANE-APP1"} />);
  fireEvent.change(container.querySelector('input[type="file"]')!, {
    target: { files: [new NodeFile([original], "identity.jpg", { type: "image/jpeg" })] },
  });
  await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
  expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  expect(mocks.upload).not.toHaveBeenCalled();
  expect(onChange).not.toHaveBeenCalled();
});
