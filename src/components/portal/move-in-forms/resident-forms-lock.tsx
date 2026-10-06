"use client";

/**
 * The lock a resident sees where an unsubmitted form holds something back (My home › Move-in details,
 * the lease's Sign step): one line that says why and one button to the form that unlocks it. No
 * subtext. The server enforces the same rule (`blocking.ts`); this is only its face.
 */
import Link from "next/link";
import { Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { residentFormHref } from "@/lib/resident-forms-routes";

export function ResidentFormsLock({
  basePath = "/resident",
  formId,
  dataAttr = "resident-forms-lock",
}: {
  basePath?: string;
  /** The form that unlocks it; absent sends them to the Forms list. */
  formId?: string | null;
  dataAttr?: string;
}) {
  return (
    <div
      role="status"
      className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-border bg-card/40 px-6 py-10 text-center"
      data-attr={dataAttr}
    >
      <span className="grid size-11 place-items-center rounded-full bg-accent text-muted" aria-hidden>
        <Lock className="size-5" strokeWidth={1.6} />
      </span>
      <p className="text-base font-semibold text-foreground">Finish your forms first</p>
      <Button asChild variant="primary" className="rounded-full px-6" data-attr={`${dataAttr}-open`}>
        <Link href={residentFormHref(basePath, formId)}>Open form</Link>
      </Button>
    </div>
  );
}
