const MAX_IMG_BYTES = 10 * 1024 * 1024;
const MAX_VID_BYTES = 14 * 1024 * 1024;
const IMG_MAX_WIDTH = 1280;
const IMG_QUALITY = 0.75;
const TUS_CHUNK = 6 * 1024 * 1024;

function extToMime(ext: string): string {
  const map: Record<string, string> = {
    mp4: "video/mp4",
    mov: "video/quicktime",
    m4v: "video/x-m4v",
    webm: "video/webm",
    avi: "video/x-msvideo",
    mkv: "video/x-matroska",
    wmv: "video/x-ms-wmv",
    flv: "video/x-flv",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    gif: "image/gif",
    heic: "image/heic",
  };
  return map[ext] ?? "application/octet-stream";
}

async function fileToDataUrl(file: File, maxBytes: number): Promise<string | null> {
  if (file.size > maxBytes) return null;
  if (!file.type.startsWith("image/")) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    });
  }
  return new Promise((resolve) => {
    const img = new window.Image();
    const objectUrl = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      try {
        const scale = Math.min(1, IMG_MAX_WIDTH / img.width);
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          resolve(null);
          return;
        }
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", IMG_QUALITY));
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(null);
    };
    img.src = objectUrl;
  });
}

async function uploadViaTus(file: File, path: string, mime: string, token: string, supabaseUrl: string): Promise<void> {
  const b64 = (value: string) => btoa(unescape(encodeURIComponent(value)));
  const metadata = [
    `bucketName ${b64("listing-photos")}`,
    `objectName ${b64(path)}`,
    `contentType ${b64(mime)}`,
    // Filenames are timestamp+random and never overwritten, so the object is
    // immutable — cache for a year to avoid re-fetching media on every view.
    `cacheControl ${b64("31536000")}`,
  ].join(",");

  const createRes = await fetch(`${supabaseUrl}/storage/v1/upload/resumable`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Length": "0",
      "Upload-Length": String(file.size),
      "Upload-Metadata": metadata,
      "Tus-Resumable": "1.0.0",
      "x-upsert": "false",
    },
  });
  if (!createRes.ok) {
    const body = await createRes.text().catch(() => "");
    throw new Error(`TUS session failed (${createRes.status}): ${body}`);
  }

  const rawLoc = createRes.headers.get("Location");
  if (!rawLoc) throw new Error("TUS: no Location header in response");
  const location = rawLoc.startsWith("http") ? rawLoc : `${supabaseUrl}${rawLoc}`;

  let offset = 0;
  while (offset < file.size) {
    const end = Math.min(offset + TUS_CHUNK, file.size);
    const chunk = file.slice(offset, end);
    const patchRes = await fetch(location, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/offset+octet-stream",
        "Content-Length": String(end - offset),
        "Upload-Offset": String(offset),
        "Tus-Resumable": "1.0.0",
      },
      body: chunk,
    });
    if (!patchRes.ok) {
      const body = await patchRes.text().catch(() => "");
      throw new Error(`TUS chunk failed at offset ${offset} (${patchRes.status}): ${body}`);
    }
    offset = end;
  }
}

async function uploadToBucket(input: File | string): Promise<string> {
  const { createSupabaseBrowserClient } = await import("@/lib/supabase/browser");
  const db = createSupabaseBrowserClient();
  const {
    data: { session },
  } = await db.auth.getSession();
  if (!session) throw new Error("Not signed in.");

  let body: Blob;
  let mime: string;
  let ext: string;

  if (typeof input === "string") {
    body = await fetch(input).then((response) => response.blob());
    mime = body.type || "image/jpeg";
    ext = mime.split("/")[1]?.replace("jpeg", "jpg") ?? "jpg";
  } else {
    body = input;
    ext = input.name.split(".").pop()?.toLowerCase() ?? "mp4";
    mime = input.type || extToMime(ext);
  }

  const path = `${session.user.id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  if (input instanceof File && input.size >= 10 * 1024 * 1024) {
    const supabaseUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/$/, "");
    await uploadViaTus(input, path, mime, session.access_token, supabaseUrl);
    return db.storage.from("listing-photos").getPublicUrl(path).data.publicUrl;
  }

  const { error } = await db.storage.from("listing-photos").upload(path, body, {
    contentType: mime,
    cacheControl: "31536000", // immutable object (unique filename); cache 1 year
    upsert: false,
    duplex: "half",
  });
  if (error) {
    const message = error.message ?? "";
    if (message.includes("Payload too large") || message.includes("413") || message.includes("exceeded")) {
      throw new Error("File is too large. Try splitting the video into shorter clips.");
    }
    throw new Error(message || "Upload failed.");
  }
  return db.storage.from("listing-photos").getPublicUrl(path).data.publicUrl;
}

export async function uploadListingImageFiles(files: FileList | File[]): Promise<string[]> {
  const fileArray = Array.from(files);
  const uploaded: string[] = [];
  for (const file of fileArray) {
    if (!file.type.startsWith("image/")) throw new Error("Images only.");
    const dataUrl = await fileToDataUrl(file, MAX_IMG_BYTES);
    if (!dataUrl) {
      throw new Error(`Image too large (max ${Math.round(MAX_IMG_BYTES / 1024 / 1024)} MB): ${file.name}`);
    }
    uploaded.push(await uploadToBucket(dataUrl));
  }
  return uploaded;
}

export async function uploadListingVideoFile(file: File): Promise<string> {
  if (!file.type.startsWith("video/")) throw new Error("Please choose a video file.");
  if (file.size > MAX_VID_BYTES * 4) {
    throw new Error(`Video too large (max ${Math.round((MAX_VID_BYTES * 4) / 1024 / 1024)} MB): ${file.name}`);
  }
  return uploadToBucket(file);
}