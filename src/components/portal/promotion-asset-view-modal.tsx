"use client";

import { Button } from "@/components/ui/button";
import { Modal, ModalFooter } from "@/components/ui/modal";
import {
  PromotionFlyerAssetDetail,
  PromotionUploadAssetDetail,
} from "@/components/portal/promotion-asset-detail";
import { downloadPromotionFlyer } from "@/components/portal/promotion-flyer-preview";
import {
  PromotionTextPreview,
  copyPromotionTextToClipboard,
  downloadPromotionText,
} from "@/components/portal/promotion-text-preview";
import {
  promotionAssetKindIndices,
  promotionAssetListTitle,
  type PromotionAsset,
} from "@/lib/promotion-assets";
import { flyerRowForEntry } from "@/lib/promotion-flyer";

function viewTitle(asset: PromotionAsset, indexWithinKind: number): string {
  const stored =
    asset.kind === "flyer"
      ? (asset.flyerEntry?.title ?? "")
      : asset.kind === "upload"
        ? (asset.uploadEntry?.title ?? "")
        : (asset.textEntry?.title ?? "");
  const fallback = promotionAssetListTitle(asset, indexWithinKind);
  return stored.trim() || fallback;
}

function PromotionAssetViewFooter({
  asset,
  showToast,
}: {
  asset: PromotionAsset;
  showToast?: (message: string) => void;
}) {
  if (asset.kind === "flyer" && asset.flyerEntry) {
    return (
      <ModalFooter className="w-full">
        <Button
          type="button"
          variant="primary"
          className="ml-auto rounded-full"
          data-attr="promotion-flyer-download"
          onClick={() => {
            void downloadPromotionFlyer(flyerRowForEntry(asset.row, asset.flyerEntry!));
          }}
        >
          Download flyer
        </Button>
      </ModalFooter>
    );
  }

  if (asset.kind === "text" && asset.textEntry) {
    const copy = asset.textEntry.copy;
    const slug = (asset.textEntry.title?.trim() || "promotion-text")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return (
      <ModalFooter className="w-full">
        <Button
          type="button"
          variant="outline"
          className="rounded-full"
          data-attr="promotion-text-copy"
          onClick={() => {
            void copyPromotionTextToClipboard(copy).then((ok) => {
              if (ok) showToast?.("Copied to clipboard.");
            });
          }}
        >
          Copy text
        </Button>
        <Button
          type="button"
          variant="primary"
          className="ml-auto rounded-full"
          data-attr="promotion-text-download"
          onClick={() => {
            void downloadPromotionText(copy, `${slug || "promotion-text"}.txt`);
          }}
        >
          Download
        </Button>
      </ModalFooter>
    );
  }

  if (asset.kind === "upload" && asset.uploadEntry) {
    const entry = asset.uploadEntry;
    return (
      <ModalFooter className="w-full">
        <Button
          type="button"
          variant="primary"
          className="ml-auto rounded-full"
          data-attr="promotion-upload-download"
          onClick={() => {
            const a = document.createElement("a");
            a.href = entry.fileUrl;
            a.download = entry.fileName;
            a.rel = "noopener noreferrer";
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
          }}
        >
          Download
        </Button>
      </ModalFooter>
    );
  }

  return null;
}

export function PromotionAssetViewModal({
  asset,
  open,
  onClose,
  allAssets,
  dataAttr = "promotion-preview",
  showToast,
}: {
  asset: PromotionAsset | null;
  open: boolean;
  onClose: () => void;
  /** Used to resolve per-kind numbering in the title; pass the full list when available. */
  allAssets?: PromotionAsset[];
  dataAttr?: string;
  showToast?: (message: string) => void;
}) {
  const indices = promotionAssetKindIndices(allAssets ?? (asset ? [asset] : []));
  const indexWithinKind = asset ? indices.get(asset.id) ?? 0 : 0;
  const title = asset ? `View · ${viewTitle(asset, indexWithinKind)}` : "View";

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      presentation="dialog"
      dense
      panelClassName="flex max-h-[min(90vh,56rem)] w-full max-w-5xl flex-col"
      dataAttr={dataAttr}
      footer={open && asset ? <PromotionAssetViewFooter asset={asset} showToast={showToast} /> : undefined}
    >
      {open && asset ? (
        <div className="mx-auto min-h-0 w-full max-w-5xl flex-1 overflow-y-auto">
          {asset.kind === "flyer" ? (
            <PromotionFlyerAssetDetail asset={asset} />
          ) : asset.kind === "text" && asset.textEntry ? (
            <PromotionTextPreview copy={asset.textEntry.copy} variant="plain" />
          ) : asset.kind === "upload" ? (
            <PromotionUploadAssetDetail asset={asset} />
          ) : null}
        </div>
      ) : null}
    </Modal>
  );
}
