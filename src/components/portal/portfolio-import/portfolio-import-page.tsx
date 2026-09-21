"use client";

/**
 * Orchestrates Upload → Review → Create at `/portal/properties/import`. Each
 * step is a dumb view; this component owns the `PortfolioImportProposal` and
 * talks to the server through `src/lib/portfolio-import.client.ts`.
 *
 * `?fixture=1` (dev-only — gated on `NODE_ENV !== "production"`) skips the
 * network read and loads `tests/fixtures/portfolio-import/proposal.json`, so
 * Review and Create can be proven before the server route lands.
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { PortfolioImportUploadStep } from "@/components/portal/portfolio-import/upload-step";
import { PortfolioImportReviewStep } from "@/components/portal/portfolio-import/review-step";
import { PortfolioImportCreateStep } from "@/components/portal/portfolio-import/create-step";
import {
  createFromPortfolioImport,
  patchPortfolioImport,
  uploadPortfolioImport,
} from "@/lib/portfolio-import.client";
import type {
  ImportResidentProposal,
  PortfolioImportCreateResult,
  PortfolioImportProposal,
} from "@/lib/portfolio-import/types";

type Step = "upload" | "review" | "create";

export function PortfolioImportPageClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const useFixture = process.env.NODE_ENV !== "production" && searchParams.get("fixture") === "1";

  const [step, setStep] = useState<Step>("upload");
  const [proposal, setProposal] = useState<PortfolioImportProposal | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [patching, setPatching] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createResult, setCreateResult] = useState<PortfolioImportCreateResult | null>(null);

  // Dev-only: `?fixture=1` loads Review straight from a local fixture,
  // exactly like a completed upload would, so Review/Create can be driven
  // without the read route.
  useEffect(() => {
    if (!useFixture || proposal) return;
    let cancelled = false;
    void import("../../../../tests/fixtures/portfolio-import/proposal.json").then((mod) => {
      if (cancelled) return;
      setProposal(mod.default as unknown as PortfolioImportProposal);
      setStep("review");
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useFixture]);

  const handleUpload = useCallback(async (files: File[], hint: string) => {
    setUploading(true);
    setUploadError(null);
    const result = await uploadPortfolioImport(files, hint);
    setUploading(false);
    if (!result.ok) {
      setUploadError(result.error);
      return;
    }
    setProposal(result.proposal);
    setStep("review");
  }, []);

  const handleAnswer = useCallback(
    async (residentKey: string, patch: Partial<ImportResidentProposal>) => {
      if (!proposal) return;
      setPatching(true);
      const result = await patchPortfolioImport(proposal.importId, { answers: { [residentKey]: patch } });
      setPatching(false);
      if (result.ok) setProposal(result.proposal);
    },
    [proposal],
  );

  const currentSkipKeys = useCallback(
    (proposalValue: PortfolioImportProposal): string[] =>
      proposalValue.properties.flatMap((p) => p.residents.filter((r) => r.status === "skip").map((r) => r.key)),
    [],
  );

  const handleSkipToggle = useCallback(
    async (residentKey: string, included: boolean) => {
      if (!proposal) return;
      const existing = new Set(currentSkipKeys(proposal));
      if (included) existing.delete(residentKey);
      else existing.add(residentKey);
      setPatching(true);
      const result = await patchPortfolioImport(proposal.importId, { skips: Array.from(existing) });
      setPatching(false);
      if (result.ok) setProposal(result.proposal);
    },
    [proposal, currentSkipKeys],
  );

  const handleCreate = useCallback(
    async (sendInvites: boolean) => {
      if (!proposal) return;
      setCreating(true);
      const result = await createFromPortfolioImport(proposal.importId, { sendInvites });
      setCreating(false);
      if (result.ok) setCreateResult(result.result);
    },
    [proposal],
  );

  if (step === "upload" || !proposal) {
    return (
      <PortfolioImportUploadStep
        uploading={uploading}
        error={uploadError}
        onSubmit={handleUpload}
        onBack={() => router.push("/portal/properties")}
      />
    );
  }

  if (step === "review") {
    return (
      <PortfolioImportReviewStep
        proposal={proposal}
        saving={patching}
        onAnswer={handleAnswer}
        onSkipToggle={handleSkipToggle}
        onContinue={() => setStep("create")}
      />
    );
  }

  return (
    <PortfolioImportCreateStep
      proposal={proposal}
      result={createResult}
      creating={creating}
      onBack={() => setStep("review")}
      onCreate={handleCreate}
    />
  );
}
