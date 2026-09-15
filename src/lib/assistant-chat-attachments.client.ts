/**
 * Browser-only intake for assistant chat attachments. Images are downscaled;
 * PDFs are base64-encoded for the JSON chat routes. Spreadsheets are not chat
 * attachments — a manager imports properties from Properties → ＋ → Import
 * properties, which reads the file in the listing workspace.
 */

export type PendingChatAttachment = {
  id: string;
  kind: "image" | "document";
  fileName: string;
  mediaType?: string;
  dataBase64?: string;
  /** Object URL for image thumbnails — revoke when removed. */
  previewUrl?: string;
};

export const CHAT_ATTACHMENT_ACCEPT =
  "image/jpeg,image/png,image/webp,image/gif,application/pdf,.pdf,image/*";

export const MAX_CHAT_ATTACHMENTS = 4;

const CHAT_IMAGE_MAX_DIM = 1568;
const MAX_IMAGE_UPLOAD_BYTES = 15 * 1024 * 1024;
const MAX_PDF_BYTES = 4 * 1024 * 1024;

function randomId(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `att-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function rawImageFileToChatAttachment(
  file: File,
  mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif",
): Promise<PendingChatAttachment | null> {
  if (file.size > MAX_IMAGE_UPLOAD_BYTES) return null;
  try {
    const dataBase64 = await fileToBase64(file);
    if (!dataBase64) return null;
    const previewUrl =
      mediaType === "image/jpeg" || mediaType === "image/png" || mediaType === "image/webp" || mediaType === "image/gif"
        ? `data:${mediaType};base64,${dataBase64}`
        : undefined;
    return {
      id: randomId(),
      kind: "image",
      fileName: file.name || "image",
      mediaType,
      dataBase64,
      previewUrl,
    };
  } catch {
    return null;
  }
}

async function imageFileToChatAttachment(file: File): Promise<PendingChatAttachment | null> {
  const looksJpeg =
    file.type === "image/jpeg" ||
    file.type === "image/pjpeg" ||
    /\.jpe?g$/i.test(file.name);
  const looksPng = file.type === "image/png" || /\.png$/i.test(file.name);
  if (!file.type.startsWith("image/") && !looksJpeg && !looksPng && file.type !== "") return null;
  if (file.size > MAX_IMAGE_UPLOAD_BYTES) return null;
  try {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = reject;
      el.src = dataUrl;
    });
    if (!img.width || !img.height) return null;
    const scale = Math.min(1, CHAT_IMAGE_MAX_DIM / Math.max(img.width, img.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const jpegDataUrl = canvas.toDataURL("image/jpeg", 0.82);
    const comma = jpegDataUrl.indexOf(",");
    const dataBase64 = comma >= 0 ? jpegDataUrl.slice(comma + 1) : "";
    if (!dataBase64) return null;
    return {
      id: randomId(),
      kind: "image",
      fileName: file.name || "image.jpg",
      mediaType: "image/jpeg",
      dataBase64,
      previewUrl: jpegDataUrl,
    };
  } catch {
    if (looksJpeg) return rawImageFileToChatAttachment(file, "image/jpeg");
    if (looksPng) return rawImageFileToChatAttachment(file, "image/png");
    if (file.type === "image/webp" || /\.webp$/i.test(file.name)) {
      return rawImageFileToChatAttachment(file, "image/webp");
    }
    if (file.type === "image/gif" || /\.gif$/i.test(file.name)) {
      return rawImageFileToChatAttachment(file, "image/gif");
    }
    return null;
  }
}

async function pdfFileToChatAttachment(file: File): Promise<PendingChatAttachment | null> {
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  if (!isPdf || file.size > MAX_PDF_BYTES) return null;
  try {
    const dataBase64 = await fileToBase64(file);
    if (!dataBase64) return null;
    return {
      id: randomId(),
      kind: "document",
      fileName: file.name || "document.pdf",
      mediaType: "application/pdf",
      dataBase64,
    };
  } catch {
    return null;
  }
}

export async function prepareChatAttachment(file: File): Promise<PendingChatAttachment | null> {
  const name = file.name || "";
  const looksImage =
    file.type.startsWith("image/") ||
    file.type === "" ||
    /\.(jpe?g|png|webp|gif)$/i.test(name);
  if (looksImage) {
    const image = await imageFileToChatAttachment(file);
    if (image) return image;
  }
  if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) {
    return pdfFileToChatAttachment(file);
  }
  if (file.type.startsWith("image/")) return imageFileToChatAttachment(file);
  return null;
}

export async function prepareChatAttachmentsFromFiles(
  files: FileList | File[],
  existingCount: number,
): Promise<{ prepared: PendingChatAttachment[]; error: string | null }> {
  const list = Array.from(files);
  const room = MAX_CHAT_ATTACHMENTS - existingCount;
  if (room <= 0) {
    return { prepared: [], error: `You can attach up to ${MAX_CHAT_ATTACHMENTS} files per message.` };
  }
  const slice = list.slice(0, room);
  const prepared: PendingChatAttachment[] = [];
  let skipped = 0;
  for (const file of slice) {
    const att = await prepareChatAttachment(file);
    if (att) prepared.push(att);
    else skipped += 1;
  }
  let error: string | null = null;
  if (prepared.length === 0 && slice.length > 0) {
    error = "Use JPEG, PNG, WebP, GIF images (up to 15 MB) or PDFs (up to 4 MB).";
  } else if (skipped > 0) {
    error = "Some files could not be attached — check type and size limits.";
  } else if (list.length > room) {
    error = `Only ${room} more file${room === 1 ? "" : "s"} fit on this message.`;
  }
  return { prepared, error };
}

export function attachmentsToApiPayload(attachments: PendingChatAttachment[]) {
  return {
    images: attachments
      .filter((a) => a.kind === "image")
      .map((a) => ({ mediaType: a.mediaType ?? "", dataBase64: a.dataBase64 ?? "" })),
    documents: attachments
      .filter((a) => a.kind === "document")
      .map((a) => ({
        mediaType: a.mediaType ?? "",
        dataBase64: a.dataBase64 ?? "",
        fileName: a.fileName,
      })),
  };
}

export function revokeAttachmentPreview(attachment: PendingChatAttachment) {
  if (attachment.previewUrl?.startsWith("blob:")) {
    URL.revokeObjectURL(attachment.previewUrl);
  }
}

export function userMessageContentFromInput(text: string, attachments: PendingChatAttachment[]): string {
  const trimmed = text.trim();
  if (trimmed) return trimmed;
  if (attachments.length === 0) return "";
  return attachments.map((a) => `[Attached: ${a.fileName}]`).join("\n");
}
