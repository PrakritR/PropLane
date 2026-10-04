"use client";

import Link from "next/link";
import { useState } from "react";
import { CircleDollarSign, ListChecks } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  isLinkedFormOpen,
  linkedFormFacts,
  moreFormsHeading,
  type LinkedFormRequestView,
} from "@/lib/application-linked-form-requests";
import { linkedFormOpenPath, linkedFormSharePath } from "@/lib/linked-form-path";
import { mintLinkedFormShareUrl } from "@/lib/linked-form-requests-client";

/** What the list needs of a request. A just-submitted application also carries each form's one-time share token. */
export type LinkedFormListItem = Pick<
  LinkedFormRequestView,
  "id" | "formKind" | "formLabel" | "questionCount" | "feeCents" | "status"
> & { shareToken?: string };

/** Where "Fill out now" goes: the token link (it signs a guest in first) when we hold it, else the session page. */
export function fillOutNowHref(form: Pick<LinkedFormListItem, "id" | "formKind" | "shareToken">): string {
  if (form.formKind === "move_in") return "/resident/move-in";
  return form.shareToken ? linkedFormSharePath(form.shareToken) : linkedFormOpenPath(form.id);
}

function FormRow({ form, allowShare }: { form: LinkedFormListItem; allowShare: boolean }) {
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const canShare = allowShare && form.formKind === "application";
  const facts = linkedFormFacts(form);

  const reveal = async () => {
    if (shareUrl) {
      setShareUrl(null);
      return;
    }
    setError(null);
    if (form.shareToken) {
      setShareUrl(`${window.location.origin}${linkedFormSharePath(form.shareToken)}`);
      return;
    }
    setRevealing(true);
    const minted = await mintLinkedFormShareUrl(form.id);
    setRevealing(false);
    if (minted.ok) setShareUrl(minted.url);
    else setError(minted.error);
  };

  const copy = async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked: the link stays on screen to copy by hand.
    }
  };

  const share = async () => {
    if (!shareUrl || typeof navigator.share !== "function") return;
    try {
      await navigator.share({ title: form.formLabel, url: shareUrl });
    } catch {
      // The person closed the share sheet.
    }
  };

  return (
    <li className="rounded-2xl border border-border bg-card p-4 text-left" data-attr="linked-form-row">
      <p className="text-[15px] font-semibold text-foreground">{form.formLabel}</p>
      <ul className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-muted">
        {facts.map((fact, index) => (
          <li key={fact} className="inline-flex items-center gap-1.5">
            {index === 0 && form.questionCount ? (
              <ListChecks className="h-3.5 w-3.5" aria-hidden />
            ) : (
              <CircleDollarSign className="h-3.5 w-3.5" aria-hidden />
            )}
            {fact}
          </li>
        ))}
      </ul>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <Button asChild data-attr="linked-form-fill-now">
          <Link href={fillOutNowHref(form)}>Fill out now</Link>
        </Button>
        {canShare ? (
          <Button
            type="button"
            variant="outline"
            data-attr="linked-form-someone-else"
            aria-expanded={Boolean(shareUrl)}
            onClick={() => reveal()}
            disabled={revealing}
          >
            Someone else will fill it in
          </Button>
        ) : null}
      </div>
      {shareUrl ? (
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center" data-attr="linked-form-share">
          <code className="min-w-0 flex-1 truncate rounded-lg border border-border/60 bg-background/40 px-3 py-2 text-[11px] text-foreground">
            {shareUrl}
          </code>
          <Button type="button" variant="outline" className="shrink-0" data-attr="linked-form-copy-link" onClick={() => copy()}>
            {copied ? "Copied" : "Copy link"}
          </Button>
          {typeof navigator !== "undefined" && typeof navigator.share === "function" ? (
            <Button type="button" variant="outline" className="shrink-0" data-attr="linked-form-share-sheet" onClick={() => share()}>
              Share…
            </Button>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-[13px] text-danger">
          {error}
        </p>
      ) : null}
    </li>
  );
}

/** "N more forms to finish": every form still owed, one row each. Renders nothing when nothing is owed. */
export function LinkedFormsFinishList({
  forms,
  heading,
  allowShare = true,
  className,
}: {
  forms: readonly LinkedFormListItem[];
  /** Replaces the default "N more forms to finish" (the helper's portal says "Forms for <applicant>"). */
  heading?: string;
  /** A helper filling in someone else's form has no one further to pass it to. */
  allowShare?: boolean;
  className?: string;
}) {
  const open = forms.filter((form) => isLinkedFormOpen(form.status));
  if (open.length === 0) return null;
  return (
    <section className={className} data-attr="linked-forms-finish-list">
      <h3 className="text-left text-[15px] font-bold text-foreground">{heading ?? moreFormsHeading(open.length)}</h3>
      <ul className="mt-3 flex flex-col gap-3">
        {open.map((form) => (
          <FormRow key={form.id} form={form} allowShare={allowShare} />
        ))}
      </ul>
    </section>
  );
}
