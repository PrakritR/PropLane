import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { LeaseGenerateModal } from "../../../src/components/portal/lease-generate-modal";
import { LeaseHtmlDirectEditor } from "../../../src/components/portal/lease-html-direct-editor";
import { LeaseDocumentPreview } from "../../../src/components/portal/lease-document-preview";
import { ResidentLeaseBareDocumentPreview } from "../../../src/components/portal/resident-lease-document-preview";
import { LEASE, ROW, savedHtml } from "./fixture-data";

function Fixture() {
  const [open, setOpen] = useState(true);
  const [saved, setSaved] = useState(false);
  const [html, setHtml] = useState(LEASE);
  const [renderCount, setRenderCount] = useState(0);
  const standalone = new URLSearchParams(location.search).has("standalone");
  if (standalone)
    return (
      <main style={{ padding: 20 }}>
        <button
          onClick={() =>
            setHtml(LEASE.replace("Example Resident", "Updated Resident"))
          }
        >
          External document update
        </button>
        <button onClick={() => setRenderCount(renderCount + 1)}>
          Unrelated render {renderCount}
        </button>
        <div style={{ maxWidth: 900 }}>
          <LeaseHtmlDirectEditor
            html={html}
            baselineHtml={LEASE}
            onChange={(next) => setHtml(next)}
            showPersistBar={false}
          />
        </div>
        <output data-testid="current-html">{html}</output>
      </main>
    );
  return (
    <main>
      <button onClick={() => setOpen(true)}>Reopen lease</button>
      {saved ? (
        <>
          <h1>Saved lease review</h1>
          <LeaseDocumentPreview row={ROW as never} />
          <ResidentLeaseBareDocumentPreview leaseHtml={savedHtml} />
        </>
      ) : null}
      <LeaseGenerateModal
        open={open}
        row={ROW as never}
        managerUserId="fixture-manager"
        onClose={() => setOpen(false)}
        onGenerated={() => {
          setOpen(false);
          setSaved(true);
        }}
      />
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Fixture />
  </React.StrictMode>,
);
