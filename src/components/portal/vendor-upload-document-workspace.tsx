"use client";

import { useMemo, useState } from "react";
import { AddWorkspace, type AddWorkspaceStep } from "@/components/portal/add-workspace";
import {
  PreviewPanel,
  WizardSection,
  WizardSelect,
  WIZARD_LABEL_CLASS,
} from "@/components/portal/add-workspace/parts";
import { Input } from "@/components/ui/input";
import { useAppUi } from "@/components/providers/app-ui-provider";
import {
  VENDOR_DOCUMENT_KINDS,
  VENDOR_DOCUMENT_LABELS,
  type VendorDocumentKind,
  type VendorDocumentRecord,
} from "@/lib/vendor-documents";

export function VendorUploadDocumentWorkspace({
  open,
  demo = false,
  onClose,
  onUploaded,
}: {
  open: boolean;
  demo?: boolean;
  onClose: () => void;
  onUploaded: (documents: VendorDocumentRecord[]) => void;
}) {
  const { showToast } = useAppUi();
  const [step, setStep] = useState(0);
  const [kind, setKind] = useState<VendorDocumentKind | "">("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  const steps = useMemo((): AddWorkspaceStep[] => {
    return [
      { id: "kind", label: "Type", incomplete: !kind },
      { id: "file", label: "File", incomplete: !file },
      { id: "review", label: "Review" },
    ];
  }, [file, kind]);

  const currentId = steps[step]?.id ?? "kind";

  function resetAndClose() {
    setStep(0);
    setKind("");
    setFile(null);
    onClose();
  }

  async function finish() {
    if (!kind || !file) return;
    setBusy(true);
    try {
      if (demo) {
        onUploaded([
          {
            kind,
            fileName: file.name,
            url: `/api/vendor/documents/signed-url?kind=${encodeURIComponent(kind)}`,
            uploadedAt: new Date().toISOString(),
          },
        ]);
        showToast(`${VENDOR_DOCUMENT_LABELS[kind]} saved (demo).`);
        resetAndClose();
        return;
      }
      const body = new FormData();
      body.set("kind", kind);
      body.set("file", file);
      const res = await fetch("/api/vendor/documents/upload", { method: "POST", credentials: "include", body });
      const data = (await res.json()) as { documents?: VendorDocumentRecord[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Upload failed.");
      onUploaded(data.documents ?? []);
      showToast(`${VENDOR_DOCUMENT_LABELS[kind]} uploaded.`);
      resetAndClose();
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  return (
    <AddWorkspace
      title="Upload document"
      steps={steps}
      current={step}
      onJump={setStep}
      onClose={resetAndClose}
      dirty={Boolean(kind || file)}
      discardTitle="Discard this?"
      discardBody="Nothing has been saved yet. Close and lose the file?"
      lastLabel="Upload"
      lastDisabled={!kind || !file}
      nextDisabled={(currentId === "kind" && !kind) || (currentId === "file" && !file)}
      busy={busy}
      onFinish={() => void finish()}
      dataAttrPrefix="vendor-upload-document"
      assistantContext="Upload a vendor compliance document."
      assistantScopeKey="vendor-upload-document"
      sidePanel={
        <PreviewPanel
          title="Document"
          name={kind ? VENDOR_DOCUMENT_LABELS[kind] : "No type yet"}
          sub={file?.name ?? "Pick a PDF"}
          facts={[
            { label: "Type", value: kind ? VENDOR_DOCUMENT_LABELS[kind] : "Not set", warn: !kind },
            { label: "File", value: file?.name ?? "Not set", warn: !file },
          ]}
          creates={[{ tone: kind && file ? "yes" : "warn", text: "A compliance file managers can review" }]}
        />
      }
    >
      {currentId === "kind" ? (
        <WizardSection title="Type">
          <WizardSelect
            label="Document"
            value={kind}
            onChange={(value) => setKind(value as VendorDocumentKind)}
            options={VENDOR_DOCUMENT_KINDS.map((id) => ({ value: id, label: VENDOR_DOCUMENT_LABELS[id] }))}
            dataAttr="vendor-upload-document-kind"
          />
        </WizardSection>
      ) : null}
      {currentId === "file" ? (
        <WizardSection title="File">
          <label className={WIZARD_LABEL_CLASS} htmlFor="vendor-upload-document-file">
            PDF
          </label>
          <Input
            id="vendor-upload-document-file"
            type="file"
            accept="application/pdf"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            data-attr="vendor-upload-document-file"
          />
        </WizardSection>
      ) : null}
      {currentId === "review" ? (
        <WizardSection title="Review">
          <p className="text-sm font-semibold text-foreground">{kind ? VENDOR_DOCUMENT_LABELS[kind] : "No type"}</p>
          <p className="mt-1 text-sm font-semibold text-foreground">{file?.name ?? "No file"}</p>
        </WizardSection>
      ) : null}
    </AddWorkspace>
  );
}
