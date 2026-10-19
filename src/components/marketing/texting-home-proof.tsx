"use client";
import { useState } from "react";
import { InboxComposer } from "@/components/portal/portal-inbox-ui";
import { DRAFT_REPLY } from "@/components/marketing/resident-lifecycle-script";
import { Button } from "@/components/ui/button";

/** The real inbox composer, with edits and sends held only in this sample. */
export default function TextingHomeProof() {
  const [draft, setDraft] = useState(DRAFT_REPLY);
  const [sent, setSent] = useState<string | null>(null);
  return (
    <div className="texting-draft" data-attr="home-draft-proof">
      <div className="texting-draft-heading">
        <strong>Jordan · Room 3</strong>
        <span>Sample draft</span>
      </div>
      <div className="texting-draft-request">Could I tour it Thursday?</div>
      {sent !== null ? (
        <div className="texting-draft-sent">
          <p role="status">{sent}</p>
          <span>Sent in demo</span>
          <Button
            variant="ghost"
            onClick={() => {
              setSent(null);
              setDraft(DRAFT_REPLY);
            }}
          >
            Try again
          </Button>
        </div>
      ) : (
        <InboxComposer
          value={draft}
          onChange={setDraft}
          onSubmit={() => setSent(draft.trim())}
          composerRows={3}
          dataAttr="home-demo-draft"
        />
      )}
    </div>
  );
}
