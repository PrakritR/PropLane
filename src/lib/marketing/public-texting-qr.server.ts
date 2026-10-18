import "server-only";
import QRCode from "qrcode";
import { cache } from "react";
import { createTtlCache } from "@/lib/server-ttl-cache";

const qrSnapshot = createTtlCache<string>(60_000);

/** Encode the exact configured SMS destination, including its greeting, on the server. */
export const getPublicTextingQrDataUrl = cache(
  async (smsHref: string | null): Promise<string | null> => {
    if (!smsHref) return null;
    try {
      return await qrSnapshot.get(smsHref, () =>
        QRCode.toDataURL(smsHref, {
          width: 320,
          margin: 2,
          errorCorrectionLevel: "M",
          color: { dark: "#0C0D10", light: "#FFFFFF" },
        }),
      );
    } catch {
      return null;
    }
  },
);
