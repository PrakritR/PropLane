"use client";

import { useCallback } from "react";

export type CapturedPhoto = {
  /** Object URL suitable for an <img> preview. */
  previewUrl: string;
  /** The captured image as a File, ready to upload to Supabase Storage / an API. */
  file: File;
};

/** Explicit picker on web; maps to CameraSource on native. */
export type PhotoCaptureSource = "files" | "camera";

/**
 * Returns `capture()`, which opens the native camera/photo picker inside the
 * app and falls back to a normal file input on the web. Wire it into document
 * and property-condition photo uploads.
 *
 * This also gives the native app a real device capability (camera), which
 * helps satisfy App Store review guideline 4.2 (a webview wrapper alone can be
 * rejected; genuine native features clear that bar).
 */
export function useNativeCamera() {
  const capture = useCallback(async (source?: PhotoCaptureSource): Promise<CapturedPhoto | null> => {
    const { Capacitor } = await import("@capacitor/core");

    if (!Capacitor.isNativePlatform()) {
      return pickFromWeb(source ?? "camera");
    }

    const { Camera, CameraResultType, CameraSource } = await import("@capacitor/camera");
    const cameraSource = source === "files" ? CameraSource.Photos
      : source === "camera" ? CameraSource.Camera
        : CameraSource.Prompt;
    const photo = await Camera.getPhoto({
      quality: 80,
      allowEditing: false,
      resultType: CameraResultType.Uri,
      source: cameraSource,
    });
    if (!photo.webPath) return null;

    const blob = await (await fetch(photo.webPath)).blob();
    const ext = (photo.format || "jpeg").replace("jpg", "jpeg");
    const file = new File([blob], `photo-${Date.now()}.${ext}`, {
      type: blob.type || `image/${ext}`,
    });
    // Preview from a locally-minted object URL (like the web path below) rather
    // than the platform-provided webPath string, so the value rendered into
    // <img src> is one we created from our own blob, never external DOM text.
    return { previewUrl: URL.createObjectURL(file), file };
  }, []);

  return { capture };
}

function pickFromWeb(source: PhotoCaptureSource): Promise<CapturedPhoto | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    if (source === "camera") input.capture = "environment";
    input.oncancel = () => resolve(null);
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      resolve({ previewUrl: URL.createObjectURL(file), file });
    };
    input.click();
  });
}
