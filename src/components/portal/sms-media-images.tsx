"use client";

import { useState, type MouseEvent as ReactMouseEvent } from "react";
import { FileText } from "lucide-react";
import type { ManagerSmsMessageMedia } from "@/lib/manager-sms-messages";
import { isNativeRuntimeSync } from "@/lib/native/detect-native";
import { downloadOrShareFile } from "@/lib/native/download-or-share";

/**
 * Inbound MMS attachments inside a text bubble. The serve route answers with an
 * attachment disposition (never inline), which `<img>` previews ignore. Inside
 * the Capacitor shell a tap on the anchor does nothing, so - exactly like the
 * inbox attachment chip - the tap is intercepted on `isNativeRuntimeSync()`
 * ONLY and the bytes are handed to the OS share sheet.
 */
function SmsMediaItem({ media }: { media: ManagerSmsMessageMedia }) {
  const [failed, setFailed] = useState(false);
  const isImage = media.contentType.startsWith("image/");
  const extension = media.path.split(".").pop() ?? "bin";
  const fileName = `attachment.${extension}`;

  const handleClick = (event: ReactMouseEvent<HTMLAnchorElement>) => {
    if (!isNativeRuntimeSync()) return;
    event.preventDefault();
    setFailed(false);
    void (async () => {
      try {
        const res = await fetch(media.url, { credentials: "include" });
        if (!res.ok) throw new Error(`Attachment fetch failed (${res.status})`);
        const blob = await res.blob();
        const result = await downloadOrShareFile({
          fileName,
          mimeType: blob.type || media.contentType,
          content: blob,
        });
        if (result === "downloaded") setFailed(true);
      } catch {
        setFailed(true);
      }
    })();
  };

  return (
    <span className="flex max-w-full flex-col gap-1">
      <a
        href={media.url}
        download={fileName}
        onClick={handleClick}
        className="block overflow-hidden rounded-lg border border-border/60"
        data-sms-media
      >
        {isImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={media.url} alt="Photo" loading="lazy" className="max-h-56 max-w-full object-cover" />
        ) : (
          <span className="inline-flex items-center gap-2 px-2.5 py-1.5 text-xs font-medium">
            <FileText className="h-4 w-4 shrink-0" aria-hidden />
            <span className="truncate">{fileName}</span>
          </span>
        )}
      </a>
      {failed ? <span className="text-[11px] font-medium text-rose-600">Couldn&apos;t open this attachment.</span> : null}
    </span>
  );
}

export function SmsMediaImages({ media }: { media: ManagerSmsMessageMedia[] | undefined }) {
  if (!media?.length) return null;
  return (
    <span className="mt-1 flex flex-wrap gap-1.5">
      {media.map((item) => (
        <SmsMediaItem key={item.path} media={item} />
      ))}
    </span>
  );
}
